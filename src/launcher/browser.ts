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
  /** Messages for the app while the user has control (or before the connection is open). */
  private queue: string[] = [];
  private held = false;
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
    this.link.onHold = hold => this.setHold(hold);
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
    ws.on('message', data => this.toPipe(String(data)));
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

  private flush(): void {
    if (this.held && this.queue.some(isAgentWork)) this.setWaiting(true);
    if (this.held || this.ws?.readyState !== WebSocket.OPEN) return;
    for (const m of this.queue.splice(0)) this.ws.send(m);
    this.setWaiting(false);
  }

  private setWaiting(waiting: boolean): void {
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

  /** The user has control: the agent's commands wait (at most ten minutes). */
  private setHold(hold: boolean): void {
    this.held = hold;
    clearTimeout(this.heldTimer);
    if (hold) this.heldTimer = setTimeout(() => { this.setHold(false); this.link.send({ type: 'hold', hold: false }); }, 10 * 60_000).unref();
    else this.flush();
    log(`hold=${hold}`);
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

/**
 * The MCP server also sends commands by itself, as answers to events of the
 * page (a navigation, a new frame or worker): set-up and bookkeeping. Only
 * other commands are the agent's work, i.e. it waits for the user.
 */
const BACKGROUND = /^(\w+\.(enable|disable)|Debugger\.\w+|Audits\.\w+|Autofill\.\w+|Storage\.getStorageKey|Runtime\.(runIfWaitingForDebugger|getIsolateId|releaseObject)|Target\.(setAutoAttach|setDiscoverTargets|attachToTarget|getTargets)|Page\.(getFrameTree|getResourceTree|setLifecycleEventsEnabled|addScriptToEvaluateOnNewDocument|createIsolatedWorld)|Network\.setAttachDebugStack|Log\.startViolationsReport|Emulation\.setFocusEmulationEnabled)$/;
function isAgentWork(message: string): boolean {
  const method = /"method":"([^"]+)"/.exec(message)?.[1];
  return !!method && !BACKGROUND.test(method);
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
