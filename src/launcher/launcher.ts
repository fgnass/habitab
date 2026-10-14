// `habitab mcp -- <original command...>`
//
// Runs the unchanged chrome-devtools-mcp server as a child process and copies
// MCP messages between client and server. The server gets --browserUrl of a
// local port owned by this launcher. The first DevTools connection to that
// port asks the app for the session browser and forwards to its endpoint.
import { ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { newSessionId, SessionMeta } from '../shared/ipc';
import { log, openLog, paths } from '../shared/paths';
import { applyClaudeSessionFile, codexThreadName, collectMeta } from '../shared/session-info';
import { parseCommand, rewriteServerArgs, sanitizeConfig, ServerCommand } from '../shared/server-command';
import { processExecutable } from '../shared/platform';
import { ManagerLink } from './manager-link';

export async function runMcp(original: string[]): Promise<void> {
  openLog('launcher');
  if (original.length === 0) {
    process.stderr.write('habitab mcp: missing command after --\n');
    process.exit(64);
  }
  const cmd = process.env.HABITAB_DISABLE === '1' ? undefined : parseCommand(original[0], original.slice(1));
  if (!cmd || cmd.mode !== 'managed') {
    log(`pass-through (${cmd ? cmd.mode + ': ' + cmd.reasons.join(', ') : 'disabled or not chrome-devtools-mcp'})`);
    return passThrough(original);
  }
  await new Launcher(original, cmd).start();
}

/** Runs a command unchanged with inherited stdio and relays its exit. */
function passThrough(argv: string[]): void {
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  child.on('error', e => { process.stderr.write(`habitab: ${e.message}\n`); process.exit(127); });
}

interface Inflight { tool: string; start: number; }

class Launcher {
  readonly session = newSessionId();
  private meta: SessionMeta;
  private link: ManagerLink;
  private child!: ChildProcess;
  private forwardPort = 0;
  private inflight = new Map<string, Inflight>();
  private rootsRequests = new Set<string>();
  private held = false;
  private initializeId?: string;
  private toolsListIds = new Set<string>();
  /** Open wait_for_user_feedback calls: request id -> JSON-RPC id and timer. */
  private feedback = new Map<string, { id: unknown; timer: NodeJS.Timeout }>();
  private heldLines: Buffer[] = [];
  private heldTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private lastClaudeCheck = Date.now();
  /** The codex executable that has `codex queue`. */
  private codexBin?: string;

  constructor(private original: string[], private cmd: ServerCommand) {
    this.meta = { ...collectMeta(), originalCommand: original, serverName: process.env.HABITAB_SERVER_NAME };
    this.link = new ManagerLink(() => ({
      type: 'hello', sessionId: this.session, launcherPid: process.pid, meta: this.meta,
      launch: { proxyServer: cmd.launch.proxyServer, viewport: cmd.launch.viewport, acceptInsecureCerts: cmd.launch.acceptInsecureCerts },
    }));
    this.link.onHold = hold => this.setHold(hold);
    // Claude Code: the note appears in the session like a new message. A channel
    // (opted in with the development flag) wins over the inbox socket.
    this.link.onFeedbackPush = content => {
      if (this.meta.channel) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content, meta: { kind: 'feedback' } } }) + '\n');
        log('feedback pushed as channel event');
      } else if (this.meta.inbox) {
        void postToInbox(content);
      } else if (this.codexBin && this.meta.agentSessionId) {
        void postToCodexQueue(this.codexBin, this.meta.agentSessionId, content);
      }
    };
    this.link.onFeedback = m => this.finishFeedback(m.requestId, [
      { type: 'text', text: `${m.text}\n\n${FEEDBACK_FOLLOW_UP}` },
      ...m.images.map(data => ({ type: 'image', data, mimeType: 'image/png' })),
    ]);
  }

  async start(): Promise<void> {
    log(`session ${this.session} cwd=${this.meta.cwd} client=${this.meta.client ?? '?'} agentSession=${this.meta.agentSessionId ?? '-'} cmd=${this.original.join(' ')}`);
    this.forwardPort = await this.startForwarder();
    this.link.start();
    this.spawnChild();
    this.pumps();
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(sig, () => this.shutdown(`signal ${sig}`, 128 + (sig === 'SIGINT' ? 2 : sig === 'SIGHUP' ? 1 : 15)));
    }
  }

  /** Local port given to the server as --browserUrl. 127.0.0.1 only. */
  private startForwarder(): Promise<number> {
    const server = net.createServer(client => {
      client.pause();
      client.on('error', () => {});
      this.link.attach().then(port => {
        const upstream = net.connect(port, '127.0.0.1', () => {
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      }).catch(e => {
        log(`attach failed: ${e.message}`);
        client.destroy();
      });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  }

  private spawnChild(): void {
    const serverArgs = rewriteServerArgs(this.cmd.serverArgs, `http://127.0.0.1:${this.forwardPort}`,
      sanitizeConfig(this.cmd.serverArgs, path.join(paths.home, 'tmp')));
    const argv = [...this.cmd.runner, ...serverArgs];
    log(`child: ${argv.join(' ')}`);
    this.child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'],
      // Own process group, so the whole tree (npx -> node) can be signaled.
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32',
    });
    this.child.on('error', e => {
      process.stderr.write(`habitab: cannot start ${argv[0]}: ${e.message}\n`);
      this.shutdown('spawn failed', 127);
    });
    this.child.on('exit', code => {
      log(`child exited code=${code}`);
      setTimeout(() => this.shutdown('server exited', code ?? 0), 100);
    });
  }

  private pumps(): void {
    lines(process.stdin, line => { if (!this.inspectClient(line)) this.child.stdin?.write(line); });
    process.stdin.on('end', () => {
      log('stdin EOF');
      this.child.stdin?.end();
      // chrome-devtools-mcp exits on stdin EOF; signal it if it does not.
      setTimeout(() => this.shutdown('client closed stdin', 0), 3000).unref();
    });
    lines(this.child.stdout!, line => process.stdout.write(this.inspectServer(line) ?? line));
  }

  /** Returns true when the line does not go to the server (held back, or answered here). */
  private inspectClient(line: Buffer): boolean {
    let hold = false;
    const msgs = parse(line);
    // Habitab's own tool, answered by the launcher; never held back.
    if (msgs.length === 1 && msgs[0].method === 'tools/call' && msgs[0].params?.name === FEEDBACK_TOOL.name) {
      this.requestFeedback(msgs[0]);
      return true;
    }
    for (const msg of msgs) {
      if (msg.method === 'tools/list' && idKey(msg.id)) this.toolsListIds.add(idKey(msg.id)!);
      if (msg.method === 'notifications/cancelled') this.cancelFeedback(idKey(msg.params?.requestId));
      if (msg.method === 'initialize') {
        this.initializeId = idKey(msg.id);
        const info = msg.params?.clientInfo ?? {};
        this.meta.clientName = info.name;
        this.meta.clientVersion = info.version;
        const name = String(info.name ?? '').toLowerCase();
        const client = KNOWN_CLIENTS.find(c => name.includes(c));
        if (client) { this.meta.client = client; this.meta.clientSource = 'clientInfo'; }
        if (this.meta.client === 'claude') {
          this.meta.channel = channelEnabled();
          this.meta.inbox = !!process.env.CLAUDE_CODE_MESSAGING_SOCKET;
        }
        if (this.meta.client === 'codex') void codexQueueCommand().then(bin => {
          if (!bin) return;
          this.codexBin = bin;
          this.meta.codexQueue = true;
          this.link.sendMeta(this.meta);
        });
        log(`initialize clientInfo=${JSON.stringify(info)}`);
        this.link.sendMeta(this.meta);
      } else if (msg.method === 'tools/call') {
        const key = idKey(msg.id);
        const tool = msg.params?.name ?? '?';
        this.applyCallMeta(msg.params?._meta);
        this.refreshClaudeSession();
        if (key) {
          this.inflight.set(key, { tool, start: Date.now() });
          this.link.send({ type: 'toolStart', callId: key, tool, summary: summarize(msg.params?.arguments ?? {}) });
        }
        if (this.held) { this.heldLines.push(line); hold = true; }
      } else if (msg.method === undefined && msg.id !== undefined) {
        // Client answer to a server request, e.g. roots/list.
        const key = idKey(msg.id);
        if (key && this.rootsRequests.delete(key) && Array.isArray(msg.result?.roots)) {
          this.meta.roots = msg.result.roots.map((r: any) => r.uri).filter(Boolean);
          this.link.sendMeta(this.meta);
        }
      }
    }
    return hold;
  }

  /** Returns a replacement line when Habitab adds something to the server's answer. */
  private inspectServer(line: Buffer): Buffer | undefined {
    for (const msg of parse(line)) {
      const key = idKey(msg.id);
      if (!key) continue;
      if (this.toolsListIds.delete(key) && Array.isArray(msg.result?.tools) && !Array.isArray(JSON.parse(line.toString('utf8')))) {
        msg.result.tools.push(FEEDBACK_TOOL);
        return Buffer.from(JSON.stringify(msg) + '\n');
      }
      if (key === this.initializeId && msg.result && !Array.isArray(JSON.parse(line.toString('utf8')))) {
        this.initializeId = undefined;
        // Claude Code: also a channel, so feedback can arrive while no tool call waits.
        if (this.meta.client === 'claude') {
          msg.result.capabilities = { ...msg.result.capabilities, experimental: { ...msg.result.capabilities?.experimental, 'claude/channel': {} } };
        }
        const own = msg.result.instructions;
        msg.result.instructions = (typeof own === 'string' && own ? own + '\n\n' : '') + INSTRUCTIONS;
        return Buffer.from(JSON.stringify(msg) + '\n');
      }
      if (msg.method === 'roots/list') { this.rootsRequests.add(key); continue; }
      const call = this.inflight.get(key);
      if (!call || msg.method) continue;
      this.inflight.delete(key);
      const isError = !!msg.error || !!msg.result?.isError;
      const detail = isError ? String(msg.error?.message ?? msg.result?.content?.[0]?.text ?? '').slice(0, 300) : undefined;
      this.link.send({ type: 'toolEnd', callId: key, tool: call.tool, isError, durationMs: Date.now() - call.start, detail });
    }
  }

  /** Codex sends _meta.threadId with every tools/call. */
  private applyCallMeta(m: any): void {
    const thread = m?.threadId ?? m?.sessionId;
    if (typeof thread !== 'string' || thread === this.meta.agentSessionId) return;
    this.meta.agentSessionId = thread;
    this.meta.agentSessionSource = m.threadId ? 'mcp-meta-threadId' : 'mcp-meta-sessionId';
    this.meta.agentSessionName = codexThreadName(thread);
    this.link.sendMeta(this.meta);
  }

  /** After /clear, Claude Code goes on with a new session id. */
  private refreshClaudeSession(): void {
    if (this.meta.client !== 'claude' || Date.now() - this.lastClaudeCheck < 30_000) return;
    this.lastClaudeCheck = Date.now();
    if (applyClaudeSessionFile(this.meta, true)) this.link.sendMeta(this.meta);
  }

  // MARK: wait_for_user_feedback

  private requestFeedback(msg: any): void {
    const key = idKey(msg.id);
    if (!key) return;
    const args = msg.params?.arguments ?? {};
    if (!this.link.connected) {
      const content = [{ type: 'text', text: 'The Habitab app is not running, so the user cannot answer here.' }];
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content, isError: true } }) + '\n');
      return;
    }
    const question = typeof args.question === 'string' ? args.question.slice(0, 500) : undefined;
    const seconds = Math.min(3600, Math.max(10, Number(args.timeout_seconds) || 600));
    const timer = setTimeout(() => {
      this.link.send({ type: 'feedbackCancel', requestId: key });
      this.finishFeedback(key, [{ type: 'text', text: `The user gave no feedback within ${seconds} s.` }]);
    }, seconds * 1000);
    this.feedback.set(key, { id: msg.id, timer });
    this.inflight.set(key, { tool: FEEDBACK_TOOL.name, start: Date.now() });
    this.link.send({ type: 'toolStart', callId: key, tool: FEEDBACK_TOOL.name, summary: question });
    this.link.send({ type: 'feedbackRequest', requestId: key, question });
  }

  private finishFeedback(key: string, content: object[]): void {
    const f = this.feedback.get(key);
    if (!f) return;
    this.feedback.delete(key);
    clearTimeout(f.timer);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { content } }) + '\n');
    const call = this.inflight.get(key);
    this.inflight.delete(key);
    this.link.send({ type: 'toolEnd', callId: key, tool: FEEDBACK_TOOL.name, isError: false, durationMs: Date.now() - (call?.start ?? Date.now()) });
  }

  /** The client gave up on the call (MCP cancellation): no answer is sent. */
  private cancelFeedback(key: string | undefined): void {
    const f = key && this.feedback.get(key);
    if (!f) return;
    this.feedback.delete(key!);
    clearTimeout(f.timer);
    this.inflight.delete(key!);
    this.link.send({ type: 'feedbackCancel', requestId: key! });
    this.link.send({ type: 'toolEnd', callId: key!, tool: FEEDBACK_TOOL.name, isError: false, durationMs: 0 });
  }

  private setHold(hold: boolean): void {
    this.held = hold;
    clearTimeout(this.heldTimer);
    if (hold) {
      // Never block an agent forever.
      this.heldTimer = setTimeout(() => { this.setHold(false); this.link.send({ type: 'hold', hold: false }); }, 10 * 60_000).unref();
    } else {
      for (const l of this.heldLines.splice(0)) this.child.stdin?.write(l);
    }
    log(`hold=${hold}`);
  }

  private shutdown(reason: string, code: number): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log(`shutdown: ${reason}`);
    const pid = this.child?.pid;
    if (pid && this.child.exitCode === null) {
      try { process.platform === 'win32' ? this.child.kill() : process.kill(-pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.platform === 'win32' ? this.child.kill('SIGKILL') : process.kill(-pid, 'SIGKILL'); } catch {} }, 2000).unref();
    }
    this.link.close(reason);
    setTimeout(() => process.exit(code), 150);
  }
}

