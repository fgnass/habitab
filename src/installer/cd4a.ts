// chrome-devtools-mcp's global config file ("cd4a": Chrome DevTools for
// agents). Servers from 1.10.0 read it wherever they are started from, also
// when a CLI bundles the server; a server's own flags win per key. With
// Habitab's browser as executablePath, every server gets its session browser
// in the app without a change to the client configurations.
//
// executablePath conflicts with channel, browserUrl, wsEndpoint and
// autoConnect: a server started with one of them refuses to start. Such an
// entry sets CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1 in its environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../shared/paths';

/** Keys of the config file that cannot be combined with executablePath. */
const CONFLICTS = ['channel', 'browserUrl', 'wsEndpoint', 'autoConnect'];

export function cd4aConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'cd4a', 'config.json');
  }
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'cd4a', 'config.json');
}

export interface Cd4aStatus {
  file: string;
  exists: boolean;
  config: Record<string, unknown>;
  /** The file cannot be read as a JSON object. */
  invalid?: string;
  executablePath?: string;
  /** executablePath names Habitab's browser. */
  habitab: boolean;
  /** Keys in the file that conflict with executablePath. */
  conflicts: string[];
}

export function cd4aStatus(): Cd4aStatus {
  const file = cd4aConfigPath();
  const status: Cd4aStatus = { file, exists: false, config: {}, habitab: false, conflicts: [] };
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return status; }
  status.exists = true;
  try {
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a JSON object');
    status.config = json;
  } catch (e: any) {
    status.invalid = e?.message ?? String(e);
    return status;
  }
  const exe = status.config.executablePath;
  if (typeof exe === 'string') {
    status.executablePath = exe;
    status.habitab = path.resolve(exe) === path.resolve(paths.browser);
  }
  status.conflicts = CONFLICTS.filter(k => status.config[k] !== undefined && status.config[k] !== false);
  return status;
}

/** Names Habitab's browser as executablePath; other keys stay. */
export function applyCd4a(): { ok: boolean; message: string } {
  const s = cd4aStatus();
  if (s.invalid) return { ok: false, message: `${s.file} is not valid JSON (${s.invalid}); fix or remove it first` };
  if (s.habitab) return { ok: true, message: `${s.file} already names Habitab's browser` };
  if (s.conflicts.length) return { ok: false, message: `${s.file} has ${s.conflicts.join(', ')}, which cannot be combined with executablePath; remove them first` };
  const previous = s.executablePath ? ` (was ${s.executablePath})` : '';
  write(s, { ...s.config, executablePath: paths.browser });
  return { ok: true, message: `${s.file}: executablePath = ${paths.browser}${previous}` };
}

/** Removes Habitab's entry; the file goes when nothing else is in it. */
export function removeCd4a(): { ok: boolean; message: string } {
  const s = cd4aStatus();
  if (!s.habitab) return { ok: true, message: `${s.file} does not name Habitab's browser` };
  const { executablePath: _, ...rest } = s.config;
  if (Object.keys(rest).length) {
    write(s, rest);
    return { ok: true, message: `${s.file}: executablePath removed` };
  }
  backup(s);
  fs.unlinkSync(s.file);
  return { ok: true, message: `${s.file} removed` };
}

function write(s: Cd4aStatus, config: Record<string, unknown>): void {
  backup(s);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify(config, null, 2) + '\n');
}

function backup(s: Cd4aStatus): void {
  if (!s.exists) return;
  const dir = path.join(paths.backups, new Date().toISOString().replace(/:/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(s.file, path.join(dir, 'cd4a-config.json'));
}
