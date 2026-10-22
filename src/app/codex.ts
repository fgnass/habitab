// Codex's app-server daemon (Codex 0.163 and newer): JSON-RPC over a
// WebSocket on its unix control socket. Browser bridge sessions of Codex need
// it: their MCP server is a child of the daemon, not of the thread, so the
// thread is found by its working directory among the daemon's threads.
// Subscribed to a thread (thread/resume), the app gets its tool calls
// (item/started, item/completed) and can give it feedback as a user message
// (turn/steer while a turn runs, else turn/start).
//
// Measured with Codex 0.163.0: thread/status/changed reaches every client,
// items only subscribed ones; thread/resume subscribes without taking the
// thread from its client. The protocol is marked experimental.
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { log } from '../shared/paths';
import { codexHome } from '../shared/session-info';

export interface CodexItem {
  id: string;
  type: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  status?: string;
  durationMs?: number;
  error?: unknown;
}

export interface ThreadHandlers {
  itemStarted: (item: CodexItem) => void;
  itemCompleted: (item: CodexItem) => void;
}

export interface CodexThread { id: string; name?: string; status?: string }

export class CodexAppServer {
  private ws?: WebSocket;
  private connecting?: Promise<boolean>;
  private next = 1;
  private pending = new Map<number, (m: any) => void>();
  private handlers = new Map<string, ThreadHandlers>();
  private status = new Map<string, string>();

  constructor(private version: string) {}

  socketPath(): string { return path.join(codexHome(), 'app-server-control', 'app-server-control.sock'); }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  private connect(): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    this.connecting ??= new Promise<boolean>(resolve => {
      const sock = this.socketPath();
      if (!fs.existsSync(sock)) return resolve(false);
      const ws = new WebSocket(`ws+unix://${sock}:/`);
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      ws.on('open', async () => {
        this.ws = ws;
        const r = await this.request('initialize', { clientInfo: { name: 'habitab', title: 'Habitab', version: this.version }, capabilities: {} });
        if (r?.error) { log(`codex app-server: initialize failed: ${JSON.stringify(r.error)}`); ws.close(); return done(false); }
        this.notify('initialized', {});
        log(`codex app-server connected (${sock})`);
        // Subscriptions belong to a connection: renew them after a reconnect.
        for (const threadId of this.handlers.keys()) void this.request('thread/resume', { threadId });
        done(true);
      });
      ws.on('message', d => this.onMessage(String(d)));
      ws.on('close', () => {
        if (this.ws === ws) this.ws = undefined;
        for (const cb of this.pending.values()) cb({ error: { message: 'connection closed' } });
        this.pending.clear();
        done(false);
      });
      ws.on('error', e => { log(`codex app-server: ${e.message}`); done(false); });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && this.pending.has(m.id)) {
      this.pending.get(m.id)!(m);
      this.pending.delete(m.id);
      return;
    }
    // Requests of the daemon (approvals and the like) are for the thread's own client, never answered here.
    if (m.id !== undefined) return;
    const p = m.params ?? {};
    switch (m.method) {
      case 'thread/status/changed':
        if (p.threadId) this.status.set(p.threadId, p.status?.type ?? 'unknown');
        break;
      case 'item/started':
        if (p.item) this.handlers.get(p.threadId)?.itemStarted(p.item);
        break;
      case 'item/completed':
        if (p.item) this.handlers.get(p.threadId)?.itemCompleted(p.item);
        break;
    }
  }