/**
 * Habitab's own tool, added to the server's tool list. The user marks an area
 * of the page in Habitab and writes a comment; the result has the comment,
 * the page, the elements in the area and the area as an image.
 */
const FEEDBACK_TOOL = {
  name: 'wait_for_user_feedback',
  description: 'Asks the user to point at something in the browser. Habitab shows your question; the user marks an area of the page and writes a comment. ' +
    'Returns the comment, the page URL, the HTML elements in the marked area and the area as an image. ' +
    'The user can also send console errors and failed requests of the page from Habitab\'s problem list; these come as text. ' +
    'Waits until the user answers or the timeout ends. Use it when visual feedback from the user helps, for example "Which element do you mean?" or "What should change here?".',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'What you want to know. Shown to the user in Habitab.' },
      timeout_seconds: { type: 'number', description: 'How long to wait (10 to 3600 s, default 600).' },
    },
  },
};

/**
 * Claude Code delivers channel events only when it was started with
 * `--dangerously-load-development-channels server:<name>` (research preview;
 * Habitab is not on the allowlist). Without it, events are dropped silently,
 * so the launcher checks the client's command line.
 */
function channelEnabled(): boolean {
  if (process.platform === 'win32') return false;
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8' });
    return /--dangerously-load-development-channels\s+\S*server:/.test(args);
  } catch { return false; }
}

