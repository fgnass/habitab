// Claude Code: user and local scope in ~/.claude.json ($CLAUDE_CONFIG_DIR/.claude.json),
// project scope in <project>/.mcp.json, plugins and managed config (read only).
// Changes go through the official CLI (claude mcp add-json/remove), because
// running sessions also write ~/.claude.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeConfigDir } from '../shared/session-info';
import { wrapper } from '../shared/server-command';
import { classify, Finding, findingId, manifest, ManifestEntry } from './model';

export const claudeConfigFile = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');

/** Projects Claude Code has been used in (keys of `projects` in ~/.claude.json). */
export function claudeProjects(): string[] {
  return Object.keys(readJson(claudeConfigFile())?.projects ?? {});
}

const MANAGED = '/Library/Application Support/ClaudeCode/managed-mcp.json';

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

export function scanClaude(): Finding[] {
  const findings: Finding[] = [];
  const file = claudeConfigFile();
  const root = readJson(file) ?? {};
  const add = (servers: any, scope: string, f: string, project?: string, readOnly?: string, shadow = false) => {
    if (!servers || typeof servers !== 'object') return;
    for (const name of Object.keys(servers).sort()) {
      const entry = servers[name];
      if (!entry || typeof entry.command !== 'string') continue;
      const found = classify({ client: 'claude', scope, file: f, project, name, command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], entry, shadow });
      if (!found) continue;
      if (readOnly && found.status !== 'external') {
        found.status = 'unsupported';
        found.detail = readOnly;
        delete found.proposedCommand; delete found.proposedArgs;
      }
      findings.push(found);
    }
  };
  add(root.mcpServers, 'user', file);
  const projects = Object.keys(root.projects ?? {}).sort();
  for (const p of projects) add(root.projects[p]?.mcpServers, 'local', file, p);
  const local = new Set(findings.filter(f => f.scope === 'local').map(f => `${f.project}|${f.name}`));
  for (const p of projects) {
    const mcp = readJson(path.join(p, '.mcp.json'));
    const servers = Object.fromEntries(Object.entries(mcp?.mcpServers ?? {}).filter(([n]) => !local.has(`${p}|${n}`)));
    add(servers, 'project', path.join(p, '.mcp.json'), p, undefined, true);
  }
  for (const [plugin, f] of pluginFiles()) {
    const json = readJson(f);
    add(json?.mcpServers ?? json, 'plugin', f, undefined,
      `Plugin "${plugin}": plugin files are replaced on updates. Disable the plugin server; Habitab can then add a user entry.`);
  }
  const managed = readJson(MANAGED);
  if (managed) add(managed.mcpServers, 'managed', MANAGED, undefined, 'Managed configuration (administrator). Habitab does not change it.');
  return findings;
}

function pluginFiles(): [string, string][] {
  const installed = readJson(path.join(claudeConfigDir(), 'plugins', 'installed_plugins.json'));
  const result: [string, string][] = [];
  for (const [name, installs] of Object.entries<any>(installed?.plugins ?? {})) {
    for (const install of installs ?? []) {
      const dir = install?.installPath;
      if (typeof dir !== 'string') continue;
      if (fs.existsSync(path.join(dir, '.mcp.json'))) result.push([name, path.join(dir, '.mcp.json')]);
      const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
      if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') result.push([name, path.join(dir, '.claude-plugin', 'plugin.json')]);
    }
  }
  return result;
}

export function claudeCli(): string | undefined {
  if (process.env.HABITAB_CLAUDE_CLI) return process.env.HABITAB_CLAUDE_CLI;
  const home = os.homedir();
  const candidates = [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  const found = candidates.find(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; } });
  if (found) return found;
  try {
    const out = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim().split('\n').pop();
    return out?.startsWith('/') ? out : undefined;
  } catch { return undefined; }
}

