// `habitab browser <chrome arguments...>`
//
// chrome-devtools-mcp starts this in place of Chrome: its global config names
// Habitab's browser script as executablePath (see `habitab cd4a`). Puppeteer
// launches it with --remote-debugging-pipe and talks CDP over the pipe fds 3
// (in) and 4 (out), NUL between messages. The messages go to the session
// browser in the app. The session belongs to the MCP server process above;
// the client (Claude Code, Codex, Gemini CLI, ...) is found further up.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { isAgentAction } from '../shared/agent-actions';
import { isSessionId, SessionMeta } from '../shared/ipc';
import { log, openLog } from '../shared/paths';
import { processExecutable, systemChrome } from '../shared/platform';
import { postToInbox } from '../shared/push';
import { collectMeta } from '../shared/session-info';
import { ManagerLink } from './manager-link';

export async function runBrowser(args: string[]): Promise<void> {
  openLog('browser');
  log(`start ppid=${process.ppid} cwd=${process.cwd()} args=${args.join(' ')}`);
  if (process.env.HABITAB_DISABLE === '1') return realChrome(args, 'HABITAB_DISABLE=1');
  if (!args.includes('--remote-debugging-pipe')) {
    process.stderr.write('habitab-browser: expected --remote-debugging-pipe (chrome-devtools-mcp starts Chrome with a pipe)\n');
    process.exit(64);
  }
  await new BrowserBridge(args).start();
}

/**
 * Starts the real Chrome with the same arguments and pipes, so the agent's
 * browser works without Habitab (like the launcher's pass-through).
 */
function realChrome(args: string[], why: string): void {
  const exe = systemChrome();
  log(`real Chrome (${why}): ${exe ?? 'not found'}`);
  if (!exe) {
    process.stderr.write(`habitab-browser: ${why}, and no Chrome found to start instead\n`);
    process.exit(1);
  }
  const child = spawn(exe, args, { stdio: ['inherit', 'inherit', 'inherit', 3, 4] });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  child.on('error', e => { process.stderr.write(`habitab-browser: cannot start ${exe}: ${e.message}\n`); process.exit(127); });
}

class BrowserBridge {
  /** One session per MCP server process: a relaunched browser rejoins it. */
  readonly session = isSessionId(process.env.HABITAB_SESSION) ? process.env.HABITAB_SESSION! : `hb-p${process.ppid}`;
  private meta: SessionMeta;
  private link: ManagerLink;
  private input = new net.Socket({ fd: 3, readable: true, writable: false });
  private output = new net.Socket({ fd: 4, readable: false, writable: true });
  private ws?: WebSocket;
  private buffer: Buffer = Buffer.alloc(0);
  /** Messages for the app: the agent's work while the user has control, all before the connection is open. */
  private queue: string[] = [];
  /** When each of the agent's commands began to wait for the user. */
  private since = new Map<string, number>();
  private expireTimer?: NodeJS.Timeout;
  /** The user has control: of all tabs (true), or only of these tabs (their target ids). */
  private held: boolean | Set<string> = false;
  /** The page (target id) of each CDP session; frames and workers belong to the page above them. */
  private pageOf = new Map<string, string>();
  /** The app knows that the agent's commands wait for the user. */
  private waiting = false;
  private heldTimer?: NodeJS.Timeout;
  /** Id of the client's Browser.close: its answer ends this process. */
  private closing?: number;
  private ended = false;

  constructor(private args: string[]) {
    this.meta = { ...collectMeta(true), originalCommand: serverCommand() };
    const proxyServer = args.find(a => a.startsWith('--proxy-server='))?.slice('--proxy-server='.length);
    this.link = new ManagerLink(() => ({
      type: 'hello', sessionId: this.session, launcherPid: process.pid, serverPid: process.ppid, meta: this.meta, launch: { proxyServer },
    }));
    this.link.onHold = (hold, targets) => this.setHold(hold && (targets ? new Set(targets) : true));
    // Claude Code gives its MCP servers the inbox socket; Puppeteer passes the environment on.
    if (this.meta.client === 'claude' && process.env.CLAUDE_CODE_MESSAGING_SOCKET) this.meta.inbox = true;
    this.link.onFeedbackPush = content => void postToInbox(content);
  }

