// Clients that keep MCP servers in JSON or JSONC files: OpenCode, Cursor,
// Gemini CLI, Windsurf. Paths and keys follow the agent table of add-mcp
// (https://github.com/neon-solutions/add-mcp). Edits go through jsonc-parser:
// only the command (and args) values change; comments, formatting and all
// other keys stay as they are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as jsonc from 'jsonc-parser';
import { wrapper } from '../shared/server-command';
import { classify, ClientKind, Finding, findingId, manifest, ManifestEntry } from './model';

interface JsonClient {
  kind: ClientKind;
  /** User-level config files; every existing one is read. */
  global: (home: string) => string[];
  /** Project-level config files, relative to a project root. */
  project?: string[];
  /** Key of the server map. */
  key: string;
  /** OpenCode: `command` is one array with the arguments. Others: `command` + `args`. */
  commandArray?: boolean;
}

export const JSON_CLIENTS: JsonClient[] = [
  {
    kind: 'opencode', key: 'mcp', commandArray: true,
    global: h => [path.join(h, '.config', 'opencode', 'opencode.jsonc'), path.join(h, '.config', 'opencode', 'opencode.json')],
    project: ['opencode.jsonc', 'opencode.json', path.join('.opencode', 'opencode.jsonc'), path.join('.opencode', 'opencode.json')],
  },
  { kind: 'cursor', key: 'mcpServers', global: h => [path.join(h, '.cursor', 'mcp.json')], project: [path.join('.cursor', 'mcp.json')] },
  { kind: 'gemini', key: 'mcpServers', global: h => [path.join(h, '.gemini', 'settings.json')], project: [path.join('.gemini', 'settings.json')] },
  { kind: 'windsurf', key: 'mcpServers', global: h => [path.join(h, '.codeium', 'windsurf', 'mcp_config.json')] },
];

const clientOf = (kind: ClientKind) => JSON_CLIENTS.find(c => c.kind === kind)!;
const PARSE = { allowTrailingComma: true, disallowComments: false };

/** command/args of an entry, or undefined when it is not a local command. */
function commandOf(c: JsonClient, entry: any): [string, string[]] | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (c.commandArray) {
    if ((entry.type ?? 'local') !== 'local' || !strings(entry.command) || !entry.command.length) return undefined;
    return [entry.command[0], entry.command.slice(1)];
  }
  if (typeof entry.command !== 'string' || (entry.args !== undefined && !strings(entry.args))) return undefined;
  return [entry.command, entry.args ?? []];
}

/** Keys Habitab changes in an entry. */
const keysOf = (c: JsonClient) => (c.commandArray ? ['command'] : ['command', 'args']);

/** A value as one line, like `["npx", "-y", "chrome-devtools-mcp@latest"]`. */
const inline = (v: unknown) => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));

/** New raw values (source text) for command/args. */
function rawFor(c: JsonClient, command: string, args: string[]): Record<string, string> {
  return c.commandArray ? { command: inline([command, ...args]) } : { command: inline(command), args: inline(args) };
}

interface ConfigFile { client: JsonClient; scope: 'user' | 'project'; file: string; project?: string; recorded?: boolean; }