function cli(args: string[], cwd?: string): void {
  const bin = claudeCli();
  if (!bin) throw new Error('Claude Code CLI not found');
  const extra = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  try {
    execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(':') } });
  } catch (e: any) {
    throw new Error(`claude ${args.slice(0, 3).join(' ')}: ${(e.stderr || e.stdout || e.message).toString().trim()}`);
  }
}

const target = (f: Finding) => (f.scope === 'user' ? { scope: 'user', cwd: undefined } : { scope: 'local', cwd: f.project });

function write(f: Finding, entry: Record<string, unknown>, removeFirst: boolean): void {
  const { scope, cwd } = target(f);
  if (removeFirst) cli(['mcp', 'remove', f.name, '-s', scope], cwd);
  cli(['mcp', 'add-json', f.name, JSON.stringify(entry), '-s', scope], cwd);
}

function current(f: Finding): any {
  const root = readJson(claudeConfigFile()) ?? {};
  const servers = f.scope === 'user' ? root.mcpServers : root.projects?.[f.project ?? '']?.mcpServers;
  return servers?.[f.name];
}

function verify(f: Finding, command: string): void {
  if (current(f)?.command !== command) throw new Error(`Change to ${f.name} did not arrive in ${claudeConfigFile()}`);
}

export function applyClaude(f: Finding, backup?: string): ManifestEntry {
  if (!f.entry || !f.proposedCommand || !f.proposedArgs) throw new Error(`No proposal for ${f.name}`);
  const original = f.entry;
  const entry = { ...original, type: original.type ?? 'stdio', command: f.proposedCommand, args: f.proposedArgs };
  try {
    write(f, entry, !f.shadow);
  } catch (e) {
    // If remove worked but add failed, put the original back.
    if (!f.shadow) try { write(f, original, false); } catch {}
    throw e;
  }
  const resultScope = f.shadow ? 'local' : f.scope;
  const resultFinding = { ...f, scope: resultScope, file: claudeConfigFile() };
  verify(resultFinding, f.proposedCommand);
  // A path update keeps the original recorded at the first installation.
  const prior = f.status === 'updatePath' ? manifest.latest(f.id) : undefined;
  const inner = f.status === 'updatePath' ? wrapper.unwrap(f.command, f.args) : undefined;
  return {
    findingId: f.shadow ? findingId('claude', 'local', claudeConfigFile(), f.project, f.name) : f.id,
    client: 'claude', scope: f.scope, file: f.file, project: f.project, name: f.name, shadow: !!f.shadow,
    originalCommand: prior?.originalCommand ?? inner?.[0] ?? f.command,
    originalArgs: prior?.originalArgs ?? inner?.[1] ?? f.args,
    originalEntry: prior ? prior.originalEntry : inner ? undefined : original,
    backup, appliedAt: new Date().toISOString(),
  };
}

/**
 * Exact original when the entry is still what Habitab wrote; otherwise only
 * command/args are unwrapped, so later changes (env, other fields) stay.
 */
export function restoreClaude(f: Finding, m: ManifestEntry | undefined, inner: [string, string[]]): string {
  if (m?.shadow && f.scope === 'local') {
    cli(['mcp', 'remove', f.name, '-s', 'local'], f.project);
    return 'Local override removed; .mcp.json applies again';
  }
  const now: Record<string, unknown> = { ...(f.entry ?? {}) };
  let entry: Record<string, unknown> = { ...now, command: inner[0], args: inner[1] };
  let exact = false;
  if (m?.originalEntry) {
    const expected: Record<string, unknown> = { ...m.originalEntry, type: m.originalEntry.type ?? 'stdio', command: f.command, args: f.args };
    // The CLI drops fields it does not know; every stored field must match.
    if (Object.entries(now).every(([k, v]) => JSON.stringify(expected[k]) === JSON.stringify(v))) {
      entry = m.originalEntry;
      exact = true;
    }
  }
  write(f, entry, true);
  verify(f, entry.command as string);
  return exact ? 'Original restored' : 'Unwrapped; later changes kept';
}