  private notify(method: string, params: unknown): void {
    this.ws?.send(JSON.stringify({ method, params }));
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ error: { message: 'not connected' } });
    const id = this.next++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: `timeout ${method}` } }); }, timeoutMs);
      this.pending.set(id, m => { clearTimeout(timer); resolve(m); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * The thread that works in `cwd`: the active one, else the most recently
   * updated. Codex lists a thread once it is persisted (after its first turn),
   * which is the case while it calls a tool.
   */
  async resolveThread(cwd: string): Promise<CodexThread | undefined> {
    if (!(await this.connect())) return undefined;
    const list = async (params: object) => ((await this.request('thread/list', { limit: 20, sortKey: 'updated_at', sortDirection: 'desc', ...params }))?.result?.data ?? []) as any[];
    let threads = await list({ cwd });
    // The daemon may know the directory under another name (symlinks, /private on macOS).
    if (!threads.length) threads = (await list({})).filter(t => sameDir(t.cwd, cwd));
    const pick = threads.find(t => t.status?.type === 'active') ?? threads[0];
    if (!pick) return undefined;
    return { id: pick.id, name: typeof pick.name === 'string' && pick.name ? pick.name : undefined, status: pick.status?.type };
  }

  /** Follows the thread's items. The daemon keeps the thread with its own client. */
  async subscribe(threadId: string, handlers: ThreadHandlers): Promise<boolean> {
    this.handlers.set(threadId, handlers);
    if (!(await this.connect())) return false;
    const r = await this.request('thread/resume', { threadId });
    if (r?.error) log(`codex app-server: thread/resume ${threadId} failed: ${JSON.stringify(r.error)}`);
    return !r?.error;
  }

  async unsubscribe(threadId: string): Promise<void> {
    if (!this.handlers.delete(threadId)) return;
    if (this.connected) await this.request('thread/unsubscribe', { threadId });
  }

  /** Feedback as a user message: into the running turn, or as a new turn when the thread is idle. */
  async push(threadId: string, text: string, imagePaths: string[] = []): Promise<boolean> {
    if (!(await this.connect())) return false;
    const input = [{ type: 'text', text }, ...imagePaths.map(path => ({ type: 'localImage', path }))];
    const read = await this.request('thread/read', { threadId, includeTurns: true });
    const thread = read?.result?.thread;
    const active = (thread?.status?.type ?? this.status.get(threadId)) === 'active';
    // turn/steer names the turn it steers: the running one, which is the last.
    const turns: any[] = Array.isArray(thread?.turns) ? thread.turns : [];
    const running = turns.filter(t => !/^(completed|failed|interrupted|cancelled)$/.test(String(t.status ?? ''))).at(-1) ?? turns.at(-1);
    let r = active && running?.id ? await this.request('turn/steer', { threadId, expectedTurnId: running.id, input }) : undefined;
    if (!r || r.error) r = await this.request('turn/start', { threadId, input });
    log(`feedback ${r?.error ? 'not ' : ''}pushed to Codex thread ${threadId} (${active ? 'steer' : 'start'})${r?.error ? `: ${JSON.stringify(r.error)}` : ''}`);
    return !r?.error;
  }
}

function sameDir(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const real = (d: string) => { try { return fs.realpathSync(d); } catch { return d; } };
  return a === b || real(a) === real(b);
}

/** The chrome-devtools-mcp tools, for the items that count as the browser's work. */
export const BROWSER_TOOLS = new Set(['click', 'click_at', 'drag', 'fill', 'fill_form', 'handle_dialog', 'hover', 'press_key', 'type_text', 'upload_file',
  'close_page', 'list_pages', 'navigate_page', 'new_page', 'select_page', 'wait_for', 'emulate', 'resize_page',
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'get_network_request', 'list_network_requests',
  'evaluate_script', 'get_console_message', 'get_css_styles', 'lighthouse_audit', 'list_console_messages', 'screencast_start', 'screencast_stop',
  'take_screenshot', 'take_snapshot', 'take_heapsnapshot']);

export function isBrowserTool(item: CodexItem): boolean {
  return item.type === 'mcpToolCall' && !!item.tool && (BROWSER_TOOLS.has(item.tool) || /chrome|devtools|browser|habitab/i.test(item.server ?? ''));
}

/** A short summary of a tool call's arguments (the url, element, key, text or script). */
export function summarizeArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const k of ['url', 'uid', 'key', 'text', 'value', 'function', 'filePath']) {
    if (typeof a[k] === 'string') return (a[k] as string).slice(0, k === 'function' ? 1000 : 120);
  }
  return undefined;
}

export function itemError(item: CodexItem): string | undefined {
  if (item.status === 'failed' || item.error) {
    const e: any = item.error;
    return String(e?.message ?? (typeof e === 'string' ? e : item.status === 'failed' ? 'failed' : '')).slice(0, 300) || undefined;
  }
  return undefined;
}
