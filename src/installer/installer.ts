import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, log, paths } from '../shared/paths';
import { launcherScript, processList } from '../shared/platform';
import { analyze, isServerToken, wrapper } from '../shared/server-command';
import { applyClaude, claudeConfigFile, claudeProjects, restoreClaude, scanClaude } from './claude';
import { applyCodex, codexTrustedProjects, restoreCodex, scanCodex } from './codex';
import { applyJson, restoreJson, scanJsonClients } from './json-clients';
import { ChangeResult, ClientKind, Finding, isActionable, manifest } from './model';

export function scan(): Finding[] {
  // Project files of the JSON clients: in the projects Claude Code and Codex know.
  const projects = [...new Set([...claudeProjects(), ...codexTrustedProjects()])];
  return [...scanClaude(), ...scanCodex(), ...scanJsonClients(projects)];
}

/**
 * Writes the stable launcher script that client configurations call. It
 * points at the app's runtime; when the app is gone it runs the original
 * command, so agents never break.
 */
export function installLauncher(appExecutable: string, launcherJs: string): string {
  ensureHome();
  const content = launcherScript(appExecutable, launcherJs);
  const dest = paths.launcher;
  try { if (fs.readFileSync(dest, 'utf8') === content) return dest; } catch {}
  const tmp = dest + '.new';
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  fs.renameSync(tmp, dest);
  return dest;
}

