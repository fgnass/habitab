// Per-session CDP endpoint. chrome-devtools-mcp connects to it like to a
// normal Chrome and sees only the tabs of its session (one Electron
// partition = one CDP browser context).
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const PRIVATE_ID = 1_000_000_000;

export interface ProxyHooks {
  sessionId: string;
  browserContextId: string;
  upstreamUrl: () => string;
  createTab: (url: string) => Promise<string>;
  closeTab: (targetId: string) => Promise<boolean>;
  tabSize: (targetId: string) => { width: number; height: number };
  resizeTab: (targetId: string, width: number, height: number) => void;
  /** Agent input (Input.*) to a tab starts (+1) or got its answer (-1). */
  agentInput: (targetId: string, delta: 1 | -1) => void;
  /** The agent set (params) or cleared (null) device emulation of a tab. */
  agentEmulation: (targetId: string, params: any) => void;
  /** The agent brings a tab to the front: show it in its session, never raise the window. */
  activateTab: (targetId: string) => void;
}

export class SessionProxy {
  private server = http.createServer((req, res) => void this.http(req, res));
  private wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
  private sockets = new Set<WebSocket>();
  port = 0;

  constructor(private hooks: ProxyHooks) {
    this.server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith(`/devtools/browser/${hooks.sessionId}`)) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, ws => this.connection(ws));
    });
  }

  listen(): Promise<number> {
    return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => {
      this.port = (this.server.address() as any).port;
      resolve(this.port);
    }));
  }

  close(): void {
    for (const s of this.sockets) s.close();
    this.wss.close();
    this.server.close();
  }

  private upstreamHttp(): string {
    return this.hooks.upstreamUrl().replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '');
  }

  private async http(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    try {
      // The ws URL uses the Host the client used, so the WebSocket also
      // goes through the launcher's port.
      const host = /^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(req.headers.host ?? '') ? req.headers.host : `127.0.0.1:${this.port}`;
      if (req.url === '/json/version') {
        const v = await (await fetch(this.upstreamHttp() + '/json/version')).json() as Record<string, string>;
        return send({ ...v, webSocketDebuggerUrl: `ws://${host}/devtools/browser/${this.hooks.sessionId}` });
      }
      if (req.url === '/json/list' || req.url === '/json') {
        const list = await (await fetch(this.upstreamHttp() + '/json/list')).json() as { id: string }[];
        const own = await this.ownTargetIds();
        return send(list.filter(t => own.has(t.id)));
      }
    } catch {}
    res.statusCode = 404;
    res.end();
  }

  /** Target ids of this session according to the browser itself. */
  ownTargetIds(): Promise<Set<string>> {
    return new Promise(resolve => {
      const ws = new WebSocket(this.hooks.upstreamUrl(), { perMessageDeflate: false });
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })));
      ws.on('message', d => {
        const m = JSON.parse(String(d));
        if (m.id !== 1) return;
        ws.close();
        resolve(new Set((m.result?.targetInfos ?? []).filter((t: any) => t.browserContextId === this.hooks.browserContextId).map((t: any) => t.targetId)));
      });
      ws.on('error', () => resolve(new Set()));
    });
  }

  private connection(client: WebSocket): void {
    const h = this.hooks;
    this.sockets.add(client);
    const upstream = new WebSocket(h.upstreamUrl(), { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    const queue: string[] = [];
    const ownTargets = new Set<string>();
    const ownSessions = new Map<string, string>();   // CDP session id -> target id
    const foreignSessions = new Set<string>();
    const windowIds = new Map<number, string>();     // emulated window id -> target id
    const filters = new Map<number, (m: any) => any>();
    let privateId = PRIVATE_ID;

    const toClient = (m: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(m)); };
    const toUpstream = (m: unknown) => {
      const s = JSON.stringify(m);
      upstream.readyState === WebSocket.OPEN ? upstream.send(s) : queue.push(s);
    };
    const own = (info: any) => info?.browserContextId === h.browserContextId;
    const reply = (id: number, result: unknown, sessionId?: string) => toClient(sessionId ? { id, result, sessionId } : { id, result });
    const fail = (id: number, message: string, sessionId?: string) => toClient({ id, error: { code: -32000, message }, ...(sessionId ? { sessionId } : {}) });
    const isOwnTarget = async (t?: string) => !!t && (ownTargets.has(t) || (await this.ownTargetIds()).has(t));
    const windowIdFor = (t: string) => {
      for (const [w, x] of windowIds) if (x === t) return w;
      windowIds.set(windowIds.size + 1, t);
      return windowIds.size;
    };

    upstream.on('open', () => { for (const m of queue.splice(0)) upstream.send(m); });
    upstream.on('close', () => client.close());
    upstream.on('error', () => client.close());
    client.on('close', () => { this.sockets.delete(client); upstream.close(); });

    upstream.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id >= PRIVATE_ID) return;
      if (msg.sessionId && foreignSessions.has(msg.sessionId)) return;
      if (msg.id !== undefined) {
        const f = filters.get(msg.id);
        filters.delete(msg.id);
        return toClient(f ? f(msg) : msg);
      }
      const p = msg.params ?? {};
      switch (msg.method) {
        case 'Target.targetCreated':
        case 'Target.targetInfoChanged':
          if (!own(p.targetInfo)) return;
          ownTargets.add(p.targetInfo.targetId);
          break;
        case 'Target.targetDestroyed':
        case 'Target.targetCrashed':
          if (!ownTargets.has(p.targetId)) return;
          break;
        case 'Target.attachedToTarget':
          if (!own(p.targetInfo)) {
            // Another session's (or the app's) target: let it run, detach at once.
            foreignSessions.add(p.sessionId);
            if (p.waitingForDebugger) toUpstream({ id: privateId++, method: 'Runtime.runIfWaitingForDebugger', sessionId: p.sessionId });
            toUpstream({ id: privateId++, method: 'Target.detachFromTarget', params: { sessionId: p.sessionId }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
            return;
          }
          ownTargets.add(p.targetInfo.targetId);
          ownSessions.set(p.sessionId, p.targetInfo.targetId);
          break;
        case 'Target.detachedFromTarget':
          if (foreignSessions.delete(p.sessionId)) return;
          ownSessions.delete(p.sessionId);
          break;
      }
      toClient(msg);
    });

    // Commands are handled strictly in order; some need an async check.
    let chain = Promise.resolve();
    client.on('message', data => { chain = chain.then(() => handle(String(data))).catch(() => {}); });

    const handle = async (raw: string) => {
      const msg = JSON.parse(raw);
      const { id, method, params = {}, sessionId } = msg;
      if (sessionId && foreignSessions.has(sessionId)) return fail(id, 'Session not found', sessionId);

      // Mark synthetic input, so the app can tell it from the user's own.
      const inputTarget = typeof method === 'string' && method.startsWith('Input.') && sessionId ? ownSessions.get(sessionId) : undefined;
      if (inputTarget) {
        h.agentInput(inputTarget, 1);
        filters.set(id, m => { h.agentInput(inputTarget, -1); return m; });
      }
      // Electron would activate the app window for these; the user may work elsewhere.
      if (method === 'Page.bringToFront' && sessionId && ownSessions.has(sessionId)) {
        h.activateTab(ownSessions.get(sessionId)!);
        return reply(id, {}, sessionId);
      }
      // Device emulation is shared with the user's responsive mode.
      if ((method === 'Emulation.setDeviceMetricsOverride' || method === 'Emulation.clearDeviceMetricsOverride') && sessionId && ownSessions.has(sessionId)) {
        const t = ownSessions.get(sessionId)!;
        filters.set(id, m => { if (!m.error) h.agentEmulation(t, method === 'Emulation.clearDeviceMetricsOverride' ? null : params); return m; });
      }

      // Electron has no browser window per tab. Window calls map to the
      // embedded view of the tab; setContentsSize sets its exact size.
      if (method === 'Browser.setContentsSize' || (typeof method === 'string' && method.startsWith('Browser.') && method.includes('Window'))) {
        const targetId: string | undefined = params.targetId ?? (sessionId ? ownSessions.get(sessionId) : undefined) ?? windowIds.get(params.windowId);
        const bounds = () => ({ left: 0, top: 0, ...h.tabSize(windowIds.get(params.windowId) ?? targetId ?? ''), windowState: 'normal' });
        switch (method) {
          case 'Browser.getWindowForTarget':
            if (!(await isOwnTarget(targetId))) return fail(id, 'No target with given id found', sessionId);
            return reply(id, { windowId: windowIdFor(targetId!), bounds: bounds() }, sessionId);
          case 'Browser.getWindowBounds': return reply(id, { bounds: bounds() }, sessionId);
          case 'Browser.setWindowBounds': return reply(id, {}, sessionId);
          case 'Browser.setContentsSize': {
            const t = windowIds.get(params.windowId);
            if (!t) return fail(id, 'Browser window not found', sessionId);
            h.resizeTab(t, params.width, params.height);
            return reply(id, {}, sessionId);
          }
        }
      }
      if (!sessionId) {
        switch (method) {
          case 'Target.createTarget':
            try { return reply(id, { targetId: await h.createTab(params.url || 'about:blank') }); }
            catch (e: any) { return fail(id, String(e?.message ?? e)); }
          case 'Target.closeTarget':
            if (!(await isOwnTarget(params.targetId))) return fail(id, 'No target with given id found');
            return reply(id, { success: await h.closeTab(params.targetId) });
          case 'Target.activateTarget':
            if (!(await isOwnTarget(params.targetId))) return fail(id, 'No target with given id found');
            h.activateTab(params.targetId);
            return reply(id, {});
          case 'Target.attachToTarget':
          case 'Target.getTargetInfo':
            if (params.targetId && !(await isOwnTarget(params.targetId))) return fail(id, 'No target with given id found');
            break;
          case 'Target.getTargets':
            filters.set(id, m => (m.result ? { ...m, result: { targetInfos: m.result.targetInfos.filter(own) } } : m));
            break;
          case 'Target.getBrowserContexts':
            // The session's context appears as the default context.
            return reply(id, { browserContextIds: [], defaultBrowserContextId: h.browserContextId });
          case 'Target.createBrowserContext':
          case 'Target.disposeBrowserContext':
            return fail(id, 'Not supported in Habitab sessions');
          case 'Browser.close':
          case 'Browser.crash':
            return reply(id, {});
        }
      }
      toUpstream(msg);
    };
  }
}
