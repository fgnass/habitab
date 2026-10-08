import fs from 'node:fs';
import { paths, ensureHome } from '../shared/paths';
import { parseCommand, parseOptions, wrapper } from '../shared/server-command';

export type ClientKind = 'claude' | 'codex' | 'opencode' | 'cursor' | 'gemini' | 'windsurf';
const LABELS: Record<ClientKind, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini CLI', windsurf: 'Windsurf' };
export const clientLabel = (c: ClientKind) => LABELS[c] ?? c;

export type Status =
  | 'migrate'            // can be wrapped; this is the proposed change
  | 'updatePath'         // wrapped, launcher path outdated
  | 'migrated'           // wrapped, nothing to do
  | 'external'           // connects to a browser someone else runs; never taken over
  | 'persistentProfile'  // fixed profile directory; not taken over
  | 'unsupported';       // found, but Habitab cannot change this definition

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
}

export const isActionable = (f: Finding) => f.status === 'migrate' || f.status === 'updatePath';

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

/** Decides what Habitab does with one server definition. */
export function classify(base: Omit<Finding, 'id' | 'status' | 'detail'>, launcher = paths.launcher): Finding | undefined {
  const f: Finding = { ...base, id: findingId(base.client, base.scope, base.file, base.project, base.name), status: 'migrate', detail: '' };
  const inner = wrapper.unwrap(f.command, f.args);
  if (inner) {
    if (f.command === launcher) {
      f.status = 'migrated';
      f.detail = 'Runs through Habitab.';
    } else {
      f.status = 'updatePath';
      f.detail = `Runs through a Habitab launcher at a different location (${f.command}). The path will be updated.`;
      [f.proposedCommand, f.proposedArgs] = wrapper.wrap(inner[0], inner[1], launcher);
    }
    return f;
  }
  const parsed = parseCommand(f.command, f.args);
  if (!parsed) return undefined;
  if (parsed.mode === 'external') {
    f.status = 'external';
    f.detail = `Connects to an externally managed browser (${parsed.reasons.join(', ')}). Habitab does not take over this entry.`;
    return f;
  }
  if (parsed.mode === 'persistentProfile') {
    f.status = 'persistentProfile';
    f.detail = 'Uses a persistent profile (--userDataDir). Habitab sessions start without saved logins. Not taken over.';
    return f;
  }
  const notes: string[] = ['The browser shows up as a session in Habitab instead of a separate Chrome window.'];
  const keys = parseOptions(parsed.serverArgs).map(o => o.key);
  if (keys.includes('isolated')) notes.push('--isolated is dropped: every Habitab session is isolated anyway.');
  if (keys.includes('headless')) notes.push('--headless is dropped.');
  if (parsed.launch.ignored.length) notes.push(`${parsed.launch.ignored.join(', ')}: no effect, because Habitab uses its built-in Chromium.`);
  if (parsed.launch.proxyServer) notes.push('--proxyServer applies to the session.');
  if (parsed.launch.viewport) notes.push('--viewport sets the page size.');
  notes.push('All other arguments and environment variables stay unchanged.');
  f.detail = notes.join(' ');
  [f.proposedCommand, f.proposedArgs] = wrapper.wrap(f.command, f.args, launcher);
  return f;
}

/** Record of an applied change; enables exact restoration. */
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
