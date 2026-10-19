import fs from 'node:fs';
import { paths, ensureHome } from '../shared/paths';
import { parseCommand, parseOptions, wrapper } from '../shared/server-command';

export type ClientKind = 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'windsurf';
const LABELS: Record<ClientKind, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini CLI', windsurf: 'Windsurf' };
export const clientLabel = (c: ClientKind) => LABELS[c] ?? c;

export type Status =
  | 'unwrap'      // wrapped by a Habitab 0.2 launcher; the wrapper is removed (the global config takes over)
  | 'ok'          // starts its browser in Habitab through the global config
  | 'conflict'    // names its own browser (--browserUrl, --autoConnect, --channel): executablePath would stop it
  | 'unsupported'; // found, but Habitab cannot change this definition

export interface Finding {
  id: string;
  client: ClientKind;
  /** user, local, project, profile, plugin, managed */
  scope: string;
  file: string;
  project?: string;
  name: string;
  command: string;
  args: string[];
  status: Status;
  detail: string;
  proposedCommand?: string;
  proposedArgs?: string[];
  /** Claude .mcp.json entry: the change is a local override with the same name. */
  shadow?: boolean;
  /** Claude: original entry object. */
  entry?: Record<string, unknown>;
  /** The entry's environment, when the client configuration has one. */
  env?: Record<string, unknown>;
}

export const isActionable = (f: Finding) => f.status === 'unwrap';

export function location(f: Finding): string {
  switch (f.scope) {
    case 'user': return `User (${f.file})`;
    case 'local': return `Local for ${f.project}`;
    case 'project': return `Project ${f.project ?? f.file}`;
    case 'profile': return `Profile ${f.file}`;
    default: return `${f.scope}: ${f.file}`;
  }
}

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const commandLine = (c: string, a: string[]) => [c, ...a].map(shellQuote).join(' ');

export const findingId = (client: ClientKind, scope: string, file: string, project: string | undefined, name: string) =>
  `${client}|${scope}|${project ?? ''}|${file}|${name}`;

/** Sets the environment variable that keeps a server away from the global config. */
export const NO_CONFIG_DISCOVERY = 'CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY';

/**
 * Decides what Habitab does with one server definition. Nothing needs to be
 * written into client configurations any more: the server's global config
 * (`habitab cd4a`) gives every chrome-devtools-mcp its browser in Habitab.
 * Entries wrapped by the 0.2 launcher get their original command back.
 */
export function classify(base: Omit<Finding, 'id' | 'status' | 'detail'>): Finding | undefined {
  const f: Finding = { ...base, id: findingId(base.client, base.scope, base.file, base.project, base.name), status: 'ok', detail: '' };
  const inner = wrapper.unwrap(f.command, f.args);
  if (inner) {
    f.status = 'unwrap';
    f.detail = 'Wrapped by the launcher of Habitab 0.2. The original command comes back; the browser then comes from the global config.';
    [f.proposedCommand, f.proposedArgs] = inner;
    return f;
  }
  const parsed = parseCommand(f.command, f.args);
  if (!parsed) return undefined;
  if (f.env?.[NO_CONFIG_DISCOVERY]) {
    f.detail = `Keeps its own browser: ${NO_CONFIG_DISCOVERY} in its env keeps it out of the global config.`;
    return f;
  }
  if (parsed.mode === 'external' || parsed.launch.ignored.includes('--channel')) {
    f.status = 'conflict';
    const why = parsed.mode === 'external' ? parsed.reasons.join(', ') : '--channel';
    f.detail = `Names its own browser (${why}), which cannot be combined with the global config's executablePath: the server would refuse to start. ` +
      `Keep it out of the global config with ${NO_CONFIG_DISCOVERY}=1 in its env, or drop ${why} to use Habitab.`;
    return f;
  }
  const notes: string[] = ['Starts its browser in Habitab (global config of chrome-devtools-mcp).'];
  const keys = parseOptions(parsed.serverArgs).map(o => o.key);
  if (keys.includes('isolated') || keys.includes('headless')) notes.push('--isolated and --headless have no effect: every Habitab session is isolated and visible.');
  if (parsed.mode === 'persistentProfile') notes.push('--userDataDir has no effect; Habitab keeps a profile per project when you turn it on.');
  if (parsed.launch.ignored.length) notes.push(`${parsed.launch.ignored.join(', ')}: no effect, because Habitab uses its built-in Chromium.`);
  if (parsed.launch.proxyServer) notes.push('--proxyServer applies to the session.');
  f.detail = notes.join(' ');
  return f;
}

/** Record of a change the 0.2 launcher setup made; enables exact restoration. */
export interface ManifestEntry {
  findingId: string;
  client: ClientKind;
  scope: string;
  file: string;
  project?: string;
  name: string;
  shadow: boolean;
  originalCommand: string;
  originalArgs: string[];
  originalEntry?: Record<string, unknown>;
  /** JSON clients: the command (and args) values as Habitab wrote them. */
  wrappedEntry?: Record<string, unknown>;
  originalCommandRaw?: string;
  originalArgsRaw?: string | null;
  wrappedCommandRaw?: string;
  wrappedArgsRaw?: string;
  backup?: string;
  appliedAt: string;
}

export const manifest = {
  load(): ManifestEntry[] {
    try { return JSON.parse(fs.readFileSync(paths.manifest, 'utf8')).entries ?? []; } catch { return []; }
  },
  append(entry: ManifestEntry): void {
    ensureHome();
    const entries = [...this.load(), entry];
    fs.writeFileSync(paths.manifest, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
  },
  latest(id: string): ManifestEntry | undefined {
    return this.load().filter(e => e.findingId === id).pop();
  },
};

export interface ChangeResult { finding: Finding; ok: boolean; message: string; }
