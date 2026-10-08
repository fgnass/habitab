// Analysis of a configured MCP command line (command + args): finds the
// chrome-devtools-mcp token, classifies browser options and rewrites the
// server arguments for a session browser inside Habitab.
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

/** Options that control how the server launches a browser. Removed before start. */
export const LAUNCH_OPTIONS = new Set([
  'isolated', 'headless', 'executablePath', 'channel', 'chromeArg', 'ignoreDefaultChromeArg', 'proxyServer',
  'acceptInsecureCerts', 'userDataDir',
]);

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

/** Server arguments for a server that connects to a Habitab session browser. */
export function rewriteServerArgs(args: string[], browserUrl: string, sanitizedConfig?: string): string[] {
  const drop = new Set<number>();
  for (const o of parseOptions(args)) {
    if (LAUNCH_OPTIONS.has(o.key) || (o.key === 'config' && sanitizedConfig)) {
      for (let i = o.start; i < o.end; i++) drop.add(i);
    }
  }
  const result = args.filter((_, i) => !drop.has(i));
  if (sanitizedConfig) result.push('--config', sanitizedConfig);
  result.push('--browserUrl', browserUrl);
  return result;
}

/** Copy of a --config file without launch options, or undefined if not needed. */
export function sanitizeConfig(args: string[], dir: string): string | undefined {
  const configPath = parseOptions(args).filter(o => o.key === 'config').pop()?.value;
  if (!configPath) return undefined;
  try {
    const json = JSON.parse(fs.readFileSync(configPath.replace(/^~(?=\/)/, os.homedir()), 'utf8'));
    const kept = Object.fromEntries(Object.entries(json).filter(([k]) => !LAUNCH_OPTIONS.has(camel(k))));
    if (Object.keys(kept).length === Object.keys(json).length) return undefined;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `config-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(kept), { mode: 0o600 });
    return file;
  } catch { return undefined; }
}

/** The wrapped form written into client configurations. */
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
