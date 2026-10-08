// Sessions: one per launcher (= MCP connection). Each session has its own
// partition (cookies, storage, cache), its tabs as embedded Chromium views,
// an optional docked DevTools view and a CDP proxy. Partitions live in
// memory, except for projects with a persistent profile (on disk).
import crypto from 'node:crypto';
import { BaseWindow, Menu, MenuItemConstructorOptions, session as electronSession, shell, WebContents, WebContentsView, clipboard } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isSessionId, LineSocket, Message, SessionMeta } from '../shared/ipc';
import { log, paths } from '../shared/paths';
import { isAlive } from '../shared/platform';
import { prefs, setPrefs } from './prefs';
import { SessionProxy } from './proxy';

/**
 * Device emulation of a tab (responsive mode). Chromium keeps one override per
 * page, so the user's and the agent's settings replace each other: the last
 * one counts. `scale` is what is applied now (zoom "fit" depends on the space).
 */
export interface Emulation {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  zoom: 'fit' | number;
  preset?: string;
  /** Width / height follow the space next to the bar (responsive mode default). */
  fillWidth?: boolean;
  fillHeight?: boolean;
  by: 'user' | 'agent';
  scale?: number;
  /** The override last sent (width, height, scale), to send again only on change. */
  applied?: string;
}

export interface Tab {
  id: number;
  view: WebContentsView;
  targetId: string;
  fixedSize?: { width: number; height: number };
  emulation?: Emulation;
  /** Where the emulated page sits inside the content area (for the resize handles). */
  frame?: { x: number; y: number; width: number; height: number; scale: number };
  /** Agent input in flight through the CDP proxy, and when it last changed. */
  agentInputs: number;
  agentInputAt: number;
}

export interface Activity { tool: string; summary?: string; start: number; durationMs?: number; isError?: boolean; detail?: string; }

export interface Session {
  id: string;
  meta: SessionMeta;
  launch: { proxyServer?: string; viewport?: string; acceptInsecureCerts?: boolean };
  launcherPid?: number;
  line?: LineSocket;
  ended: boolean;
  endedAt?: number;
  endReason?: string;
  partition: string;
  ctx?: string;
  tabs: Tab[];
  active?: Tab;
  proxy?: SessionProxy;
  devtools?: WebContentsView;
  devtoolsTab?: Tab;
  currentTool?: Activity;
  lastActivity?: number;
  activity: Activity[];
  held: boolean;
  /** Set while the user has control automatically; then it ends by itself. */
  autoResumeAt?: number;
  resumeTimer?: NodeJS.Timeout;
  pinned: boolean;
  lastInteraction?: number;
  /** The agent waits in wait_for_user_feedback for the user to mark an area. */
  feedback?: { requestId: string; question?: string; since: number };
  /** Marked areas while no agent was waiting; the next wait_for_user_feedback gets them at once. */
  feedbackQueue: { text: string; image?: string }[];
  /** Small JPEG of the active tab for the sidebar (data URL). */
  thumb?: string;
  thumbTimer?: NodeJS.Timeout;
  protectedBy?: string;
  starting?: Promise<void>;
}

/** User input takes control automatically; this long without input gives it back. */
const AUTO_RESUME_MS = Number(process.env.HABITAB_AUTO_RESUME_MS) || 10_000;