  async start(): Promise<void> {
    log(`session ${this.session} client=${this.meta.client ?? '?'} (pid ${this.meta.clientPid ?? '-'}) project=${this.meta.projectRoot ?? this.meta.cwd}`);
    this.link.start();
    let port: number;
    try {
      port = await this.link.attach();
    } catch (e: any) {
      this.link.close('no app');
      return realChrome(this.args, `Habitab app not reachable (${e?.message ?? e})`);
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/${this.session}`, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => { log(`connected to the session browser (port ${port})`); this.flush(); });
    ws.on('message', data => { const m = String(data); this.track(m); this.toPipe(m); });
    // The app closed the browser (profile switch, app quit): the server lives on and starts a new bridge with its next call.
    ws.on('close', () => this.end('session browser closed', 1, false));
    ws.on('error', e => log(`browser connection error: ${e.message}`));
    this.input.on('data', (chunk: Buffer) => this.fromPipe(chunk));
    this.input.on('end', () => this.end('pipe closed by the server', 0));
    this.input.on('error', e => this.end(`pipe error: ${e.message}`, 0));
    this.output.on('error', e => this.end(`pipe error: ${e.message}`, 0));
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => this.end(`signal ${sig}`, 0));
  }

  /** CDP messages from Puppeteer: NUL-terminated JSON. */
  private fromPipe(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let i: number;
    while ((i = this.buffer.indexOf(0)) >= 0) {
      const message = this.buffer.subarray(0, i).toString('utf8');
      this.buffer = this.buffer.subarray(i + 1);
      if (!message) continue;
      if (TRACE) trace('>', message);
      if (this.closing === undefined && message.includes('"Browser.close"')) {
        try { const m = JSON.parse(message); if (m.method === 'Browser.close' && !m.sessionId) this.closing = m.id; } catch {}
      }
      this.queue.push(message);
      this.flush();
    }
  }

  /**
   * While the user has control, only the agent's actions wait. Everything
   * else goes on: a tab that the user's click opened waits for the server's
   * Runtime.runIfWaitingForDebugger before it loads its page, and the
   * server's DevTools SDK answers the page's events by itself.
   */
  private flush(): void {
    const open = this.ws?.readyState === WebSocket.OPEN;
    const later: string[] = [];
    for (const m of this.queue) {
      const waits = this.waits(m);
      if (open && !waits) { this.ws!.send(m); this.since.delete(m); }
      else {
        later.push(m);
        if (waits && !this.since.has(m)) {
          if (!this.since.size) log(`waits for the user: ${/"method":"([^"]+)"/.exec(m)?.[1]}`);
          this.since.set(m, Date.now());
        }
      }
    }
    this.queue = later;
    this.setWaiting();
    this.scheduleExpiry();
  }

  /**
   * A command that waits for the user too long gets an error that names the
   * cause: the agent sees in the tool's result that the user has control, and
   * does not look for a fault in the page.
   */
  private scheduleExpiry(): void {
    clearTimeout(this.expireTimer);
    if (!this.since.size) return;
    const oldest = Math.min(...this.since.values());
    this.expireTimer = setTimeout(() => this.expire(), Math.max(0, oldest + HELD_LIMIT_MS - Date.now())).unref();
  }

  private expire(): void {
    const now = Date.now();
    this.queue = this.queue.filter(m => {
      const at = this.since.get(m);
      if (at === undefined || now - at < HELD_LIMIT_MS) return true;
      this.since.delete(m);
      const reply = heldError(m, now - at, this.held !== true);
      log(`cancelled after ${Math.round((now - at) / 1000)} s (user has control): ${/"method":"([^"]+)"/.exec(m)?.[1]}`);
      if (reply) this.toPipe(reply);
      return false;
    });
    this.setWaiting();
    this.scheduleExpiry();
  }

  private setWaiting(): void {
    const waiting = this.queue.some(m => this.waits(m));
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    this.link.send({ type: 'waiting', waiting });
  }

  private toPipe(message: string): void {
    if (this.ended) return;
    if (TRACE) trace('<', message);
    this.output.write(message + '\0');
    if (this.closing !== undefined && message.includes(`"id":${this.closing}`)) {
      try { if (JSON.parse(message).id === this.closing) this.end('Browser.close', 0); } catch {}
    }
  }

  /** The agent's command waits for the user: the user has control of all tabs, or of the tab the command is for. */
  private waits(message: string): boolean {
    if (!this.held || !isAgentWork(message)) return false;
    return this.held === true || waitsForTabs(message, this.held, this.pageOf);
  }

  /** Follows which page each CDP session belongs to (for control of single tabs). */
  private track(message: string): void {
    if (!message.includes('"Target.attachedToTarget"') && !message.includes('"Target.detachedFromTarget"')) return;
    try { trackSession(JSON.parse(message), this.pageOf); } catch {}
  }

  /** The user has control (of all tabs, or of some): the agent's commands for them wait (at most ten minutes). */
  private setHold(hold: boolean | Set<string>): void {
    if (hold instanceof Set && !hold.size) hold = false;
    this.held = hold;
    clearTimeout(this.heldTimer);
    this.flush();
    if (hold) this.heldTimer = setTimeout(() => { this.setHold(false); this.link.send({ type: 'hold', hold: false }); }, 10 * 60_000).unref();
    log(`hold=${hold instanceof Set ? [...hold].join(',') : hold}`);
  }

  private end(reason: string, code: number, signOff = true): void {
    if (this.ended) return;
    this.ended = true;
    log(`end: ${reason}${signOff ? '' : ' (no sign-off)'}`);
    this.link.close(reason, signOff);
    try { this.ws?.close(); } catch {}
    try { this.output.end(); } catch {}
    setTimeout(() => process.exit(code), 150);
  }
}