/**
 * Posts a message into the Claude Code session through its inbox socket
 * (cross-session messaging, CLAUDE_CODE_MESSAGING_SOCKET): an idle session
 * starts a new turn with it, a busy one reads it between tool calls. The
 * launcher is a child of the claude process, so the session accepts it
 * without asking the user. The socket is documented, the line format only in
 * Claude Code's debug log (measured with 2.1.296).
 */
function postToInbox(text: string): Promise<boolean> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  return new Promise(resolve => {
    if (!socketPath) return resolve(false);
    let answer = '', finished = false;
    const socket = net.connect(socketPath);
    const done = (ok: boolean, why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      log(`feedback pushed to the Claude Code inbox: ${why}${answer.trim() ? ` (${answer.trim().slice(0, 300)})` : ''}`);
      resolve(ok);
    };
    const timer = setTimeout(() => done(true, 'sent'), 3000);
    socket.setEncoding('utf8');
    socket.on('data', d => { answer += d; });
    socket.once('error', e => done(false, `failed: ${e.message}`));
    socket.once('close', () => done(true, 'sent'));
    socket.once('connect', () => {
      if (token) socket.write(JSON.stringify({ type: 'auth', token }) + '\n');
      socket.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      socket.end();
    });
  });
}

/**
 * The codex executable of the client, if it has `codex queue` (Codex 0.162+).
 * Only the parent process counts, so the command matches the running Codex.
 * HABITAB_CODEX_COMMAND replaces it (tests).
 */