function configFiles(projects: string[]): ConfigFile[] {
  const files: ConfigFile[] = [];
  for (const client of JSON_CLIENTS) {
    for (const file of client.global(os.homedir())) if (fs.existsSync(file)) files.push({ client, scope: 'user', file });
    for (const project of projects) {
      for (const rel of client.project ?? []) {
        const file = path.join(project, rel);
        if (fs.existsSync(file)) files.push({ client, scope: 'project', file, project });
      }
    }
  }
  // Files changed earlier are always checked, also when their project is no longer known.
  for (const m of manifest.load()) {
    const client = JSON_CLIENTS.find(c => c.kind === m.client);
    if (client && fs.existsSync(m.file)) files.push({ client, scope: m.scope as ConfigFile['scope'], file: m.file, project: m.project, recorded: true });
  }
  const seen = new Set<string>();
  return files.filter(f => {
    let real = f.file;
    try { real = fs.realpathSync(f.file); } catch {}
    const key = `${f.client.kind}|${real}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function load(file: string): { text: string; root: any; errors: jsonc.ParseError[] } {
  const text = fs.readFileSync(file, 'utf8');
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parse(text, errors, PARSE);
  return { text, root, errors };
}

export function scanJsonClients(projects: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const { client, scope, file, project, recorded } of configFiles(projects)) {
    let doc: ReturnType<typeof load>;
    try { doc = load(file); } catch { continue; }
    if (doc.errors.length) {
      if (doc.text.includes('chrome-devtools-mcp')) {
        findings.push({ id: findingId(client.kind, scope, file, project, '?'), client: client.kind, scope, file, project, name: '?', command: '', args: [], status: 'unsupported',
          detail: `File not readable: ${jsonc.printParseErrorCode(doc.errors[0].error)} at offset ${doc.errors[0].offset}.` });
      }
      continue;
    }
    const servers = doc.root?.[client.key];
    if (!servers || typeof servers !== 'object') continue;
    for (const name of Object.keys(servers).sort()) {
      const cmd = commandOf(client, servers[name]);
      if (!cmd) continue;
      const f = classify({ client: client.kind, scope, file, project, name, command: cmd[0], args: cmd[1] });
      if (!f) continue;
      // Files known only from the manifest: only their wrapped entries matter.
      if (recorded && f.status !== 'unwrap') continue;
      findings.push(f);
    }
  }
  return findings;
}

/** Indentation of the file, so an inserted key (args) looks like the rest. */
function formatting(text: string): jsonc.FormattingOptions {
  const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
  return { insertSpaces: !indent.startsWith('\t'), tabSize: indent.startsWith('\t') ? 1 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** Source text of command/args in the entry; a missing key is absent. */
function rawValues(text: string, c: JsonClient, name: string): Record<string, string> {
  const tree = jsonc.parseTree(text, [], PARSE);
  const out: Record<string, string> = {};
  for (const key of keysOf(c)) {
    const node = tree && jsonc.findNodeAtLocation(tree, [c.key, name, key]);
    if (node) out[key] = text.slice(node.offset, node.offset + node.length);
  }
  return out;
}

/**
 * Sets command/args to the given source text. An existing value is replaced
 * in place, so everything around it stays byte for byte; a key that is new
 * or goes away is inserted or removed by jsonc-parser.
 */
function setRaw(text: string, c: JsonClient, name: string, raw: Record<string, string>): string {
  let out = text;
  for (const key of keysOf(c)) {
    const tree = jsonc.parseTree(out, [], PARSE);
    const node = tree && jsonc.findNodeAtLocation(tree, [c.key, name, key]);
    if (node && raw[key] !== undefined) out = out.slice(0, node.offset) + raw[key] + out.slice(node.offset + node.length);
    else if (node || raw[key] !== undefined) {
      const value = raw[key] === undefined ? undefined : JSON.parse(raw[key]);
      out = jsonc.applyEdits(out, jsonc.modify(out, [c.key, name, key], value, { formattingOptions: formatting(out) }));
    }
  }
  return out;
}

function writeAtomic(file: string, text: string): void {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.habitab-tmp`);
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

const parsed = (raw: Record<string, string>) => JSON.stringify(Object.entries(raw).map(([k, v]) => [k, JSON.parse(v)]));

/**
 * Writes the change and checks that the file now has these values. Returns
 * their source text as written (an inserted key is formatted by jsonc-parser).
 */
function change(file: string, c: JsonClient, name: string, raw: Record<string, string>): Record<string, string> {
  const { text } = load(file);
  const updated = setRaw(text, c, name, raw);
  const errors: jsonc.ParseError[] = [];
  jsonc.parse(updated, errors, PARSE);
  const written = rawValues(updated, c, name);
  if (errors.length || parsed(written) !== parsed(raw)) throw new Error('Check after editing failed; file not written');
  writeAtomic(file, updated);
  return written;
}

/**
 * Exact original when command/args are still what Habitab wrote; otherwise
 * only unwrapped, so later changes stay.
 */
export function restoreJson(f: Finding, m: ManifestEntry | undefined): string {
  const c = clientOf(f.client);
  const { text, root } = load(f.file);
  const now = commandOf(c, root?.[c.key]?.[f.name]);
  const inner = now && wrapper.unwrap(now[0], now[1]);
  if (!inner) throw new Error(`${f.name} is not a Habitab entry`);
  const exact = !!m?.originalEntry && !!m.wrappedEntry && JSON.stringify(rawValues(text, c, f.name)) === JSON.stringify(m.wrappedEntry);
  change(f.file, c, f.name, exact ? m!.originalEntry as Record<string, string> : rawFor(c, inner[0], inner[1]));
  return exact ? 'Original restored' : 'Unwrapped; later changes kept';
}