/** The agent's action (shared/agent-actions.ts): only that waits for the user; the server's bookkeeping goes on. */
function isAgentWork(message: string): boolean {
  return isAgentAction(/"method":"([^"]+)"/.exec(message)?.[1]);
}

/** The agent's actions that change the tab the user sees: they wait while the user has control of any tab. */
const SWITCHES_TAB = new Set(['Target.createTarget', 'Target.activateTarget', 'Page.bringToFront']);

/**
 * While the user has control of some tabs only: does the agent's action wait?
 * Yes, if it is for one of these tabs, or if it would show another tab in
 * place of the user's. Its tab is the page of its CDP session, or for a
 * browser-level command its targetId.
 */
export function waitsForTabs(message: string, tabs: Set<string>, pageOf: Map<string, string>): boolean {
  let m: any;
  try { m = JSON.parse(message); } catch { return false; }
  if (SWITCHES_TAB.has(m?.method)) return true;
  const target = m?.sessionId ? pageOf.get(m.sessionId) : m?.params?.targetId;
  return typeof target === 'string' && tabs.has(target);
}

/** Notes the page of a new CDP session (Target.attachedToTarget), or forgets a gone one. */
export function trackSession(m: any, pageOf: Map<string, string>): void {
  const p = m?.params ?? {};
  if (m?.method === 'Target.attachedToTarget' && p.sessionId && p.targetInfo?.targetId) {
    // Workers, worklets and frames belong to the page above them (not to its "tab" target).
    const parent = p.targetInfo.type !== 'page' && m.sessionId ? pageOf.get(m.sessionId) : undefined;
    pageOf.set(p.sessionId, parent ?? p.targetInfo.targetId);
  } else if (m?.method === 'Target.detachedFromTarget' && p.sessionId) pageOf.delete(p.sessionId);
}

/** The agent's command waits this long for the user, then it gets an error (heldError). */
export const HELD_LIMIT_MS = Number(process.env.HABITAB_HELD_LIMIT_MS) || 30_000;

/**
 * The CDP error for a command that waited too long while the user had
 * control. Puppeteer puts the message into its error, and
 * chrome-devtools-mcp into the tool's result.
 */
export function heldError(message: string, waitedMs: number, oneTab = false): string | undefined {
  let m: any;
  try { m = JSON.parse(message); } catch { return; }
  if (typeof m?.id !== 'number') return;
  const text = `The user uses ${oneTab ? 'a tab of ' : ''}this browser; this command waited ${Math.round(waitedMs / 1000)} s and was cancelled. `
    + `Not a fault of the page or the tool: do not debug it. Try again, or continue with other work.`;
  return JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), error: { code: -32000, message: text } });
}

/** HABITAB_CDP_TRACE=1: every CDP message in the log (method, id, session, size), for measuring tool sequences. */
const TRACE = process.env.HABITAB_CDP_TRACE === '1';
function trace(dir: '>' | '<', message: string): void {
  try {
    const m = JSON.parse(message);
    const what = m.method ?? (m.error ? 'error' : 'reply');
    const p = m.params ?? {};
    const extra = m.method === 'Input.dispatchMouseEvent' || m.method === 'Input.dispatchKeyEvent' ? ` ${p.type} ${p.key ?? ''}`
      : m.method === 'Page.navigate' ? ` ${p.url}`
      : m.method === 'Runtime.callFunctionOn' || m.method === 'Runtime.evaluate' ? ` ${JSON.stringify((p.functionDeclaration ?? p.expression ?? '').slice(0, 60))} args=${JSON.stringify(p.arguments ?? []).slice(0, 160)}` : '';
    log(`${dir} ${what}${extra} id=${m.id ?? '-'} s=${m.sessionId?.slice(0, 6) ?? '-'} ${message.length}b`);
  } catch {}
}

/** The MCP server's command line, for the session's details. */
function serverCommand(): string[] | undefined {
  const exe = processExecutable(process.ppid);
  return exe ? [exe] : undefined;
}