function codexQueueCommand(): Promise<string | undefined> {
  const parent = processExecutable(process.ppid);
  const bin = process.env.HABITAB_CODEX_COMMAND || (parent && /^codex/i.test(path.basename(parent)) ? parent : undefined);
  return new Promise(resolve => {
    if (!bin) return resolve(undefined);
    execFile(bin, ['queue', '--help'], { timeout: 10_000 }, err => {
      log(`codex queue ${err ? 'not available' : 'available'} (${bin})`);
      resolve(err ? undefined : bin);
    });
  });
}

/**
 * Queues a prompt for the Codex thread with `codex queue`: an idle session
 * starts a new turn with it, a busy one takes it after the current turn.
 */
function postToCodexQueue(bin: string, thread: string, text: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(bin, ['queue', '--thread', thread, '--message', text], { timeout: 30_000 }, (err, stdout, stderr) => {
      log(`feedback queued for Codex thread ${thread}: ${err ? `failed (${(stderr || err.message).trim().slice(0, 300)})` : stdout.trim().slice(0, 200)}`);
      resolve(!err);
    });
  });
}

/**
 * Appended to every answer. Without it, agents ask in Habitab whether the
 * change is right and wait there; the user sends more feedback on their own.
 */
const FEEDBACK_FOLLOW_UP = 'Act on this feedback and report in your session as usual. Do not call wait_for_user_feedback again to ask whether it is right: ' +
  'the user sends more feedback on their own when needed.';

