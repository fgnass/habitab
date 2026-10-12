// Everything that differs between macOS, Linux and Windows lives here.
// macOS is implemented and tested; Linux and Windows are prepared.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const platform = process.platform;

/** Default data directory of Habitab. */
export function defaultHome(): string {
  const home = os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Habitab');
  if (platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Habitab');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'habitab');
}

/** Socket or named pipe of the app. AF_UNIX paths are limited to ~104 bytes. */
export function defaultSocket(home: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\habitab-${os.userInfo().username}`;
  const candidate = path.join(platform === 'linux' && process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : home, 'habitab.sock');
  if (Buffer.byteLength(candidate) < 100) return candidate;
  return path.join(os.tmpdir(), `habitab-${os.userInfo().uid}.sock`);
}

export function launcherFileName(): string {
  return platform === 'win32' ? 'habitab.cmd' : 'habitab';
}

/**
 * Stable launcher script. It runs the launcher with the Node runtime inside
 * the app (ELECTRON_RUN_AS_NODE), so no Node installation is needed. If the
 * app is gone, it runs the original command unchanged.
 */
export function launcherScript(appExecutable: string, launcherJs: string): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      `if exist "${appExecutable}" (`,
      `  set ELECTRON_RUN_AS_NODE=1`,
      `  "${appExecutable}" "${launcherJs}" %*`,
      `  exit /b %ERRORLEVEL%`,
      ')',
      'rem Habitab is not installed: run the original command after "mcp --".',
      'shift & shift',
      '%1 %2 %3 %4 %5 %6 %7 %8 %9',
      '',
    ].join('\r\n');
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Habitab launcher. Client configurations call this file:
#   habitab mcp -- <original command...>
APP=${q(appExecutable)}
JS=${q(launcherJs)}
if [ -x "$APP" ] && [ -f "$JS" ] && [ "$HABITAB_DISABLE" != "1" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$APP" "$JS" "$@"
fi
# Habitab is not installed: run the original command unchanged.
[ "$1" = "mcp" ] && shift
[ "$1" = "--" ] && shift
exec "$@"
`;
}

export interface ProcessRow { pid: number; ppid: number; command: string; }

/** Process list (pid, ppid, full command line). */
export function processList(): ProcessRow[] {
  if (platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8' });
      return out.split(/\r?\n/).filter(Boolean).map(l => { const [p, pp, ...c] = l.split('\t'); return { pid: +p, ppid: +pp, command: c.join('\t') }; });
    } catch { return []; }
  }
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map(l => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], command: m[3] } : null;
  }).filter((r): r is ProcessRow => r !== null);
}

/** Executable name of a process (argv[0] base name). */
export function processName(pid: number): string | undefined {
  if (platform === 'win32') return processList().find(p => p.pid === pid)?.command.split(/[\\/]/).pop()?.split(' ')[0];
  const exe = processExecutable(pid);
  return exe && path.basename(exe);
}

/** argv[0] of a process (a full path when it was started with one). */
export function processExecutable(pid: number): string | undefined {
  try {
    if (platform === 'win32') return processList().find(p => p.pid === pid)?.command.split(' ')[0];
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(' ')[0] || undefined;
  } catch { return undefined; }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}

/** How to start the app: the executable, plus the app directory in development. */
export interface AppCommand { exe: string; args: string[]; }

/** Starts the app in the background without stealing focus. */
export function startApp(cmd: AppCommand): void {
  const appBundleOrExe = cmd.exe;
  if (!fs.existsSync(appBundleOrExe)) return;
  if (cmd.args.length) {
    // Development: electron <app dir>
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(appBundleOrExe, cmd.args, { detached: true, stdio: 'ignore', env }).unref();
    return;
  }
  if (platform === 'darwin') {
    const bundle = appBundleOrExe.includes('.app/') ? appBundleOrExe.slice(0, appBundleOrExe.indexOf('.app/') + 4) : appBundleOrExe;
    // `open` does not pass the environment; forward Habitab's own variables
    // (used by test instances with their own HABITAB_HOME).
    const envArgs = Object.entries(process.env).filter(([k]) => k.startsWith('HABITAB_')).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    spawn('/usr/bin/open', ['-g', '-j', ...envArgs, bundle], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(appBundleOrExe, [], { detached: true, stdio: 'ignore', env }).unref();
}
