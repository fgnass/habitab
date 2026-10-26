import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, log, paths } from '../shared/paths';
import { clientOfCommand } from '../shared/session-info';
import { browserScript, launcherScript, processList, processStartTimes, ProcessRow } from '../shared/platform';
import { cd4aStatus } from './cd4a';
import { analyze, isServerToken, wrapper } from '../shared/server-command';
import { claudeConfigFile, claudeProjects, restoreClaude, scanClaude } from './claude';
import { codexTrustedProjects, restoreCodex, scanCodex } from './codex';
import { restoreJson, scanJsonClients } from './json-clients';
import { ChangeResult, ClientKind, Finding, manifest } from './model';

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
  installScript(paths.browser, browserScript(appExecutable, launcherJs));
  return installScript(paths.launcher, launcherScript(appExecutable, launcherJs));
}

function installScript(dest: string, content: string): string {
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

/**
 * Removes the 0.2 launcher wrapper from the given entries (or from all).
 * Entries changed by the user after installation are unwrapped, never
 * overwritten with an old backup. Each file is backed up once first.
 */
export function unwrap(only?: Finding[]): ChangeResult[] {
  ensureHome();
  const wrapped = (only ?? scan()).filter(f => f.status === 'unwrap' && f.scope !== 'plugin' && f.scope !== 'managed');
  const dir = newBackupDir();
  const results: ChangeResult[] = [];
  for (const f of wrapped) {
    try {
      backup(backupFileFor(f), dir);
      const m = manifest.latest(f.id);
      const inner = wrapper.unwrap(f.command, f.args)!;
      const message = f.client === 'claude' ? restoreClaude(f, m, inner) : f.client === 'codex' ? restoreCodex(f, m) : restoreJson(f, m);
      results.push({ finding: f, ok: true, message });
      log(`unwrap: ${f.id}: ${message}`);
    } catch (e: any) {
      results.push({ finding: f, ok: false, message: e.message });
    }
  }
  removeIfEmpty(dir);
  return results;
}

export interface LegacyServer {
  pid: number; client: string; clientPid?: number;
  /** The client already runs a server with its browser in Habitab (e.g. after /mcp reconnect); this one is a leftover. */
  replaced: boolean;
}

/**
 * chrome-devtools-mcp servers that run without a browser bridge below them:
 * started before the global config was set, or through a 0.2 launcher. Their
 * sessions keep their old browser until the client restarts the server. One
 * entry per client process.
 *
 * The server reads the config when it starts, but starts its browser (and so
 * the bridge) only on the first tool call. A server without a bridge that
 * started after the last change of the config uses Habitab and is not legacy.
 */
export function legacyServers(
  rows: ProcessRow[] = processList(),
  configChanged: number | null = habitabConfigChanged(),
  startTimes: (pids: number[]) => Map<number, number> = processStartTimes,
): LegacyServer[] {
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const tokens = (cmd: string) => cmd.split(/\s+/).filter(Boolean);
  const isServer = (cmd: string) => tokens(cmd).some(isServerToken);
  // The `habitab mcp -- <server>` pass-through (0.2 configurations) has the server tokens in its own command line.
  const isLauncher = (cmd: string) => /(^|\/)habitab(\.cmd)?(\s|$)/.test(cmd) || cmd.includes('ELECTRON_RUN_AS_NODE') || cmd.includes('launcher/main.js');
  // The browser bridge (`habitab browser`, see cd4a.ts) runs below the server it serves.
  const isBridge = (cmd: string) => /launcher\/main\.js browser(\s|$)/.test(cmd) || /(^|\/)habitab-browser(\s|$)/.test(cmd);
  const isClient = (cmd: string) => !!clientOfCommand(cmd);
  const ancestors = (r: typeof rows[number]) => {
    const chain: typeof rows = [];
    for (let p = byPid.get(r.ppid); p && chain.length < 12; p = byPid.get(p.ppid)) chain.push(p);
    return chain;
  };
  const bridges = rows.filter(r => isBridge(r.command));
  const bridged = new Set(bridges.flatMap(r => ancestors(r).map(p => p.pid)));
  const withHabitab = new Set(bridges.map(r => ancestors(r).find(p => isClient(p.command))?.pid));
  const candidates: { r: ProcessRow; client?: ProcessRow }[] = [];
  for (const r of rows) {
    const t = tokens(r.command);
    const idx = t.findIndex(isServerToken);
    if (idx < 0 || isLauncher(r.command) || analyze(t, idx).mode !== 'managed') continue;
    const chain = ancestors(r);
    if (bridged.has(r.pid)) continue;
    // Only the topmost process of an npx/npm/node chain.
    if (chain[0] && isServer(chain[0].command)) continue;
    candidates.push({ r, client: chain.find(p => isClient(p.command)) });
  }
  // ps shows start times in whole seconds: a server of the same second counts as started after the change.
  const changedSecond = configChanged === null ? undefined : Math.floor(configChanged / 1000) * 1000;
  const started = changedSecond === undefined ? new Map<number, number>() : startTimes(candidates.map(c => c.r.pid));
  const result = new Map<number, LegacyServer>();
  for (const { r, client } of candidates) {
    const t = started.get(r.pid);
    if (changedSecond !== undefined && t !== undefined && t >= changedSecond) continue;
    const key = client?.pid ?? -r.pid;
    if (result.has(key)) continue;
    result.set(key, { pid: r.pid, client: client ? clientOfCommand(client.command) as ClientKind : 'unknown', clientPid: client?.pid, replaced: !!client && withHabitab.has(client.pid) });
  }
  return [...result.values()];
}

/** When the global config last changed, if it names Habitab's browser. */
function habitabConfigChanged(): number | null {
  const s = cd4aStatus();
  if (!s.habitab) return null;
  try { return fs.statSync(s.file).mtimeMs; } catch { return null; }
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
