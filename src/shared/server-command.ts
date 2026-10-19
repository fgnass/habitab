// Analysis of a configured MCP command line (command + args): finds the
// chrome-devtools-mcp token and classifies its browser options. The server
// gets its browser through its global config (see installer/cd4a.ts), so
// the command line itself is never changed; old launcher wrappers are
// recognized (`wrapper`) and removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Mode = 'managed' | 'external' | 'persistentProfile';

export interface LaunchOptions {
  proxyServer?: string;
  viewport?: string;
  acceptInsecureCerts?: boolean;
  /** Options without effect in Habitab (embedded Chromium). */
  ignored: string[];
}

export interface ServerCommand {
  argv: string[];
  serverIndex: number;
  mode: Mode;
  reasons: string[];
  launch: LaunchOptions;
  runner: string[];
  serverArgs: string[];
}

export function isServerToken(token: string): boolean {
  const t = token.toLowerCase().replace(/\\/g, '/');
  const last = t.split('/').pop() ?? '';
  if (last === 'chrome-devtools-mcp' || last.startsWith('chrome-devtools-mcp@')) return true;
  if (last === 'chrome-devtools-mcp.js' || last === 'chrome-devtools-mcp-main.js' || last === 'chrome-devtools-mcp.cmd') return true;
  if (t.includes('/chrome-devtools-mcp/') && t.endsWith('.js')) return true;
  // Scoped forks are not the official server; do not claim them.
  return false;
}

/** Value-taking options of chrome-devtools-mcp 1.x. */
const STRING_OPTIONS = new Set([
  'browserUrl', 'wsEndpoint', 'wsHeaders', 'executablePath', 'userDataDir', 'channel', 'proxyServer', 'chromeArg',
  'ignoreDefaultChromeArg', 'logFile', 'viewport', 'config', 'blockedUrlPattern', 'allowedUrlPattern', 'filesystemRoot',
  'experimentalFfmpegPath', 'experimentalScreencastFps', 'screenshotFormat', 'screenshotQuality', 'screenshotMaxWidth',
  'screenshotMaxHeight', 'clearcutEndpoint', 'clearcutForceFlushIntervalMs', 'experimentalDataFormat',
]);
const ALIASES: Record<string, string> = { u: 'browserUrl', w: 'wsEndpoint', e: 'executablePath', workspace: 'filesystemRoot' };

export interface Option { key: string; negated: boolean; value?: string; start: number; end: number; }

export const camel = (name: string) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Tokenizes yargs-style options: --a b, --a=b, -u b, --no-a. */
export function parseOptions(args: string[]): Option[] {
  const result: Option[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token.startsWith('-') || token === '-' || token === '--') { i++; continue; }
    let name = token.replace(/^-+/, '');
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    let key = ALIASES[name] ?? camel(name);
    let negated = false;
    if (/^no[A-Z]/.test(key) && !STRING_OPTIONS.has(key)) {
      negated = true;
      key = key[2].toLowerCase() + key.slice(3);
    }
    const start = i++;
    if (value === undefined) {
      if (STRING_OPTIONS.has(key)) { if (i < args.length) value = args[i++]; }
      else if (i < args.length && /^(true|false)$/i.test(args[i])) value = args[i++];
    }
    result.push({ key, negated, value, start, end: i });
  }
  return result;
}

const flag = (o: Option) => !o.negated && (o.value === undefined || !/^(false|0)$/i.test(o.value));

function configFileOptions(args: string[]): Option[] {
  const configPath = parseOptions(args).filter(o => o.key === 'config').pop()?.value;
  if (!configPath) return [];
  try {
    const json = JSON.parse(fs.readFileSync(configPath.replace(/^~(?=\/)/, os.homedir()), 'utf8'));
    return Object.entries(json).map(([k, v]) => ({
      key: camel(k), negated: false, start: 0, end: 0,
      value: typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : undefined,
    }));
  } catch { return []; }
}

export function analyze(argv: string[], serverIndex: number): ServerCommand {
  const serverArgs = argv.slice(serverIndex + 1);
  const opts = [...configFileOptions(serverArgs), ...parseOptions(serverArgs)];
  let mode: Mode = 'managed';
  const reasons: string[] = [];
  const launch: LaunchOptions = { ignored: [] };
  for (const o of opts) {
    switch (o.key) {
      case 'browserUrl': case 'wsEndpoint':
        if (o.value) { mode = 'external'; reasons.push(`--${o.key}`); }
        break;
      case 'autoConnect':
        if (flag(o)) { mode = 'external'; reasons.push('--autoConnect'); }
        break;
      case 'userDataDir':
        if (mode !== 'external' && o.value) { mode = 'persistentProfile'; reasons.push('--userDataDir'); }
        break;
      case 'proxyServer': launch.proxyServer = o.value; break;
      case 'viewport': launch.viewport = o.value; break;
      case 'acceptInsecureCerts': launch.acceptInsecureCerts = flag(o); break;
      case 'executablePath': case 'channel': case 'chromeArg': case 'ignoreDefaultChromeArg':
        launch.ignored.push(`--${o.key}`);
        break;
    }
  }
  return { argv, serverIndex, mode, reasons, launch, runner: argv.slice(0, serverIndex + 1), serverArgs };
}

export function parseCommand(command: string, args: string[]): ServerCommand | undefined {
  const argv = [command, ...args];
  const index = argv.findIndex(isServerToken);
  return index < 0 ? undefined : analyze(argv, index);
}

/** The wrapper that Habitab 0.2 wrote into client configurations; found and removed by the installer. */
export const wrapper = {
  subcommand: 'mcp',
  isLauncher(command: string): boolean {
    const name = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    return name === 'habitab' || name === 'habitab.cmd';
  },
  wrap(command: string, args: string[], launcher: string): [string, string[]] {
    return [launcher, ['mcp', '--', command, ...args]];
  },
  unwrap(command: string, args: string[]): [string, string[]] | undefined {
    if (!this.isLauncher(command) || args[0] !== 'mcp') return undefined;
    const sep = args.indexOf('--');
    if (sep < 0 || sep + 1 >= args.length) return undefined;
    return [args[sep + 1], args.slice(sep + 2)];
  },
};
