import fs from 'node:fs';
import path from 'node:path';
import { defaultHome, defaultSocket, launcherFileName } from './platform';

// HABITAB_HOME and HABITAB_SOCKET override the defaults. Tests use them to
// run a complete, separate instance next to a real installation.
export const paths = {
  get home() { return process.env.HABITAB_HOME || defaultHome(); },
  get socket() { return process.env.HABITAB_SOCKET || defaultSocket(this.home); },
  get bin() { return path.join(this.home, 'bin'); },
  get launcher() { return path.join(this.bin, launcherFileName()); },
  get logs() { return path.join(this.home, 'logs'); },
  get backups() { return path.join(this.home, 'backups'); },
  get manifest() { return path.join(this.home, 'install-manifest.json'); },
  get state() { return path.join(this.home, 'state.json'); },
  /** Open sessions with their tabs and cookies, restored after an app restart. */
  get sessions() { return path.join(this.home, 'sessions.json'); },
  /** Window layout preferences of the app. */
  get ui() { return path.join(this.home, 'ui.json'); },
  get appPathFile() { return path.join(this.home, 'app-path'); },
  get chromium() { return path.join(this.home, 'chromium'); },
  /** Screenshots of the sessions' timelines, one folder per session. */
  get timeline() { return path.join(this.home, 'timeline'); },
};

export function ensureHome(): void {
  for (const dir of [paths.home, paths.bin, paths.logs, paths.backups]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

let logFile: string | undefined;
let component = 'habitab';

export function openLog(name: string): void {
  ensureHome();
  component = name;
  logFile = path.join(paths.logs, `${name}.log`);
  try {
    if (fs.statSync(logFile).size > 5_000_000) fs.renameSync(logFile, logFile + '.1');
  } catch {}
}

export function log(message: string): void {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${component}:${process.pid}] ${message}\n`, { mode: 0o600 });
  } catch {}
}