const PROTECTING_TOOLS: Record<string, string | null> = {
  performance_start_trace: 'Performance trace running', performance_stop_trace: null,
  screencast_start: 'Screencast running', screencast_stop: null,
};

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  selected?: string;
  onChange: () => void = () => {};
  onLayout: () => void = () => {};
  onThumb: (s: Session) => void = () => {};
  private configured = new WeakSet<Electron.Session>();
  private server?: net.Server;

  constructor(private win: BaseWindow, private upstreamUrl: () => string) {}

  // MARK: Launcher connections

  listen(): void {
    const sock = paths.socket;
    if (process.platform !== 'win32') try { fs.unlinkSync(sock); } catch {}
    this.server = net.createServer(socket => this.accept(new LineSocket(socket)));
    const old = process.umask(0o077);
    this.server.listen(sock, () => {
      process.umask(old);
      if (process.platform !== 'win32') fs.chmodSync(sock, 0o600);
      log(`listening on ${sock}`);
    });
  }

  close(): void {
    this.server?.close();
    if (process.platform !== 'win32') try { fs.unlinkSync(paths.socket); } catch {}
  }

  private accept(line: LineSocket): void {
    let s: Session | undefined;
    line.on('message', (m: Message) => {
      if (m.type === 'hello') s = this.hello(m, line);
      else if (s) this.handle(s, m, line);
    });
    line.on('close', () => { if (s && s.line === line) this.connectionLost(s); });
  }

  private hello(m: Extract<Message, { type: 'hello' }>, line: LineSocket): Session | undefined {
    if (!isSessionId(m.sessionId)) { line.close(); return undefined; }
    let s = this.sessions.get(m.sessionId);
    if (!s) {
      s = { id: m.sessionId, meta: m.meta, launch: m.launch ?? {}, partition: `hb-${m.sessionId}`, tabs: [], activity: [], held: false, pinned: false, ended: false, feedbackQueue: [] };
      this.sessions.set(s.id, s);
    }
    s.meta = m.meta;
    s.launcherPid = m.launcherPid;
    s.line = line;
    s.ended = false;
    // A reconnecting launcher keeps holding while the user has control.
    if (s.held) line.send({ type: 'hold', hold: true });
    this.onChange();
    return s;
  }

  private handle(s: Session, m: Message, line: LineSocket): void {
    switch (m.type) {
      case 'meta':
        s.meta = m.meta;
        break;
      case 'attach':
        this.ensureBrowser(s)
          .then(() => line.send({ type: 'endpoint', requestId: m.requestId, port: s.proxy!.port }))
          .catch(e => line.send({ type: 'endpoint', requestId: m.requestId, error: String(e?.message ?? e) }));
        break;
      case 'toolStart':
        s.currentTool = { tool: m.tool, summary: m.summary, start: Date.now() };
        s.lastActivity = Date.now();
        this.throttle(s, false);
        if (m.tool in PROTECTING_TOOLS && PROTECTING_TOOLS[m.tool]) s.protectedBy = PROTECTING_TOOLS[m.tool]!;
        if (m.tool in PROTECTING_TOOLS && PROTECTING_TOOLS[m.tool] === null) s.protectedBy = undefined;
        break;
      case 'toolEnd': {
        this.thumbSoon(s);
        const a: Activity = { ...(s.currentTool ?? { tool: m.tool, start: Date.now() }), durationMs: m.durationMs, isError: m.isError, detail: m.detail };
        s.activity.unshift(a);
        s.activity.length = Math.min(s.activity.length, 100);
        s.currentTool = undefined;
        s.lastActivity = Date.now();
        break;
      }
      case 'feedbackRequest':
        s.feedback = { requestId: m.requestId, question: m.question, since: Date.now() };
        if (s.feedbackQueue.length) this.sendFeedback(s, s.feedbackQueue.splice(0));
        break;
      case 'feedbackCancel':
        if (s.feedback?.requestId === m.requestId) s.feedback = undefined;
        break;
      case 'hold':
        // The launcher released by itself (time limit).
        if (!m.hold && s.held) this.setHold(s, false);
        break;
      case 'bye':
        s.endReason = m.reason;
        this.end(s);
        break;
    }
    this.onChange();
  }

  private connectionLost(s: Session): void {
    s.line = undefined;
    s.feedback = undefined;
    s.currentTool = undefined;
    if (s.ended) return;
    if (s.launcherPid && isAlive(s.launcherPid)) {
      // The launcher still runs and reconnects by itself.
      this.onChange();
      return;
    }
    s.endReason = 'Launcher exited without signing off';
    this.end(s);
  }

  /**
   * Session end. The browser stays only when the session is pinned or the
   * user worked in it during the last five minutes; otherwise all its tabs
   * close and the in-memory partition is cleared.
   */
  private end(s: Session): void {
    s.ended = true;
    s.endedAt = Date.now();
    s.line = undefined;
    s.feedback = undefined;
    this.setHold(s, false);
    s.currentTool = undefined;
    const recent = !!s.lastInteraction && Date.now() - s.lastInteraction < 5 * 60_000;
    const keep = s.pinned || recent;
    if (!keep) this.closeBrowser(s);
    log(`session ${s.id} ended (${s.endReason}); browser ${keep ? `kept (${s.pinned ? 'pinned' : 'recent manual use'})` : 'closed'}`);
    this.onChange();
  }

  // MARK: Browser

  ensureBrowser(s: Session): Promise<void> {
    if (s.proxy && s.ctx) return Promise.resolve();
    s.starting ??= (async () => {
      const shared = this.profilePartition(s);
      // The project profile belongs to one live session at a time: one
      // partition is one CDP browser context, and agents must not see each
      // other's tabs. Further sessions start with a copy of its cookies.
      const taken = shared && [...this.sessions.values()].some(o => o !== s && o.ctx && o.partition === shared);
      s.partition = shared && !taken ? shared : `hb-${s.id}`;
      const ses = electronSession.fromPartition(s.partition);
      if (shared && taken) await copyCookies(electronSession.fromPartition(shared), ses);
      this.configureSession(ses, s);
      await this.createTab(s, 'about:blank', false);
      s.proxy = new SessionProxy({
        sessionId: s.id,
        browserContextId: s.ctx!,
        upstreamUrl: this.upstreamUrl,
        createTab: async url => (await this.createTab(s, url, true)).targetId,
        closeTab: async targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (!t) return false;
          t.view.webContents.close();
          return true;
        },
        tabSize: targetId => {
          const b = s.tabs.find(x => x.targetId === targetId)?.view.getBounds();
          return { width: b?.width ?? 0, height: b?.height ?? 0 };
        },
        agentInput: (targetId, delta) => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (t) { t.agentInputs = Math.max(0, t.agentInputs + delta); t.agentInputAt = Date.now(); }
        },
        resizeTab: (targetId, width, height) => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (!t) return;
          if (t.emulation) this.emulate(t, null);
          t.fixedSize = { width, height };
          this.onLayout(); this.onChange();
        },
        activateTab: targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (!t || t === s.active) return;
          s.active = t;
          this.thumbSoon(s);
          this.onLayout(); this.onChange();
        },
        agentEmulation: (targetId, p) => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (!t) return;
          // Width and height 0 keep the view size: nothing to frame.
          t.emulation = p && p.width > 0 && p.height > 0
            ? { width: p.width, height: p.height, dpr: p.deviceScaleFactor ?? 0, mobile: !!p.mobile, zoom: p.scale ?? 1, scale: p.scale ?? 1, by: 'agent' }
            : undefined;
          if (t.emulation) t.fixedSize = undefined;
          this.onLayout(); this.onChange();
        },
      });
      await s.proxy.listen();
      log(`session ${s.id} browser ready (context ${s.ctx}, proxy ${s.proxy.port})`);
    })().finally(() => { s.starting = undefined; });
    return s.starting;
  }

  private configureSession(ses: Electron.Session, s: Session): void {
    if (this.configured.has(ses)) return;
    this.configured.add(ses);
    // Look like Chrome, not like Electron, so sites behave as in a browser.
    ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ habitab\/\S+/i, ''));
    if (s.launch.proxyServer) void ses.setProxy({ proxyRules: s.launch.proxyServer });
    if (s.launch.acceptInsecureCerts) ses.setCertificateVerifyProc((_req, cb) => cb(0));
    // Permissions: only harmless ones by default.
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock']);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.on('will-download', (_e, item) => {
      const dir = path.join(os.homedir(), 'Downloads');
      item.setSavePath(path.join(dir, item.getFilename()));
      s.activity.unshift({ tool: 'Download', summary: item.getFilename(), start: Date.now() });
      this.onChange();
    });
  }

  async createTab(s: Session, url: string, activate: boolean, webContents?: WebContents): Promise<Tab> {
    const view = new WebContentsView({
      webPreferences: { partition: s.partition, backgroundThrottling: false, sandbox: true, contextIsolation: true },
      ...(webContents ? { webContents } : {}),
    } as any);
    const wc = view.webContents;
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      // Popups and target=_blank become tabs of the same session. The new
      // contents keep their opener (window.opener, postMessage).
      return {
        action: 'allow',
        createWindow: (options: any) => {
          const pending = this.createTab(s, target, disposition !== 'background-tab', options.webContents);
          void pending.then(() => this.onChange());
          return options.webContents;
        },
      } as any;
    });
    wc.on('page-title-updated', () => this.onChange());
    wc.on('did-navigate', () => this.onChange());
    wc.on('did-navigate-in-page', () => this.onChange());
    wc.on('page-favicon-updated', () => this.onChange());
    wc.on('did-start-loading', () => this.onChange());
    wc.on('did-stop-loading', () => { this.onChange(); if (tab === s.active) this.thumbSoon(s); });
    wc.on('context-menu', (_e, params) => this.contextMenu(s, tab, params));
    wc.on('input-event', (_e, input) => this.pageInput(s, tab, input.type));
    wc.on('destroyed', () => this.tabGone(s, tab));

    wc.debugger.attach('1.3');
    const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo') as any;
    wc.debugger.detach();
    const tab: Tab = { id: wc.id, view, targetId: targetInfo.targetId, agentInputs: 0, agentInputAt: 0 };
    s.ctx ??= targetInfo.browserContextId;
    if (s.launch.viewport) {
      const [w, h] = s.launch.viewport.split('x').map(Number);
      if (w && h) tab.fixedSize = { width: w, height: h };
    }
    s.tabs.push(tab);
    this.fixSelection();
    if (!webContents) wc.loadURL(url).catch(() => {});
    if (activate || !s.active) { s.active = tab; this.thumbSoon(s); }
    this.onLayout();
    this.onChange();
    return tab;
  }

  private tabGone(s: Session, tab: Tab): void {
    s.tabs = s.tabs.filter(t => t !== tab);
    try { this.win.contentView.removeChildView(tab.view); } catch {}
    if (s.devtoolsTab === tab) this.closeDevtools(s);
    if (s.active === tab) s.active = s.tabs[s.tabs.length - 1];
    this.fixSelection();
    this.onLayout();
    this.onChange();
  }

  closeBrowser(s: Session): void {
    this.closeDevtools(s);
    for (const t of [...s.tabs]) t.view.webContents.close();
    // The views go away asynchronously; a new browser must not reuse them.
    s.active = undefined;
    s.proxy?.close();
    s.proxy = undefined;
    s.ctx = undefined;
    // A persistent profile stays on disk; everything else is cleared.
    if (s.partition !== this.profilePartition(s)) void electronSession.fromPartition(s.partition).clearStorageData();
    s.thumb = undefined;
    this.onThumb(s);
    this.onLayout();
    this.onChange();
  }

  remove(s: Session): void {
    if (s.line) return;
    this.closeBrowser(s);
    this.sessions.delete(s.id);
    this.fixSelection();
    this.onLayout();
    this.onChange();
  }

  // MARK: DevTools

  toggleDevtools(s: Session): void {
    if (s.devtools) return this.closeDevtools(s);
    const tab = s.active;
    if (!tab) return;
    s.devtools = new WebContentsView();
    this.win.contentView.addChildView(s.devtools);
    tab.view.webContents.setDevToolsWebContents(s.devtools.webContents);
    tab.view.webContents.openDevTools({ mode: 'detach', activate: false });
    s.devtoolsTab = tab;
    this.onLayout();
    this.onChange();
  }

  closeDevtools(s: Session): void {
    if (!s.devtools) return;
    try { s.devtoolsTab?.view.webContents.closeDevTools(); } catch {}
    try { this.win.contentView.removeChildView(s.devtools); } catch {}
    try { s.devtools.webContents.close(); } catch {}
    s.devtools = undefined;
    s.devtoolsTab = undefined;
    this.onLayout();
    this.onChange();
  }

  inspect(s: Session, tab: Tab, x: number, y: number): void {
    if (!s.devtools || s.devtoolsTab !== tab) { this.closeDevtools(s); s.active = tab; this.toggleDevtools(s); }
    tab.view.webContents.inspectElement(x, y);
  }

  /**
   * Only sessions with tabs are shown (and selectable). When the selected one
   * has none, the most recently used session with tabs takes its place.
   */
  fixSelection(): void {
    if (this.sessions.get(this.selected ?? '')?.tabs.length) return;
    const withTabs = [...this.sessions.values()].filter(s => s.tabs.length);
    const recent = (s: Session) => Math.max(s.lastActivity ?? 0, s.lastInteraction ?? 0);
    this.selected = withTabs.sort((a, b) => recent(b) - recent(a))[0]?.id;
  }

  /**
   * The user marked an area. A waiting wait_for_user_feedback call gets it at
   * once. Otherwise it is kept for the next call, and Claude Code with an
   * active channel gets a short event that asks for that call. The event has
   * only the user's own words and the URL: page text stays in the tool result.
   */
  submitFeedback(s: Session, f: { text: string; image?: string; comment: string; url: string }): 'sent' | 'pushed' | 'kept' {
    if (s.feedback && s.line) {
      this.sendFeedback(s, [f]);
      return 'sent';
    }
    s.feedbackQueue.push(f);
    this.onChange();
    if (!s.line || !s.meta.channel) return 'kept';
    s.line.send({ type: 'feedbackPush', content:
      `The user marked an area of ${f.url} in Habitab${f.comment ? ` and says: ${f.comment}` : ' without a comment'}\n` +
      'Call wait_for_user_feedback now: it returns at once with a screenshot of the area and the HTML elements in it.' });
    return 'pushed';
  }

  private sendFeedback(s: Session, items: { text: string; image?: string }[]): void {
    if (!s.feedback || !s.line) return;
    const text = items.length === 1 ? items[0].text
      : items.map((x, i) => `Feedback ${i + 1} of ${items.length}:\n${x.text}`).join('\n\n');
    s.line.send({ type: 'feedbackResult', requestId: s.feedback.requestId, text, images: items.flatMap(x => (x.image ? [x.image] : [])) });
    s.feedback = undefined;
    this.onChange();
  }

  // MARK: Persistent profile (per project)

  projectRoot(s: Session): string { return s.meta.projectRoot ?? s.meta.cwd ?? ''; }

  hasPersistentProfile(s: Session): boolean {
    const root = this.projectRoot(s);
    return !!root && (prefs().persistentProfiles ?? []).includes(root);
  }

  /** The on-disk partition of the session's project, if it has a persistent profile. */
  private profilePartition(s: Session): string | undefined {
    if (!this.hasPersistentProfile(s)) return undefined;
    return `persist:project-${crypto.createHash('sha256').update(this.projectRoot(s)).digest('hex').slice(0, 16)}`;
  }

  /**
   * Turns the persistent profile on or off for the session's project. On: the running
   * browser moves to the project profile (cookies are copied, the active page
   * opens again). Off: the stored profile is deleted.
   */
  async togglePersistentProfile(s: Session): Promise<void> {
    const root = this.projectRoot(s);
    if (!root) return;
    const list = prefs().persistentProfiles ?? [];
    if (this.hasPersistentProfile(s)) {
      const p = this.profilePartition(s)!;
      setPrefs({ persistentProfiles: list.filter(x => x !== root) });
      await electronSession.fromPartition(p).clearStorageData();
      log(`persistent profile off for ${root} (deleted)`);
      this.onChange();
      return;
    }
    setPrefs({ persistentProfiles: [...list, root] });
    log(`persistent profile on for ${root}`);
    const p = this.profilePartition(s)!;
    const inUse = [...this.sessions.values()].some(o => o.ctx && o.partition === p);
    if (s.ctx && !inUse && !s.ended) {
      const url = s.active?.view.webContents.getURL();
      await copyCookies(electronSession.fromPartition(s.partition), electronSession.fromPartition(p));
      this.closeBrowser(s);
      await this.ensureBrowser(s);
      if (url && url !== 'about:blank') s.active?.view.webContents.loadURL(url).catch(() => {});
    }
    this.onChange();
  }

  /** Writes the persistent profiles to disk (before the app exits). */
  async flushProfiles(): Promise<void> {
    const persistent = new Set([...this.sessions.values()].map(s => s.partition).filter(p => p.startsWith('persist:')));
    await Promise.all([...persistent].map(async p => {
      const ses = electronSession.fromPartition(p);
      try { await ses.cookies.flushStore(); ses.flushStorageData(); } catch {}
    }));
  }

  // MARK: Thumbnails

  /** Captures the active tab a moment later (several triggers collapse into one). */
  thumbSoon(s: Session, delay = 800): void {
    if (s.thumbTimer) return;
    s.thumbTimer = setTimeout(() => {
      s.thumbTimer = undefined;
      void this.captureThumb(s);
    }, delay);
  }

  private async captureThumb(s: Session): Promise<void> {
    const wc = s.active?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      const img = await wc.capturePage();
      if (img.isEmpty()) return;
      s.thumb = 'data:image/jpeg;base64,' + img.resize({ width: 160, quality: 'good' }).toJPEG(80).toString('base64');
      this.onThumb(s);
    } catch {}
  }

  // MARK: Responsive mode

  /** Sets the user's emulation for a tab, or clears every emulation (null). */
  emulate(tab: Tab, e: Omit<Emulation, 'by' | 'scale' | 'applied'> | null): void {
    if (!e) {
      tab.emulation = undefined;
      void this.cdp(tab, 'Emulation.clearDeviceMetricsOverride');
      void this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      void this.cdp(tab, 'Emulation.setEmitTouchEventsForMouse', { enabled: false });
    } else {
      // No `scale` yet: the next layout computes it and sends the override.
      tab.emulation = { ...e, by: 'user', scale: undefined, applied: undefined };
      tab.fixedSize = undefined;
      void this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: e.mobile, maxTouchPoints: 5 });
      void this.cdp(tab, 'Emulation.setEmitTouchEventsForMouse', { enabled: e.mobile, configuration: 'mobile' });
    }
    this.onLayout();
    this.onChange();
  }

  /**
   * Called by the layout with the size (for filled dimensions) and the scale
   * that fit; sends the override only when something changed.
   */
  applyEmulation(tab: Tab, width: number, height: number, scale: number): void {
    const e = tab.emulation;
    if (!e || e.by !== 'user') return;
    e.width = width;
    e.height = height;
    e.scale = scale;
    const key = `${width}x${height}@${scale}/${e.dpr}/${e.mobile}`;
    if (e.applied === key) return;
    e.applied = key;
    // The screen has the size of the viewport, as in Chrome's responsive mode.
    void this.cdp(tab, 'Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: e.dpr, mobile: e.mobile, scale });
  }

  private async cdp(tab: Tab, method: string, params?: object): Promise<void> {
    const d = tab.view.webContents.debugger;
    try {
      if (!d.isAttached()) d.attach('1.3');
      await d.sendCommand(method, params);
    } catch (e: any) { log(`cdp ${method}: ${e.message}`); }
  }

  // MARK: Interaction and idle

  interaction(s: Session): void {
    s.lastInteraction = Date.now();
    this.throttle(s, false);
  }

  /**
   * Input events of a page. Agent input arrives through the CDP proxy and is
   * marked there; everything else comes from the user. A click or key press
   * takes control, scrolling only keeps it. Mouse moves do not count.
   */
  private pageInput(s: Session, tab: Tab, type: string): void {
    const start = type === 'mouseDown' || type === 'rawKeyDown' || type === 'keyDown' || type === 'touchStart';
    const keep = type === 'mouseWheel' || type === 'gestureScrollBegin';
    if (!start && !keep) return;
    if (tab === s.active) this.thumbSoon(s, 1500);
    const since = Date.now() - tab.agentInputAt;
    // A stuck counter (lost answer) stops counting after 10 s.
    if ((tab.agentInputs > 0 && since < 10_000) || since < 500) return;
    this.userInput(s, start);
  }

  /** The user acts in a session: control goes to the user until a pause. */
  userInput(s: Session, start = true): void {
    this.interaction(s);
    if (s.ended || !s.line) return;
    if (s.held && !s.autoResumeAt) return; // Manual control: until Resume.
    if (!s.held && !start) return;
    // Restart the countdown at most every half second.
    if (s.autoResumeAt && s.autoResumeAt - Date.now() > AUTO_RESUME_MS - 500) return;
    this.setHold(s, true, true);
  }

  /** The user left Habitab: automatic control ends at once (manual control stays). */
  releaseAutoHolds(): void {
    for (const s of this.sessions.values()) if (s.held && s.autoResumeAt) this.setHold(s, false);
  }

  /** Button and menu: take control, keep automatic control, or resume. */
  toggleHold(s: Session): void {
    this.setHold(s, !s.held || !!s.autoResumeAt);
  }

  /**
   * Hidden, idle sessions get Chromium's background throttling so that left
   * pages do not use CPU forever. Agent activity, a running trace or
   * screencast, and visibility switch it off again.
   */
  throttle(s: Session, on: boolean): void {
    for (const t of s.tabs) {
      try { t.view.webContents.setBackgroundThrottling(on); } catch {}
    }
  }

  idleCheck(): void {
    for (const s of this.sessions.values()) {
      const visible = s.id === this.selected;
      const idle = !s.currentTool && !s.protectedBy && Date.now() - Math.max(s.lastActivity ?? 0, s.lastInteraction ?? 0) > 5 * 60_000;
      this.throttle(s, !visible && idle);
      // Kept browsers of ended, unpinned sessions close after 30 min without use.
      if (s.ended && !s.pinned && s.tabs.length && Date.now() - Math.max(s.endedAt ?? 0, s.lastInteraction ?? 0) > 30 * 60_000) {
        this.closeBrowser(s);
      }
      // Ended sessions without browser leave the list after 15 minutes.
      if (s.ended && !s.pinned && !s.tabs.length && Date.now() - (s.endedAt ?? 0) > 15 * 60_000) this.remove(s);
    }
    this.onChange();
  }

  setHold(s: Session, hold: boolean, auto = false): void {
    clearTimeout(s.resumeTimer);
    s.resumeTimer = s.autoResumeAt = undefined;
    if (hold && auto) {
      s.autoResumeAt = Date.now() + AUTO_RESUME_MS;
      s.resumeTimer = setTimeout(() => this.setHold(s, false), AUTO_RESUME_MS);
    }
    if (s.held !== hold) s.line?.send({ type: 'hold', hold });
    s.held = hold;
    this.onChange();
  }

  // MARK: Context menu

  private contextMenu(s: Session, tab: Tab, p: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents;
    const items: MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      items.push({ label: 'Open Link in New Tab', click: () => void this.createTab(s, p.linkURL, true) });
      items.push({ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) });
      items.push({ label: 'Open Link in Default Browser', click: () => void shell.openExternal(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut', label: 'Cut' }, { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' }, { type: 'separator' });
    else if (p.selectionText) items.push({ role: 'copy', label: 'Copy' }, { type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Inspect', click: () => this.inspect(s, tab, p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup();
  }
}

/** Copies all cookies from one partition to another (sessions stay signed in). */
async function copyCookies(from: Electron.Session, to: Electron.Session): Promise<void> {
  for (const c of await from.cookies.get({})) {
    const host = (c.domain ?? '').replace(/^\./, '');
    try {
      await to.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
        name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        expirationDate: c.expirationDate, sameSite: c.sameSite,
        ...(c.hostOnly ? {} : { domain: c.domain }),
      });
    } catch {}
  }
}