/** Clients recognized by their MCP clientInfo name (the sidebar shows their icon). */
const KNOWN_CLIENTS = ['claude', 'codex', 'opencode', 'cursor', 'gemini', 'windsurf'];

/**
 * Added to the server's MCP instructions. The user sees the session's tabs in
 * Habitab without numbers; chrome-devtools-mcp's page ids only count up.
 */
const INSTRUCTIONS = `This browser runs inside Habitab. The user sees this session's tabs in Habitab's sidebar, listed by title, without numbers. \
The pageId values of this server are internal: they keep counting up and do not match anything the user sees. \
When you tell the user about a page, name it by its title or URL (for example "the tab with http://localhost:5180/"), never by its pageId or as "tab N".

The user can point at things in this browser: call wait_for_user_feedback (with a short question) whenever you need the user to show you something on the page, \
for example when a request is about "this button", "here" or "that area", or when it is unclear which element is meant. \
The user marks an area and writes a comment; you get the comment, the elements in the area and a screenshot of it. Prefer this over asking for a description in the chat. \
The user can also mark an area or send console errors and failed requests on their own: then a short event says so, and calling wait_for_user_feedback returns the details at once.`;

function idKey(id: unknown): string | undefined {
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  return undefined;
}

function parse(line: Buffer): any[] {
  try {
    const v = JSON.parse(line.toString('utf8'));
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}

function summarize(args: Record<string, unknown>): string | undefined {
  for (const k of ['url', 'uid', 'key', 'text', 'function', 'filePath']) {
    // Scripts a little longer: the timeline shows them when the user opens a change's calls.
    if (typeof args[k] === 'string') return (args[k] as string).slice(0, k === 'function' ? 1000 : 120);
  }
  return undefined;
}

/** Calls `fn` with every newline-terminated chunk (newline included). */
function lines(stream: NodeJS.ReadableStream, fn: (line: Buffer) => void): void {
  let buffer: Buffer = Buffer.alloc(0);
  stream.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let i: number;
    while ((i = buffer.indexOf(10)) >= 0) {
      fn(buffer.subarray(0, i + 1));
      buffer = buffer.subarray(i + 1);
    }
  });
  stream.on('end', () => { if (buffer.length) fn(buffer); });
}