function newBackupDir(): string {
  const dir = path.join(paths.backups, new Date().toISOString().replace(/:/g, '-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function backup(file: string, dir: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const dest = path.join(dir, file.replace(/[\\/:]/g, '_'));
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

const backupFileFor = (f: Finding) => (f.client === 'claude' ? claudeConfigFile() : f.file);

function removeIfEmpty(dir: string) {
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
}

/** Applies findings. Each file is backed up once before its first change. */
export function apply(findings: Finding[]): ChangeResult[] {
  ensureHome();
  const dir = newBackupDir();
  const results: ChangeResult[] = [];
  for (const f of findings.filter(isActionable)) {
    try {
      const b = backup(backupFileFor(f), dir);
      const entry = f.client === 'claude' ? applyClaude(f, b) : f.client === 'codex' ? applyCodex(f, b) : applyJson(f, b);
      manifest.append(entry);
      results.push({ finding: f, ok: true, message: f.shadow ? 'Local override added; .mcp.json stays unchanged.' : 'Taken over.' });
      log(`install: applied ${f.id}`);
    } catch (e: any) {
      results.push({ finding: f, ok: false, message: e.message });
      log(`install: failed ${f.id}: ${e.message}`);
    }
  }
  removeIfEmpty(dir);
  return results;
}

/**
 * Removes Habitab from all configurations. Entries changed by the user
 * after installation are unwrapped, never overwritten with an old backup.
 */
export function uninstall(only?: Finding[]): ChangeResult[] {
  const wrapped = (only ?? scan()).filter(f => (f.status === 'migrated' || f.status === 'updatePath') && f.scope !== 'plugin' && f.scope !== 'managed');
  const dir = newBackupDir();
  const results: ChangeResult[] = [];
  for (const f of wrapped) {
    try {
      backup(backupFileFor(f), dir);
      const m = manifest.latest(f.id);
      const inner = wrapper.unwrap(f.command, f.args)!;
      const message = f.client === 'claude' ? restoreClaude(f, m, inner) : f.client === 'codex' ? restoreCodex(f, m) : restoreJson(f, m);
      results.push({ finding: f, ok: true, message });
      log(`uninstall: ${f.id}: ${message}`);
    } catch (e: any) {
      results.push({ finding: f, ok: false, message: e.message });
    }
  }
  removeIfEmpty(dir);
  return results;
}

export interface LegacyServer {
  pid: number; client: string; clientPid?: number;
  /** The client already runs a Habitab server (e.g. after /mcp reconnect); this one is a leftover. */
  replaced: boolean;
}

/**
 * chrome-devtools-mcp servers that run without Habitab although Habitab
 * could manage them. Their sessions use the old configuration until the
 * client restarts the server. One entry per client process.
 */
export function legacyServers(): LegacyServer[] {
  const rows = processList();
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const tokens = (cmd: string) => cmd.split(/\s+/).filter(Boolean);
  const isServer = (cmd: string) => tokens(cmd).some(isServerToken);
  // The launcher's own command line contains the wrapped server command.
  const isLauncher = (cmd: string) => /(^|\/)habitab(\.cmd)?(\s|$)/.test(cmd) || cmd.includes('ELECTRON_RUN_AS_NODE') || cmd.includes('launcher/main.js');
  const isClient = (cmd: string) => !!clientOfCommand(cmd);
  const ancestors = (r: typeof rows[number]) => {
    const chain: typeof rows = [];
    for (let p = byPid.get(r.ppid); p && chain.length < 12; p = byPid.get(p.ppid)) chain.push(p);
    return chain;
  };
  const withHabitab = new Set(rows.filter(r => isLauncher(r.command) && isServer(r.command)).map(r => ancestors(r).find(p => isClient(p.command))?.pid));
  const result = new Map<number, LegacyServer>();
  for (const r of rows) {
    const t = tokens(r.command);
    const idx = t.findIndex(isServerToken);
    if (idx < 0 || isLauncher(r.command) || analyze(t, idx).mode !== 'managed') continue;
    const chain = ancestors(r);
    if (chain.some(p => isLauncher(p.command))) continue;
    // Only the topmost process of an npx/npm/node chain.
    if (chain[0] && isServer(chain[0].command)) continue;
    const client = chain.find(p => isClient(p.command));
    const key = client?.pid ?? -r.pid;
    if (result.has(key)) continue;
    result.set(key, { pid: r.pid, client: client ? clientOfCommand(client.command)! : 'unknown', clientPid: client?.pid, replaced: !!client && withHabitab.has(client.pid) });
  }
  return [...result.values()];
}

/** The MCP client a process is, judged by its command line. */
function clientOfCommand(cmd: string): ClientKind | undefined {
  const exe = path.basename(cmd.split(' ')[0]);
  if (/(^|\/)claude(\s|$)/.test(cmd) || /\/claude\/versions\//.test(cmd)) return 'claude';
  if (/(^|\/)codex(\s|$)/.test(cmd) || exe.includes('codex')) return 'codex';
  if (/(^|\/)opencode(\s|$)/.test(cmd)) return 'opencode';
  if (cmd.includes('/Cursor.app/')) return 'cursor';
  if (cmd.includes('/Windsurf.app/')) return 'windsurf';
  if (/(^|\/)gemini(\s|$)/.test(cmd)) return 'gemini';
  return undefined;
}

export interface LegacyBrowser { pid: number; profile: string; orphaned: boolean; }

/** Chrome instances that chrome-devtools-mcp started itself (Puppeteer profiles). */
export function legacyBrowsers(): LegacyBrowser[] {
  return processList()
    .filter(r => /Google Chrome|Chromium|chrome(\.exe)?\s/.test(r.command) && !r.command.includes('--type='))
    .map(r => ({ r, profile: r.command.match(/--user-data-dir=(\S+)/)?.[1] }))
    .filter(x => x.profile && (/puppeteer_dev_chrome_profile-/.test(x.profile) || x.profile.includes('/.cache/chrome-devtools-mcp/')))
    .map(x => ({ pid: x.r.pid, profile: x.profile!, orphaned: x.r.ppid === 1 }));
}

/** Ends a legacy browser after explicit confirmation; re-checks its profile. */
export function endLegacyBrowser(b: LegacyBrowser): boolean {
  const row = processList().find(r => r.pid === b.pid);
  if (!row || !row.command.includes(`--user-data-dir=${b.profile}`)) return false;
  try { process.kill(b.pid, 'SIGTERM'); return true; } catch { return false; }
}
