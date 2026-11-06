// Sessions: one per chrome-devtools-mcp server (its browser bridge, see
// launcher/browser.ts, signs it on). Each session has its own
// partition (cookies, storage, cache), its tabs as embedded Chromium views,
// an optional docked DevTools view and a CDP proxy. Partitions live in
// memory, except for projects with a persistent profile (on disk).
import crypto from 'node:crypto';
import { gpuTimeNs } from './gpu';
import { app, BaseWindow, Menu, MenuItemConstructorOptions, session as electronSession, shell, WebContents, WebContentsView, clipboard } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { canPush, isSessionId, LineSocket, Message, SessionMeta } from '../shared/ipc';
import { log, paths } from '../shared/paths';
import { isAlive } from '../shared/platform';
import { downloading, freeDownloadPath, type Download } from './downloads';
import { prefs, setPrefs } from './prefs';
import { SessionProxy } from './proxy';
import { StepDetector } from './cdp-steps';
import { codexThreadName } from '../shared/session-info';
import { CodexAppServer, isBrowserTool, itemError, summarizeArgs } from './codex';

/**
 * Pages see a Chrome, not a bare Chromium: the reduced user agent Chrome sends,
 * and user agent client hints (Sec-CH-UA) that match it. Electron sends no
 * client hints at all, and Cloudflare & co. notice the mismatch.
 */
const chrome = (() => {
  const full = process.versions.chrome;
  const major = full.split('.')[0];
  const brands = (v: (b: string) => string) => [{ brand: 'Not?A_Brand', version: v('24') }, { brand: 'Chromium', version: v(major) }, { brand: 'Google Chrome', version: v(major) }];
  const platform = { darwin: 'macOS', win32: 'Windows' }[process.platform as string] ?? 'Linux';
  return {
    userAgent: (ua: string) => ua.replace(/ Electron\/\S+/, '').replace(/ habitab\/\S+/i, '').replace(/Chrome\/(\d+)\S*/, 'Chrome/$1.0.0.0'),
    /** Request headers, as Chrome sends them to secure origins (low-entropy hints). */
    headers: { 'sec-ch-ua': brands(v => v).map(b => `"${b.brand}";v="${b.version}"`).join(', '), 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': `"${platform}"` },
    /** The CDP override for navigator.userAgentData of a page. */
    override: (userAgent: string) => ({ userAgent, userAgentMetadata: {
      brands: brands(v => v), fullVersionList: brands(v => v === '24' ? '24.0.0.0' : full),
      platform, platformVersion: process.getSystemVersion(), architecture: process.arch.startsWith('arm') ? 'arm' : 'x86', bitness: '64', model: '', mobile: false,
    } }),
  };
})();

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
  /** The agent's size does not fit the free space: the view cuts it off. */
  cut?: boolean;
  /** The override last sent (width, height, scale), to send again only on change. */
  applied?: string;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** A tab is busy above GPU_BUSY_MS (ms/s), calm again below 40 % of it (see gpuCheck). The tests use lower limits: macOS gives their hidden app less GPU time. */
const GPU_BUSY_MS = Number(process.env.HABITAB_GPU_BUSY_MS) || 250;
/** A page that does not answer for this long (while its renderer is busy) gets stopped (see hangCheck). */
const HANG_STOP_MS = Number(process.env.HABITAB_HANG_STOP_MS) || 30_000;
/** A tab whose share stays above this (ms/s) for GPU_PAUSE_AFTER ms gets paused (see gpuCheck). */
const GPU_PAUSE_MS = Number(process.env.HABITAB_GPU_PAUSE_MS) || 500;
const GPU_PAUSE_AFTER = Number(process.env.HABITAB_GPU_PAUSE_AFTER_MS) || 15_000;

/** The GPU load the UI shows: percent of the GPU in steps of 10 while the tab is busy, else 0. */
export const gpuShown = (t: Tab) => t.gpuBusy ? Math.min(100, Math.max(10, Math.round((t.gpu ?? 0) / 100) * 10)) : 0;

export interface Tab {
  id: number;
  view: WebContentsView;
  targetId: string;
  emulation?: Emulation;
  /** Where the emulated page sits inside the content area (for the resize handles). */
  frame?: { x: number; y: number; width: number; height: number; scale: number };
  /** Agent input in flight through the CDP proxy, and when it last changed. */
  agentInputs: number;
  agentInputAt: number;
  /** Session's tool call count when the agent or the user last used this tab (see isActiveTab). */
  usedAt: number;
  /** The agent's debugger is paused in this tab, so WebAssembly runs at full speed. */
  debuggerPaused?: boolean;
  /** The tab's renderer process uses much CPU (see cpuCheck); `cpuSamples` counts towards a change. */
  busy?: boolean;
  cpuSamples?: number;
  /** Draw calls of the page in its last report (page-preload.ts), and when that came. */
  draws?: number;
  drawsAt?: number;
  /** The tab's share of the GPU load in ms per second (see gpuCheck), and when it was found. */
  gpu?: number;
  gpuAt?: number;
  /** The page loads the GPU much (see gpuCheck). */
  gpuBusy?: boolean;
  /** Until then the page's draw reports do not count: it held its frames (see gpuCheck). */
  holdUntil?: number;
  /** Since then the tab's share is above the pause limit, in that many measurements in a row (see gpuCheck). */
  gpuSince?: number;
  gpuHits?: number;
  /** Habitab paused the page (too much GPU load); the share it had in percent. */
  gpuPaused?: number;
  /** How hard: 1 animation frames, 2 also timers, 3 renderer stopped (see escalateGpu); since when. */
  gpuLevel?: number;
  gpuLevelAt?: number;
  /** The page does not answer (its JavaScript runs without end), since then; a check is on its way. */
  hungSince?: number;
  pinging?: boolean;
  /** The page's renderer is gone (crashed or stopped, see stopPage): the tab is empty until it loads again. */
  gone?: string;
  /** Draw calls the page still made while paused (last report), and when. */
  pausedDraws?: number;
  pausedDrawsAt?: number;
  /** The user let the paused page run again: no pause until the next page loads. */
  gpuAllowed?: boolean;
  /** Small JPEG of the tab for the sidebar (data URL). */
  thumb?: string;
  thumbTimer?: NodeJS.Timeout;
  /** URL of the link under the pointer (shown in the status bubble). */
  targetUrl?: string;
  /** Console errors since the page loaded (newest last). */
  problems: Problem[];
  /** The user last saw the console errors (DevTools of the tab open until then). */
  problemsSeenAt?: number;
  /** Result of the user's find in page (the find bar shows "2/7"). */
  find?: { active: number; matches: number };
  /** The user's own tab (see forkTab): input there does not hold the agent. Ends when the agent works in it. */
  own?: boolean;
}

/**
 * An error in a page's console: console.error, an uncaught exception, or a
 * failed request as the console reports it. Texts come from the page.
 */
export interface Problem {
  id: number;
  text: string;
  /** Script and line. */
  source?: string;
  at: number;
  /** The same problem again right after: counted, not listed twice. */
  count: number;
}

/** A tab keeps this many problems; older ones go. */
const MAX_PROBLEMS = 50;
let problemIds = 0;

/** Marks the console line by which the DevTools frontend reports "Send to Agent…" (see DEVTOOLS_HOOK). */
const DEVTOOLS_SEND = 'HABITAB_SEND';
/** Marks the console line by which the frontend reports that the user cleared the console. */
const DEVTOOLS_CLEAR = 'HABITAB_CLEAR';
/**
 * Runs in the DevTools frontend. The frontend builds all its context menus
 * through InspectorFrontendHost.showContextMenuAtPoint (Electron shows them
 * natively) and hears the choice through DevToolsAPI.contextMenuItemSelected;
 * both are wrapped: one more item, and its choice goes out as a console line.
 * Blink drops the whole menu when an id reaches kMaxContextMenuAction (1000);
 * the frontend's own ids count up from 0 per menu, so ours sits just below.
 * Without a text selection the item sends the console message under the
 * pointer (found through the contextmenu event, which comes first).
 */
const DEVTOOLS_HOOK = `(() => {
  if (globalThis.__habitab) return 'hooked';
  const host = globalThis.InspectorFrontendHost, api = globalThis.DevToolsAPI;
  if (typeof host?.showContextMenuAtPoint !== 'function' || typeof api?.contextMenuItemSelected !== 'function') return 'not ready';
  globalThis.__habitab = true;
  const ID = 990;
  let selected = '', message = '';
  const selection = doc => ((doc && doc.getSelection && doc.getSelection()) || getSelection()).toString().trim();
  addEventListener('contextmenu', e => {
    const m = e.composedPath().find(n => n.classList && n.classList.contains('console-message-wrapper'));
    message = m ? m.innerText.trim() : '';
    selected = selection() || message;
  }, true);
  const show = host.showContextMenuAtPoint.bind(host);
  host.showContextMenuAtPoint = (x, y, items, doc) => {
    selected = selection(doc) || message;
    message = '';
    return show(x, y, items.concat([{ type: 'separator' }, { type: 'item', id: ID, label: 'Send to Agent…', enabled: !!selected }]), doc);
  };
  const chosen = api.contextMenuItemSelected.bind(api);
  api.contextMenuItemSelected = id => {
    if (id !== ID) return chosen(id);
    console.log('${DEVTOOLS_SEND} ' + JSON.stringify({ text: selected }));
  };
  // Tell the app when the user clears the console (toolbar, ⌘K, context menu or
  // the page's console.clear()), so it drops the error badge. Frontend internals
  // drift between Chromium versions, so every step is guarded and silent on miss.
  (async () => {
    try {
      const SDK = await import('./core/sdk/sdk.js');
      const Model = SDK.ConsoleModel && SDK.ConsoleModel.ConsoleModel;
      const Events = (SDK.ConsoleModel && SDK.ConsoleModel.Events) || (Model && Model.Events);
      const tm = SDK.TargetManager && SDK.TargetManager.TargetManager && SDK.TargetManager.TargetManager.instance();
      if (!Model || !Events || !Events.ConsoleCleared || !tm) return;
      const sub = m => { try { m.addEventListener(Events.ConsoleCleared, () => console.log('${DEVTOOLS_CLEAR}')); } catch (e) {} };
      try { tm.observeModels(Model, { modelAdded: m => sub(m), modelRemoved() {} }); }
      catch (e) { try { for (const t of tm.targets()) { const m = t.model(Model); if (m) sub(m); } } catch (e2) {} }
    } catch (e) {}
  })();
  return 'hooked';
})()`;
/**
 * Runs in the DevTools frontend: shows the Console panel through the host
 * bridge (Electron's inspectElement uses it too). Early in the frontend's
 * start the call is lost, so it counts only once the panel is there.
 */
const DEVTOOLS_SHOW_CONSOLE = `(() => {
  if (typeof globalThis.DevToolsAPI?.showPanel !== 'function' || typeof globalThis.InspectorFrontendAPI?.showPanel !== 'function' || document.readyState !== 'complete') return 'not ready';
  DevToolsAPI.showPanel('console');
  return document.querySelector('.console-view') ? 'shown' : 'not ready';
})()`;
let stepIds = 0;

export interface Activity { tool: string; summary?: string; start: number; durationMs?: number; isError?: boolean; detail?: string; }

/**
 * One tool call in the timeline of a tab: what the agent did, and how the tab
 * looked afterwards. Screenshots are files in the session's timeline folder;
 * a step whose page did not change shares the previous one's.
 */
export interface Step extends Activity {
  id: number;
  /** The tab the step belongs to (the one in its screenshot). Its steps go with it. */
  tab?: number;
  url?: string;
  title?: string;
  /** Base name of the screenshot files (<shot>.jpg, <shot>-t.jpg). No URL yet: the screenshot is still coming. */
  shot?: string;
  /** Its screenshot is being taken (not saved). */
  shooting?: boolean;
}

/** A session's timeline keeps this many steps; older ones (and their unused screenshots) go. */
const MAX_STEPS = 300;
/** Screenshot sizes (CSS width of the JPEG): the preview and the strip. */
const SHOT_WIDTH = 1280, SHOT_THUMB_WIDTH = 240;
/** Waits this long after a tool call, so the page has painted its result. */
const SHOT_DELAY_MS = 400;
const SHOT_TIMEOUT_MS = 3000;

export interface Session {
  id: string;
  meta: SessionMeta;
  launch: { proxyServer?: string; viewport?: string; acceptInsecureCerts?: boolean };
  /** The bridge process, and the MCP server above it: the session lives while one of them does. */
  launcherPid?: number;
  serverPid?: number;
  /** Signed on by a launcher of Habitab 0.2 that still runs: its server needs a restart to use the bridge. */
  legacy?: boolean;
  line?: LineSocket;
  ended: boolean;
  endedAt?: number;
  endReason?: string;
  partition: string;
  ctx?: string;
  tabs: Tab[];
  active?: Tab;
  proxy?: SessionProxy;
  /** Steps from the CDP commands (cdp-steps.ts); not for Codex sessions with their thread in the daemon. */
  steps?: StepDetector;
  /** Codex bridge session with its thread in the app-server daemon: tool calls and feedback go through it. */
  codexThread?: string;
  devtools?: WebContentsView;
  devtoolsTab?: Tab;
  currentTool?: Activity;
  lastActivity?: number;
  activity: Activity[];
  /** Tool calls with screenshots (oldest first), see Step. */
  timeline: Step[];
  /** Hash of the last screenshot: an unchanged page shares it. */
  lastShot?: { hash: string; name: string };
  /** A screenshot is being taken; another one follows when steps ended meanwhile. */
  shooting?: boolean;
  shootAgain?: boolean;
  shotTimer?: NodeJS.Timeout;
  /** Steps of the last screenshot (they may get a second, settled one), and the writes in progress. */
  lastBatch?: Step[];
  storing?: Promise<void>;
  /** The agent's tab when the last step ended: the screenshot shows it, even if a new call already opened another tab. */
  shotTab?: Tab;
  /** The agent closed a tab during the current call: that call belongs to the closed tab's timeline. */
  agentClosed?: boolean;
  /** Tool calls so far: the clock for tab activity. Pauses and days off do not count. */
  uses: number;
  /** The tab the agent used last (it gets the session's status in the sidebar). */
  agentTab?: Tab;
  held: boolean;
  /** Automatic control of single tabs: the user works in them, the agent goes on in the others. Unset: all tabs. */
  heldTabs?: Set<Tab>;
  /** The bridge holds commands of the agent: it waits for the user. */
  waiting?: boolean;
  /** The agent got the note that the user has control (once per hold). */
  holdNoted?: boolean;
  /** Set while the user has control automatically; then it ends by itself. */
  autoResumeAt?: number;
  resumeTimer?: NodeJS.Timeout;
  pinned: boolean;
  /** Audio of all tabs is silenced (like muting tabs in Chrome). */
  muted: boolean;
  lastInteraction?: number;
  protectedBy?: string;
  starting?: Promise<void>;
}

/** A session as stored for the next app start. */
interface SavedSession {
  id: string;
  meta: SessionMeta;
  launch: Session['launch'];
  launcherPid?: number;
  serverPid?: number;
  ended: boolean;
  endedAt?: number;
  endReason?: string;
  pinned: boolean;
  muted: boolean;
  lastActivity?: number;
  lastInteraction?: number;
  activity: Activity[];
  /** Steps with `tab` as the index into `tabs` (tab ids change with an app restart). */
  timeline?: Step[];
  uses?: number;
  tabs: { url: string; active: boolean; usedAt?: number; emulation?: Omit<Emulation, 'scale' | 'applied' | 'cut'>; own?: boolean }[];
  /** Only for in-memory partitions; a persistent profile has its cookies on disk. */
  cookies?: Electron.Cookie[];
}

/** The first line of every note to the agent: it knows its browser tool, not Habitab, and must not take the note for the user's words. */
export const NOTE_HEAD = 'Automatic note about your chrome-devtools-mcp browser (not from the user, no answer needed):';

/** To the agent when its browser commands begin to wait for the user. */
export const HOLD_NOTE = `${NOTE_HEAD} The user uses the browser for a moment. Your browser commands wait and then run by themselves. `
  + 'A slow or failed browser call has this cause: do not debug it, and do not stop or ask the user. Continue your task.';

/** HOLD_NOTE when the user has control of single tabs only: it names them, and the agent can go on in its other tabs. */
export function holdNote(urls?: string[]): string {
  if (!urls) return HOLD_NOTE;
  const which = urls.length ? ` (${urls.join(', ')})` : '';
  return `${NOTE_HEAD} The user uses ${urls.length > 1 ? 'some of your tabs' : 'one of your tabs'}${which} for a moment. `
    + 'Your browser commands for it, and commands that open or select a tab, wait and then run by themselves. Commands in your other tabs run as usual. '
    + 'A slow or failed browser call has this cause: do not debug it, and do not stop or ask the user. Continue your task.';
}

/** What the bridge holds: '' nothing, '*' all tabs, else the target ids of the held tabs. */
function holdScope(s: Session): string {
  return !s.held ? '' : s.heldTabs ? [...s.heldTabs].map(t => t.targetId).sort().join(',') : '*';
}

/** The page URL of a tab ('' for an empty or closed one). */
function tabUrl(t: Tab): string {
  const wc = t.view.webContents;
  const url = wc.isDestroyed() ? '' : wc.getURL();
  return url === 'about:blank' ? '' : url;
}

/** The hold message for the bridge. */
function holdMessage(s: Session): Message {
  return { type: 'hold', hold: s.held, ...(s.held && s.heldTabs ? { targets: [...s.heldTabs].map(t => t.targetId) } : {}) };
}

/** User input takes control automatically; this long without input gives it back. */
const AUTO_RESUME_MS = Number(process.env.HABITAB_AUTO_RESUME_MS) || 10_000;

/** A tab counts as active while it was used during the session's last this many tool calls. */
const ACTIVE_USES = 25;

/**
 * Shown as a card in the sidebar: the session's front tab, and every tab that
 * the agent or the user used recently. Blank pages are never active.
 */
/**
 * Console errors the user has not seen: none while the tab's DevTools are open
 * (they show their own count), else the ones that came or came again since.
 */
export function newProblems(s: Session, t: Tab): number {
  if (s.devtools && s.devtoolsTab === t) return 0;
  return t.problems.filter(p => p.at > (t.problemsSeenAt ?? 0)).length;
}

export function isActiveTab(s: Session, t: Tab): boolean {
  if (t === s.active) return true;
  const url = t.view.webContents.isDestroyed() ? '' : t.view.webContents.getURL();
  return !!url && url !== 'about:blank' && s.uses - t.usedAt < ACTIVE_USES;
}

const PROTECTING_TOOLS: Record<string, string | null> = {
  performance_start_trace: 'Performance trace running', performance_stop_trace: null,
  screencast_start: 'Screencast running', screencast_stop: null,
  // Steps of browser bridge sessions (cdp-steps.ts).
  'Trace': 'Performance trace running', 'Trace end': null,
  'Screencast': 'Screencast running', 'Screencast end': null,
};

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  readonly codex = new CodexAppServer(process.env.npm_package_version ?? '0');
  selected?: string;
  onChange: () => void = () => {};
  onLayout: () => void = () => {};
  onThumb: (tab: Tab) => void = () => {};
  /** A short notice for the user (the status line). */
  onNotice: (text: string) => void = () => {};
  /** A download started, made progress or ended. */
  onDownload: (d: Download) => void = () => {};
  /** A page asks for camera/microphone or to read the clipboard and no answer is stored: ask the user (true = allow). */
  onAccessRequest: (s: Session, kind: SiteAccess, origin: string, types: ('video' | 'audio')[]) => Promise<boolean> = async () => false;
  /** Context menu "Send Element to Agent": the app opens the marking overlay on it (view coordinates). */
  onSendElement: (s: Session, tab: Tab, x: number, y: number) => void = () => {};
  private configured = new WeakSet<Electron.Session>();
  /** Set by a click in a page; cleared when the user leaves Habitab. */
  private pointerSinceFocus = false;
  private saveTimer?: NodeJS.Timeout;
  private server?: net.Server;

  constructor(private win: BaseWindow, private upstreamUrl: () => string) {}

  // MARK: Browser bridge connections

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
      s = { id: m.sessionId, meta: m.meta, launch: m.launch ?? {}, partition: `hb-${m.sessionId}`, tabs: [], activity: [], timeline: [], uses: 0, held: false, pinned: false, muted: false, ended: false };
      this.sessions.set(s.id, s);
    }
    s.meta = m.meta;
    s.launcherPid = m.launcherPid;
    s.serverPid = m.serverPid;
    s.legacy = !m.serverPid;
    if (s.legacy) log(`session ${s.id}: signed on by a 0.2 launcher (pid ${m.launcherPid}); its server needs a restart`);
    s.line = line;
    s.ended = false;
    if (s.meta.client === 'codex' && !s.codexThread) void this.attachCodex(s);
    // A reconnecting bridge keeps holding while the user has control.
    if (s.held) line.send(holdMessage(s));
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
      case 'hold':
        // The bridge released by itself (time limit).
        if (!m.hold && s.held) this.setHold(s, false);
        break;
      case 'waiting':
        s.waiting = !!m.waiting;
        // Without a reason, the agent takes the slow tool call for a hanging page and debugs it.
        if (s.waiting && s.held && !s.holdNoted) s.holdNoted = this.pushToAgent(s, holdNote(s.heldTabs && [...s.heldTabs].map(t => tabUrl(t)).filter(Boolean)));
        break;
      case 'bye':
        s.endReason = m.reason;
        this.end(s);
        break;
    }
    this.onChange();
  }

  /**
   * Codex bridge session: finds its thread in the app-server daemon (by the
   * working directory), then its tool calls replace the steps from CDP and
   * feedback goes to the thread as a user message.
   */
  private async attachCodex(s: Session): Promise<void> {
    const thread = await this.codex.resolveThread(s.meta.cwd ?? '');
    if (!thread) { log(`session ${s.id}: no Codex thread for ${s.meta.cwd} in the app-server daemon`); return; }
    if (s.ended || s.codexThread) return;
    s.codexThread = thread.id;
    s.meta.agentSessionId = thread.id;
    s.meta.agentSessionSource = 'codex-app-server';
    s.meta.agentSessionName = thread.name ?? codexThreadName(thread.id);
    s.meta.codexAppServer = true;
    s.steps?.close();
    s.steps = undefined;
    log(`session ${s.id}: Codex thread ${thread.id} (${thread.status ?? '?'})`);
    this.onChange();
    await this.codex.subscribe(thread.id, {
      itemStarted: item => { if (isBrowserTool(item)) this.toolStart(s, item.tool!, summarizeArgs(item.arguments)); },
      itemCompleted: item => { if (isBrowserTool(item)) this.toolEnd(s, item.tool!, !!itemError(item), item.durationMs ?? 0, itemError(item)); },
    });
  }

  /** A step (cdp-steps.ts) or a tool call reported by Codex's daemon (codex.ts) begins. */
  toolStart(s: Session, tool: string, summary?: string): void {
    s.currentTool = { tool, summary, start: Date.now() };
    s.lastActivity = Date.now();
    s.uses++;
    this.throttle(s, false);
    if (tool in PROTECTING_TOOLS && PROTECTING_TOOLS[tool]) s.protectedBy = PROTECTING_TOOLS[tool]!;
    if (tool in PROTECTING_TOOLS && PROTECTING_TOOLS[tool] === null) s.protectedBy = undefined;
    this.onChange();
  }

  toolEnd(s: Session, tool: string, isError: boolean, durationMs: number, detail?: string, summary?: string): void {
    this.thumbSoon(s);
    if (s.agentTab && s.agentTab !== s.active) this.thumbSoon(s, 800, s.agentTab);
    const a: Activity = { ...(s.currentTool ?? { tool, start: Date.now() }), tool, durationMs, isError, detail };
    if (summary) a.summary = summary;
    s.activity.unshift(a);
    s.activity.length = Math.min(s.activity.length, 100);
    this.recordStep(s, a);
    s.currentTool = undefined;
    s.lastActivity = Date.now();
    this.onChange();
  }

  private connectionLost(s: Session): void {
    s.line = undefined;
    s.currentTool = undefined;
    if (s.ended) return;
    if (this.agentAlive(s)) {
      // The bridge still runs and reconnects by itself, or its server starts a new one with the next call.
      this.onChange();
      return;
    }
    s.endReason = 'Browser bridge exited without signing off';
    this.end(s);
  }

  /** The bridge or the MCP server above it still runs. */
  private agentAlive(s: { launcherPid?: number; serverPid?: number }): boolean {
    return (!!s.launcherPid && isAlive(s.launcherPid)) || (!!s.serverPid && isAlive(s.serverPid));
  }

  /**
   * Session end. The browser stays only when the session is pinned or the
   * user worked in it during the last five minutes; otherwise all its tabs
   * close and the in-memory partition is cleared.
   */
  private end(s: Session): void {
    if (s.codexThread) void this.codex.unsubscribe(s.codexThread);
    s.ended = true;
    s.endedAt = Date.now();
    s.line = undefined;
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
      s.steps?.close();
      s.steps = !s.codexThread ? new StepDetector({
        start: st => { log(`session ${s.id} step: ${st.tool}`); this.toolStart(s, st.tool, st.summary); },
        end: en => { log(`session ${s.id} step end: ${en.tool} ${en.durationMs} ms${en.isError ? ' error' : ''}`); this.toolEnd(s, en.tool, en.isError, en.durationMs, en.detail, en.summary); },
      }) : undefined;
      s.proxy = new SessionProxy({
        sessionId: s.id,
        browserContextId: s.ctx!,
        upstreamUrl: this.upstreamUrl,
        agentCommand: (key, method, params, sessionId) => s.steps?.command(key, method, params, sessionId),
        agentReply: (key, error) => s.steps?.reply(key, error),
        agentEvent: method => s.steps?.event(method),
        createTab: async url => (await this.createTab(s, url, true)).targetId,
        closeTab: async targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (!t) return false;
          s.agentClosed = true;
          t.view.webContents.close();
          return true;
        },
        tabSize: targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          // The agent's size counts as the window size (resize_page reads it back).
          const b = t?.emulation?.by === 'agent' ? t.emulation : t?.view.getBounds();
          return { width: b?.width ?? 0, height: b?.height ?? 0 };
        },
        agentInput: (targetId, delta) => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (t) { t.agentInputs = Math.max(0, t.agentInputs + delta); t.agentInputAt = Date.now(); }
        },
        resizeTab: async (targetId, width, height) => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (t) await this.agentSize(t, width, height);
        },
        agentUse: targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (!t) return;
          const changed = s.agentTab !== t || !isActiveTab(s, t) || !!t.own;
          s.agentTab = t;
          t.own = false;
          this.used(s, t, changed);
        },
        debuggerBack: targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (t?.debuggerPaused) { t.debuggerPaused = false; this.onChange(); }
        },
        activateTab: targetId => {
          const t = s.tabs.find(x => x.targetId === targetId);
          if (t) this.used(s, t);
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
    ses.setUserAgent(chrome.userAgent(ses.getUserAgent()));
    ses.webRequest.onBeforeSendHeaders((d, cb) => {
      const secure = d.url.startsWith('https:') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(d.url);
      cb({ requestHeaders: secure ? { ...d.requestHeaders, ...chrome.headers } : d.requestHeaders });
    });
    if (s.launch.proxyServer) void ses.setProxy({ proxyRules: s.launch.proxyServer });
    if (s.launch.acceptInsecureCerts) ses.setCertificateVerifyProc((_req, cb) => cb(0));
    // Permissions: harmless ones always (writing the clipboard too, as in Chrome);
    // camera/microphone and reading the clipboard when the user allows them for
    // the page's origin (asked like Chrome, kept per project).
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock']);
    const kindOf = (permission: string): SiteAccess | undefined => permission === 'media' ? 'media' : permission === 'clipboard-read' ? 'clipboard' : undefined;
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
      if (allowed.has(permission)) return cb(true);
      const kind = kindOf(permission);
      if (!kind) return cb(false);
      const d = details as Electron.MediaAccessPermissionRequest;
      const origin = originOf(d.securityOrigin || d.requestingUrl);
      const types = kind === 'media' ? (d.mediaTypes ?? []).filter((t): t is 'video' | 'audio' => t === 'video' || t === 'audio') : [];
      const known = this.siteAccess(s, kind, origin);
      if (known) return cb(known === 'allow');
      void this.onAccessRequest(s, kind, origin, types).then(cb, () => cb(false));
    });
    // Feature checks (navigator.permissions, device labels) see the same answers.
    ses.setPermissionCheckHandler((_wc, permission, origin) => {
      const kind = kindOf(permission);
      return allowed.has(permission) || (!!kind && this.siteAccess(s, kind, originOf(origin)) === 'allow');
    });
    // Pages get what Electron lacks compared to Chrome (the Web Share API, see page-preload.ts).
    ses.registerPreloadScript({ type: 'frame', id: 'habitab-page', filePath: path.join(__dirname, 'page-preload.js') });
    // Downloads go to ~/Downloads without a dialog (like Chrome's default); a name that is taken gets a number.
    ses.on('will-download', (_e, item) => {
      const file = freeDownloadPath(process.env.HABITAB_DOWNLOADS || app.getPath('downloads'), item.getFilename());
      item.setSavePath(file);
      downloading.add(file);
      log(`session ${s.id} download: ${item.getURL().slice(0, 300)} -> ${file}`);
      s.activity.unshift({ tool: 'Download', summary: path.basename(file), start: Date.now() });
      const report = (state: Download['state']) => this.onDownload({ session: s.id, name: path.basename(file), file, state, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      item.on('updated', (_e, state) => report(state === 'interrupted' ? 'interrupted' : 'progressing'));
      item.once('done', (_e, state) => {
        downloading.delete(file);
        log(`session ${s.id} download ${state}: ${file}`);
        report(state);
      });
      report('progressing');
      this.onChange();
    });
  }

  async createTab(s: Session, url: string, activate: boolean, webContents?: WebContents): Promise<Tab> {
    const view = new WebContentsView({
      webPreferences: { partition: s.partition, backgroundThrottling: false, sandbox: true, contextIsolation: true },
      ...(webContents ? { webContents } : {}),
    } as any);
    const wc = view.webContents;
    wc.setAudioMuted(s.muted);
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
          void pending.then(t => { t.own = tab.own; this.onChange(); });
          return options.webContents;
        },
      } as any;
    });
    wc.on('page-title-updated', () => this.onChange());
    wc.on('did-navigate', () => {
      this.setTargetUrl(tab, '');
      // A new page runs its animation (page-preload.ts starts without a hold).
      tab.gpuPaused = tab.gpuSince = tab.gpuLevel = tab.pausedDraws = undefined;
      tab.gone = tab.hungSince = undefined;
      tab.gpuAllowed = false;
      this.onChange();
    });
    // A new document starts with no problems, like the console without "Preserve log".
    wc.on('did-start-navigation', e => { if (e.isMainFrame && !e.isSameDocument && tab.problems.length) { tab.problems = []; this.onChange(); } });
    // What the console shows as an error, no more (not cache misses or cancelled loads).
    wc.on('console-message', e => {
      if (e.level === 'error') this.addProblem(wc.id, { text: e.message, source: e.sourceId ? `${e.sourceId}:${e.lineNumber}` : undefined });
    });
    wc.on('update-target-url', (_e, target) => this.setTargetUrl(tab, target));
    wc.on('did-navigate-in-page', () => this.onChange());
    wc.on('page-favicon-updated', () => this.onChange());
    wc.on('did-start-loading', () => this.onChange());
    wc.on('did-stop-loading', () => { this.onChange(); if (isActiveTab(s, tab)) this.thumbSoon(s, 800, tab); });
    wc.on('context-menu', (_e, params) => this.contextMenu(s, tab, params));
    wc.on('found-in-page', (_e, r) => { if (r.finalUpdate) { tab.find = { active: r.activeMatchOrdinal, matches: r.matches }; this.onChange(); } });
    wc.on('input-event', (_e, input) => this.pageInput(s, tab, input.type));
    wc.on('destroyed', () => this.tabGone(s, tab));
    // Chromium's own hang monitor (input without answer); hangCheck also finds pages without input.
    wc.on('unresponsive', () => { tab.hungSince ??= Date.now(); this.onChange(); });
    wc.on('responsive', () => { tab.hungSince = undefined; this.onChange(); });
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      tab.gone = d.reason;
      tab.hungSince = undefined;
      log(`page gone (${d.reason}): ${wc.getURL()}`);
      this.onChange();
    });

    wc.debugger.attach('1.3');
    // Failed requests as the console reports them ("Failed to load resource: … 500"):
    // they come through the Log domain, not through the console-message event.
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Log.entryAdded' && params.entry?.level === 'error' && params.entry.source === 'network') this.addProblem(wc.id, { text: params.entry.text, source: params.entry.url });
    });
    const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo') as any;
    const tab: Tab = { id: wc.id, view, targetId: targetInfo.targetId, agentInputs: 0, agentInputAt: 0, usedAt: s.uses, problems: [] };
    void this.cdp(tab, 'Log.enable');
    // navigator.userAgentData like the headers. Not awaited: before the first
    // navigation the command only answers once the page exists. The override
    // lives in this debugger session, so it stays attached.
    void this.cdp(tab, 'Network.setUserAgentOverride', chrome.override(wc.session.getUserAgent()));
    s.ctx ??= targetInfo.browserContextId;
    if (s.launch.viewport) {
      const [w, h] = s.launch.viewport.split('x').map(Number);
      if (w && h) void this.agentSize(tab, w, h);
    }
    s.tabs.push(tab);
    this.fixSelection();
    if (!webContents) wc.loadURL(url).catch(() => {});
    if (activate || !s.active) { s.active = tab; this.thumbSoon(s); }
    this.onLayout();
    this.onChange();
    return tab;
  }

  private setTargetUrl(tab: Tab, target: string): void {
    if ((tab.targetUrl ?? '') === target) return;
    tab.targetUrl = target;
    this.onLayout();
    this.onChange();
  }

  /** The project's option: the agent's debugger pauses in a tab while the user tests it. */
  pausesDebugger(s: Session): boolean {
    const root = this.projectRoot(s);
    return !!root && (prefs().pauseDebugger ?? []).includes(root);
  }

  /** Turns the project's option on (and pauses the debugger in the front tab now) or off. */
  setPausesDebugger(s: Session, on: boolean): void {
    const root = this.projectRoot(s);
    if (!root) return;
    const list = (prefs().pauseDebugger ?? []).filter(x => x !== root);
    setPrefs({ pauseDebugger: on ? [...list, root] : list });
    for (const o of this.sessions.values()) {
      if (this.projectRoot(o) !== root) continue;
      for (const t of o.tabs) if (!on || (o === s && t === s.active)) void this.pauseDebugger(o, t, on);
    }
    this.onChange();
  }

  /** Pauses the agent's debugger in a tab (until the agent works there again), or turns it on. */
  async pauseDebugger(s: Session, tab: Tab, paused: boolean): Promise<void> {
    if (!!tab.debuggerPaused === paused || !s.proxy) return;
    tab.debuggerPaused = paused;
    this.onChange();
    await s.proxy.setDebugger(tab.targetId, !paused);
  }

  // MARK: Problems (console errors)

  /** The session and tab of a page's webContents (undefined for Habitab's own views). */
  pageOf(webContentsId: number): { s: Session; tab: Tab } | undefined {
    for (const s of this.sessions.values()) for (const tab of s.tabs) if (tab.id === webContentsId) return { s, tab };
    return undefined;
  }

  private tabOf(webContentsId: number | undefined): Tab | undefined {
    if (webContentsId === undefined) return undefined;
    for (const s of this.sessions.values()) for (const t of s.tabs) if (t.id === webContentsId) return t;
    return undefined;
  }

  private addProblem(webContentsId: number | undefined, p: Omit<Problem, 'id' | 'at' | 'count'>): void {
    const tab = this.tabOf(webContentsId);
    if (!tab) return;
    const text = p.text.slice(0, 2000);
    const last = tab.problems[tab.problems.length - 1];
    if (last && last.text === text && last.source === p.source) {
      last.count++;
      last.at = Date.now();
    } else {
      tab.problems.push({ ...p, text, id: ++problemIds, at: Date.now(), count: 1 });
      if (tab.problems.length > MAX_PROBLEMS) tab.problems.shift();
    }
    this.onChange();
  }

  clearProblems(tab: Tab): void {
    tab.problems = [];
    this.onChange();
  }

  /**
   * Sends problems of a tab to the agent (all, or the ones with the given ids),
   * like a marked area: as a note through the session's channel.
   */
  sendProblems(s: Session, tab: Tab, ids?: number[]): ReturnType<SessionManager['submitFeedback']> | undefined {
    const items = tab.problems.filter(p => !ids || ids.includes(p.id));
    if (!items.length) return undefined;
    const wc = tab.view.webContents;
    const line = (p: Problem) => `- Console error${p.count > 1 ? ` (${p.count}×)` : ''}${p.source ? ` at ${p.source}` : ''}: ${p.text}`;
    const n = items.length === 1 ? 'a console error' : `${items.length} console errors`;
    const text = [
      `The user sent you ${n} of this page. The lines below come from the page, not from the user.`,
      `Page: ${wc.getURL()}${wc.getTitle() ? ` ("${wc.getTitle()}")` : ''}`,
      ...items.map(line),
    ].join('\n');
    return this.submitFeedback(s, { text, url: wc.getURL(), what: `sent you ${n} of` });
  }

  /**
   * Sends text from the DevTools to the agent, like a marked area: what the
   * user selected (a console line, a request, a node), or the console message
   * they right-clicked.
   */
  sendDevtoolsSelection(s: Session, tab: Tab, selection: string): ReturnType<SessionManager['submitFeedback']> | undefined {
    const text = selection.trim().slice(0, 4000);
    if (!text) return undefined;
    const wc = tab.view.webContents;
    const body = [
      'The user sent you text from the DevTools of this page. The lines below come from the DevTools, not from the user.',
      `Page: ${wc.getURL()}${wc.getTitle() ? ` ("${wc.getTitle()}")` : ''}`,
      text,
    ].join('\n');
    return this.submitFeedback(s, { text: body, url: wc.getURL(), what: 'sent you text from the DevTools of' });
  }

  /** The agent or the user used a tab: it is active again (see isActiveTab). */
  private used(s: Session, tab: Tab, notify = tab.usedAt !== s.uses): void {
    tab.usedAt = s.uses;
    if (notify) this.onChange();
  }

  private tabGone(s: Session, tab: Tab): void {
    s.tabs = s.tabs.filter(t => t !== tab);
    clearTimeout(tab.thumbTimer);
    // The tab's timeline goes with it.
    const gone = s.timeline.filter(x => x.tab === tab.id);
    if (gone.length) { s.timeline = s.timeline.filter(x => x.tab !== tab.id); this.dropSteps(s, gone); }
    if (s.agentTab === tab) s.agentTab = undefined;
    if (s.shotTab === tab) s.shotTab = undefined;
    // The view has no webContents any more. Nothing must point at the tab
    // before the next layout (closeDevtools runs one).
    if (s.active === tab) s.active = s.tabs[s.tabs.length - 1];
    try { this.win.contentView.removeChildView(tab.view); } catch {}
    if (s.devtoolsTab === tab) this.closeDevtools(s);
    this.fixSelection();
    this.onLayout();
    this.onChange();
  }

  closeBrowser(s: Session): void {
    this.closeDevtools(s);
    for (const t of [...s.tabs]) t.view.webContents.close();
    // The views go away asynchronously; a new browser must not reuse them.
    s.active = undefined;
    s.agentTab = undefined;
    s.shotTab = undefined;
    s.proxy?.close();
    s.proxy = undefined;
    s.ctx = undefined;
    // A persistent profile stays on disk; everything else is cleared.
    if (s.partition !== this.profilePartition(s)) void electronSession.fromPartition(s.partition).clearStorageData();
    this.onLayout();
    this.onChange();
  }

  remove(s: Session): void {
    if (s.line) return;
    this.closeBrowser(s);
    this.sessions.delete(s.id);
    fs.rm(this.timelineDir(s), { recursive: true, force: true }, () => {});
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
    this.hookDevtools(s, s.devtools.webContents);
    tab.view.webContents.setDevToolsWebContents(s.devtools.webContents);
    tab.view.webContents.openDevTools({ mode: 'detach', activate: false });
    s.devtoolsTab = tab;
    tab.problemsSeenAt = Date.now();
    this.onLayout();
    this.onChange();
  }

  /**
   * "Send to Agent…" in the context menus of the DevTools frontend. The
   * frontend has no preload, so the hook goes in by script once it is loaded,
   * and the user's choice comes back as a console line.
   */
  private hookDevtools(s: Session, dt: WebContents): void {
    dt.on('console-message', e => {
      // The user cleared the console: drop the error badge too.
      if (e.message.startsWith(DEVTOOLS_CLEAR) && s.devtoolsTab?.problems.length) { this.clearProblems(s.devtoolsTab); return; }
      if (!e.message.startsWith(DEVTOOLS_SEND + ' ')) return;
      try {
        const { text } = JSON.parse(e.message.slice(DEVTOOLS_SEND.length + 1));
        const how = s.devtoolsTab && this.sendDevtoolsSelection(s, s.devtoolsTab, String(text ?? ''));
        if (how) this.onNotice(how === 'pushed' ? 'Sent to the agent' : 'Not sent: this agent has no channel for feedback');
      } catch {}
    });
    dt.on('did-finish-load', () => void this.inDevtools(dt, DEVTOOLS_HOOK));
  }

  /** Runs a script in the DevTools frontend; it retries while the frontend is still setting itself up. */
  private async inDevtools(dt: WebContents, script: string, tries = 50): Promise<void> {
    for (let i = 0; i < tries && !dt.isDestroyed(); i++) {
      const r = await dt.executeJavaScript(script).catch(() => 'not ready');
      if (r !== 'not ready') return;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /** Opens the DevTools on the tab (if needed) and shows its Console panel. */
  showConsole(s: Session, tab: Tab): void {
    if (!s.devtools || s.devtoolsTab !== tab) { this.closeDevtools(s); s.active = tab; this.toggleDevtools(s); }
    if (s.devtools) void this.inDevtools(s.devtools.webContents, DEVTOOLS_SHOW_CONSOLE);
  }

  closeDevtools(s: Session): void {
    if (!s.devtools) return;
    try { s.devtoolsTab?.view.webContents.closeDevTools(); } catch {}
    try { this.win.contentView.removeChildView(s.devtools); } catch {}
    try { s.devtools.webContents.close(); } catch {}
    if (s.devtoolsTab) s.devtoolsTab.problemsSeenAt = Date.now();
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
   * The user marked an area (or sends console errors): the agent gets it as a
   * note with all details, the image as a file. Codex gets it through the
   * app-server daemon (the image as such), Claude Code through the inbox
   * socket. Without a channel (other clients) it is kept for the clipboard.
   */
  submitFeedback(s: Session, f: { text: string; images?: string[]; comment?: string; url: string; what?: string }): 'pushed' | 'kept' {
    const target = s.codexThread ? 'codex' : s.line && canPush(s.meta) ? 'inbox' : undefined;
    if (!target) return 'kept';
    const files: string[] = [];
    const images = f.images ?? [];
    if (images.length) {
      try {
        const dir = this.timelineDir(s);
        fs.mkdirSync(dir, { recursive: true });
        const at = Date.now();
        images.forEach((image, i) => {
          const file = path.join(dir, `feedback-${at}${images.length > 1 ? `-${i + 1}` : ''}.png`);
          fs.writeFileSync(file, Buffer.from(image, 'base64'));
          files.push(file);
        });
      } catch (e: any) { log(`feedback image not written: ${e.message}`); }
    }
    const part = f.what ? 'part' : 'area';
    const content = [
      'Feedback from the user in Habitab:',
      f.text,
      target !== 'inbox' || !files.length ? ''
        : files.length === 1 ? `Screenshot of the marked ${part}: ${files[0]} (look at it with your file reading tool).`
        : `Screenshots of the marked ${part}s, in their order (look at them with your file reading tool):\n${files.map((file, i) => `${i + 1}. ${file}`).join('\n')}`,
      'Act on it and report in your session as usual; the user sends more feedback on their own.',
    ].filter(Boolean).join('\n');
    this.pushToAgent(s, content, files);
    return 'pushed';
  }

  /** A message to the session's agent: Codex through the app-server daemon, Claude Code through the inbox socket; else nothing. */
  pushToAgent(s: Session, content: string, files: string[] = []): boolean {
    if (s.codexThread) { void this.codex.push(s.codexThread, content, files); return true; }
    if (s.line && canPush(s.meta)) { s.line.send({ type: 'feedbackPush', content }); return true; }
    return false;
  }

  /** Silences or unmutes the audio of all tabs of the session, also the ones opened later. */
  setMuted(s: Session, muted: boolean): void {
    s.muted = muted;
    for (const t of s.tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.setAudioMuted(muted);
    this.onChange();
  }

  // MARK: Site permissions (camera/microphone, reading the clipboard; per project and origin)

  /** The stored answer for an origin in the session's project, if any. */
  siteAccess(s: Session, kind: SiteAccess, origin: string): 'allow' | 'block' | undefined {
    return (prefs()[ACCESS_PREF[kind]] ?? {})[this.projectRoot(s)]?.[origin];
  }

  setSiteAccess(s: Session, kind: SiteAccess, origin: string, answer: 'allow' | 'block' | undefined): void {
    const root = this.projectRoot(s);
    if (!root) return;
    const all = { ...(prefs()[ACCESS_PREF[kind]] ?? {}) };
    const project = { ...(all[root] ?? {}) };
    if (answer) project[origin] = answer; else delete project[origin];
    if (Object.keys(project).length) all[root] = project; else delete all[root];
    setPrefs({ [ACCESS_PREF[kind]]: all });
    this.onChange();
  }

  /** Origins with a stored answer of this kind in the session's project. */
  siteAccessOrigins(s: Session, kind: SiteAccess): Record<string, 'allow' | 'block'> {
    return (prefs()[ACCESS_PREF[kind]] ?? {})[this.projectRoot(s)] ?? {};
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

  // MARK: Restore after an app restart

  /** Saves the sessions a moment later (several changes collapse into one). */
  saveSoon(): void {
    this.saveTimer ??= setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 2000);
  }

  /**
   * Writes the sessions that survive an app restart: connected ones (their
   * bridges come back with the next tool call) and pinned ones, with their
   * tabs and cookies.
   */
  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const sessions: SavedSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.ended && !s.pinned) continue;
      const live = s.tabs.filter(t => !t.view.webContents.isDestroyed());
      const tabs = live.map(t => {
        const e = t.emulation;
        return {
          url: t.view.webContents.getURL(), active: t === s.active, usedAt: t.usedAt, own: t.own,
          emulation: e && { width: e.width, height: e.height, dpr: e.dpr, mobile: e.mobile, zoom: e.zoom, preset: e.preset, fillWidth: e.fillWidth, fillHeight: e.fillHeight, by: e.by },
        };
      });
      let cookies: Electron.Cookie[] | undefined;
      if (s.ctx && !s.partition.startsWith('persist:')) try { cookies = await electronSession.fromPartition(s.partition).cookies.get({}); } catch {}
      sessions.push({
        id: s.id, meta: s.meta, launch: s.launch, launcherPid: s.launcherPid, serverPid: s.serverPid, ended: s.ended, endedAt: s.endedAt, endReason: s.endReason,
        pinned: s.pinned, muted: s.muted, lastActivity: s.lastActivity, lastInteraction: s.lastInteraction, activity: s.activity.slice(0, 30), uses: s.uses, tabs, cookies,
        timeline: s.timeline.map(x => ({ ...x, tab: live.findIndex(t => t.id === x.tab) })).filter(x => x.tab >= 0),
      });
    }
    try {
      const tmp = `${paths.sessions}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ selected: this.selected, sessions }), { mode: 0o600 });
      fs.renameSync(tmp, paths.sessions);
    } catch (e: any) { log(`saving sessions failed: ${e.message}`); }
  }

  /**
   * Restores the saved sessions at app start, before bridges can connect.
   * A session whose bridge still runs waits for it to reconnect; a pinned
   * one whose bridge exited comes back as kept. Others are gone.
   */
  async restore(): Promise<void> {
    let saved: { selected?: string; sessions?: SavedSession[] };
    try { saved = JSON.parse(fs.readFileSync(paths.sessions, 'utf8')); } catch { this.cleanTimelines(); return; }
    for (const x of saved.sessions ?? []) {
      if (!isSessionId(x.id) || this.sessions.has(x.id)) continue;
      const alive = !x.ended && this.agentAlive(x);
      if (!alive && !x.pinned) continue;
      const s: Session = {
        id: x.id, meta: x.meta ?? {}, launch: x.launch ?? {}, launcherPid: x.launcherPid, serverPid: x.serverPid, partition: `hb-${x.id}`, tabs: [],
        activity: x.activity ?? [], timeline: (x.timeline ?? []).map(t => ({ ...t, url: t.url ?? '' })), uses: x.uses ?? 0, held: false, pinned: !!x.pinned, muted: !!x.muted,
        lastActivity: x.lastActivity, lastInteraction: x.lastInteraction,
        ended: !alive, endedAt: alive ? undefined : x.endedAt ?? Date.now(), endReason: alive ? undefined : x.endReason ?? 'Launcher exited during the app restart',
      };
      this.sessions.set(s.id, s);
      try { await this.restoreBrowser(s, x); } catch (e: any) { log(`session ${s.id}: restore failed: ${e.message}`); }
      log(`session ${s.id} restored (${s.tabs.length} tabs, ${alive ? 'waiting for its launcher' : 'kept'})`);
    }
    for (const s of this.sessions.values()) stepIds = Math.max(stepIds, ...s.timeline.map(x => x.id));
    this.cleanTimelines();
    if (saved.selected && this.sessions.get(saved.selected)?.tabs.length) this.selected = saved.selected;
    this.fixSelection();
    this.onLayout();
    this.onChange();
  }

  private async restoreBrowser(s: Session, x: SavedSession): Promise<void> {
    const tabs = (x.tabs ?? []).map((t, index) => ({ ...t, index })).filter(t => t.url);
    // Saved steps name their tab by its index; the new tabs get new ids.
    const steps = s.timeline;
    s.timeline = [];
    if (!tabs.length) return;
    if (x.cookies?.length && !this.profilePartition(s)) await setCookies(electronSession.fromPartition(s.partition), x.cookies);
    await this.ensureBrowser(s);
    for (const [i, t] of tabs.entries()) {
      // The browser starts with one blank tab: it becomes the first one.
      const tab = i === 0 ? s.tabs[0] : await this.createTab(s, t.url, false);
      for (const step of steps) if (step.tab === t.index) s.timeline.push({ ...step, tab: tab.id });
      if (i === 0) tab.view.webContents.loadURL(t.url).catch(() => {});
      if (t.usedAt !== undefined) tab.usedAt = t.usedAt;
      if (t.own) tab.own = true;
      // Older saves have the agent's size as fixedSize.
      const fixed = (t as { fixedSize?: { width: number; height: number } }).fixedSize;
      if (t.emulation?.by === 'agent' || (!t.emulation && fixed)) {
        const e = t.emulation ?? { ...fixed!, dpr: 0, mobile: false, zoom: 1 };
        void this.agentSize(tab, e.width, e.height, e.dpr, e.mobile, typeof e.zoom === 'number' ? e.zoom : 1);
      } else if (t.emulation) this.emulate(tab, t.emulation);
      if (t.active) s.active = tab;
    }
    s.timeline.sort((a, b) => a.id - b.id);
    for (const t of s.tabs) if (isActiveTab(s, t)) this.thumbSoon(s, 800, t);
  }

  // MARK: Timeline

  timelineDir(s: Session): string { return path.join(paths.timeline, s.id); }

  /**
   * Adds a finished tool call to the timeline and takes the screenshot at
   * once: the launcher reports the end before the agent gets the answer, so
   * the next call cannot have changed the page yet. One screenshot is taken at
   * a time per session; steps that end meanwhile share the next one.
   */
  private recordStep(s: Session, a: Activity): void {
    // A call that closed a tab belongs to that tab, so it went with it.
    if (s.agentClosed) { s.agentClosed = false; return; }
    s.shotTab = s.agentTab ?? s.active;
    s.timeline.push({ ...a, id: ++stepIds, tab: s.shotTab?.id });
    if (s.timeline.length > MAX_STEPS) this.dropSteps(s, s.timeline.splice(0, s.timeline.length - MAX_STEPS));
    this.shoot(s);
  }

  private shoot(s: Session, settle = false): void {
    clearTimeout(s.shotTimer);
    s.shotTimer = undefined;
    if (s.shooting) { s.shootAgain = true; return; }
    const steps = settle ? (s.lastBatch ?? []).filter(x => s.timeline.includes(x)) : s.timeline.filter(x => x.url === undefined && !x.shooting);
    if (!steps.length) return;
    s.shooting = true;
    s.shootAgain = false;
    void this.captureSteps(s, steps, settle);
  }

  /**
   * Only taking the picture blocks the next screenshot; encoding and writing
   * run after it, one after another. A page that was still loading gets a
   * second look (settle) when no new call started meanwhile.
   */
  private async captureSteps(s: Session, steps: Step[], settle: boolean): Promise<void> {
    for (const x of steps) x.shooting = true;
    let shot: Awaited<ReturnType<SessionManager['grab']>>;
    try { shot = await this.grab(s, steps, settle); } catch (e: any) { log(`timeline ${s.id}: ${e.message}`); }
    s.shooting = false;
    if (s.shootAgain) this.shoot(s);
    s.storing = (s.storing ?? Promise.resolve())
      .then(() => shot && this.store(s, steps, shot.img, settle))
      .catch(e => log(`timeline ${s.id}: ${e.message}`))
      .then(() => {
        for (const x of steps) { x.url ??= ''; delete x.shooting; }
        this.onChange();
      });
    if (settle) return;
    s.lastBatch = steps;
    s.shotTimer ??= setTimeout(() => { if (!s.currentTool) this.shoot(s, true); }, SHOT_DELAY_MS);
  }

  /** Takes the picture of the agent's tab (the one of the last step). Without a tab: none. */
  private async grab(s: Session, steps: Step[], settle: boolean): Promise<{ img: Electron.NativeImage } | undefined> {
    let tab = s.shotTab;
    if (!tab || tab.view.webContents.isDestroyed()) tab = s.agentTab ?? s.active;
    const wc = tab?.view.webContents;
    if (!tab || !wc || wc.isDestroyed()) return undefined;
    // The steps belong to the tab in the screenshot.
    for (const x of steps) x.tab = tab.id;
    const url = wc.getURL(), title = wc.getTitle();
    // A view that produces no frames never answers: the timeline must go on.
    const img = await Promise.race([wc.capturePage(), new Promise<null>(r => setTimeout(() => r(null), SHOT_TIMEOUT_MS))]);
    if (!img) log(`timeline ${s.id}: no screenshot within ${SHOT_TIMEOUT_MS} ms`);
    if (!settle || img) for (const x of steps) { x.url = url; x.title = title; }
    return img && !img.isEmpty() ? { img } : undefined;
  }

  /** Writes the screenshot for the steps, unless the page looks as in the last one. */
  private async store(s: Session, steps: Step[], img: Electron.NativeImage, settle: boolean): Promise<void> {
    const size = img.getSize();
    const full = size.width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: 'good' }) : img;
    const jpeg = full.toJPEG(75);
    const hash = crypto.createHash('sha1').update(jpeg).digest('hex');
    const last = s.lastShot;
    if (last?.hash === hash && s.timeline.some(x => x.shot === last.name)) {
      // Unchanged: the steps share the last screenshot (if it is still kept).
      for (const x of steps) x.shot = last.name;
      return;
    }
    const old = settle ? steps[0]?.shot : undefined;
    const name = settle ? `${steps[0].id}-s` : String(steps[0].id);
    const dir = this.timelineDir(s);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(dir, `${name}.jpg`), jpeg, { mode: 0o600 });
    await fs.promises.writeFile(path.join(dir, `${name}-t.jpg`), img.resize({ width: SHOT_THUMB_WIDTH, quality: 'good' }).toJPEG(70), { mode: 0o600 });
    // Steps dropped meanwhile must not keep a file alive.
    if (!steps.some(x => s.timeline.includes(x))) { this.dropSteps(s, steps.map(x => ({ ...x, shot: name }))); return; }
    for (const x of steps) x.shot = name;
    s.lastShot = { hash, name };
    // The settled picture replaces the first one.
    if (old && old !== name) this.dropSteps(s, [{ ...steps[0], shot: old }]);
  }

  /** Removes steps; screenshots no other step uses are deleted. */
  private dropSteps(s: Session, gone: Step[]): void {
    const used = new Set(s.timeline.map(x => x.shot));
    for (const shot of new Set(gone.map(x => x.shot))) {
      if (!shot || used.has(shot)) continue;
      for (const f of [`${shot}.jpg`, `${shot}-t.jpg`]) fs.rm(path.join(this.timelineDir(s), f), { force: true }, () => {});
    }
  }

  /** The file of a step's full screenshot, if it is still kept. */
  stepShotFile(s: Session, stepId: number): string | undefined {
    const shot = s.timeline.find(x => x.id === stepId)?.shot;
    const file = shot && path.join(this.timelineDir(s), `${shot}.jpg`);
    return file && fs.existsSync(file) ? file : undefined;
  }

  /** A screenshot of a step as a data URL (full size or the small one), or null. */
  async stepImage(s: Session, stepId: number, thumb: boolean): Promise<string | null> {
    const shot = s.timeline.find(x => x.id === stepId)?.shot;
    if (!shot) return null;
    try {
      const data = await fs.promises.readFile(path.join(this.timelineDir(s), `${shot}${thumb ? '-t' : ''}.jpg`));
      return 'data:image/jpeg;base64,' + data.toString('base64');
    } catch { return null; }
  }

  /** At app start: deletes the timeline folders of sessions that did not come back. */
  private cleanTimelines(): void {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(paths.timeline); } catch { return; }
    for (const d of dirs) if (!this.sessions.has(d)) fs.rm(path.join(paths.timeline, d), { recursive: true, force: true }, () => {});
  }

  // MARK: Thumbnails

  /** Captures a tab a moment later (several triggers collapse into one). */
  thumbSoon(s: Session, delay = 800, tab = s.active): void {
    if (!tab || tab.thumbTimer) return;
    tab.thumbTimer = setTimeout(() => {
      tab.thumbTimer = undefined;
      void this.captureThumb(tab);
    }, delay);
  }

  private async captureThumb(tab: Tab): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    try {
      const img = await wc.capturePage();
      if (img.isEmpty()) return;
      tab.thumb = 'data:image/jpeg;base64,' + img.resize({ width: 160, quality: 'good' }).toJPEG(80).toString('base64');
      this.onThumb(tab);
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
      void this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: e.mobile, maxTouchPoints: 5 });
      void this.cdp(tab, 'Emulation.setEmitTouchEventsForMouse', { enabled: e.mobile, configuration: 'mobile' });
    }
    this.onLayout();
    this.onChange();
  }

  /**
   * Sets the agent's size for a tab (resize_page, --viewport): responsive mode
   * with this exact viewport, as with the agent's own emulation.
   */
  async agentSize(tab: Tab, width: number, height: number, dpr = 0, mobile = false, scale = 1): Promise<void> {
    tab.emulation = { width, height, dpr, mobile, zoom: scale, scale, by: 'agent' };
    this.onLayout();
    this.onChange();
    await Promise.all([
      this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false }),
      this.cdp(tab, 'Emulation.setEmitTouchEventsForMouse', { enabled: false }),
      this.cdp(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile, scale }),
    ]);
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
   * marked there; everything else comes from the user. A click takes control,
   * scrolling only keeps it. Mouse moves do not count. A key press counts only
   * after a click since the user came back to Habitab: switching apps with
   * Cmd+Tab sends key events to the page, too.
   */
  private pageInput(s: Session, tab: Tab, type: string): void {
    const pointer = type === 'mouseDown' || type === 'touchStart';
    const key = type === 'rawKeyDown' || type === 'keyDown';
    const start = pointer || (key && this.pointerSinceFocus);
    const keep = type === 'mouseWheel' || type === 'gestureScrollBegin';
    if (!start && !keep) return;
    this.thumbSoon(s, 1500, tab);
    const since = Date.now() - tab.agentInputAt;
    // A stuck counter (lost answer) stops counting after 10 s.
    if ((tab.agentInputs > 0 && since < 10_000) || since < 500) return;
    this.used(s, tab);
    if (this.pausesDebugger(s)) void this.pauseDebugger(s, tab, true);
    if (pointer) this.pointerSinceFocus = true;
    if (tab.own) this.interaction(s);
    else this.userInput(s, start, tab);
  }

  /**
   * The user acts in a session: control goes to the user until a pause. With
   * a tab, only of that tab: the agent goes on in its other tabs.
   */
  userInput(s: Session, start = true, tab?: Tab): void {
    this.interaction(s);
    if (s.ended || !s.line) return;
    if (s.held && !s.autoResumeAt) return; // Manual control: until Resume.
    // Only a click or key press takes control (of a tab that is not held yet); scrolling keeps it.
    const added = !s.held || (!!tab && !!s.heldTabs && !s.heldTabs.has(tab));
    if (added && !start) return;
    // Restart the countdown at most every half second.
    if (!added && s.autoResumeAt && s.autoResumeAt - Date.now() > AUTO_RESUME_MS - 500) return;
    this.setHold(s, true, true, tab && [tab]);
  }

  /** The user left Habitab: automatic control ends at once (manual control stays). */
  releaseAutoHolds(): void {
    this.pointerSinceFocus = false;
    for (const s of this.sessions.values()) if (s.held && s.autoResumeAt) this.setHold(s, false);
  }

  /**
   * Button and menu: the page of the front tab opens again in a new tab of the
   * same session (same cookies and storage), only for the user. The agent goes
   * on in its tab at once, and the user's input in the new tab does not hold it.
   * Only the URL goes over, not the state inside the page.
   */
  async forkTab(s: Session): Promise<void> {
    const from = s.active;
    if (!from || from.own || s.ended) return;
    const url = from.view.webContents.getURL();
    const tab = await this.createTab(s, url || 'about:blank', true);
    tab.own = true;
    if (from.emulation?.by === 'user') this.emulate(tab, from.emulation);
    this.used(s, tab);
    if (s.held) this.setHold(s, false);
    this.onChange();
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
      // A restored session whose launcher exited before it could reconnect.
      if (!s.ended && !s.line && !this.agentAlive(s)) {
        s.endReason = 'Browser bridge exited without signing off';
        this.end(s);
      }
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

  /**
   * CPU use of each tab's renderer process (also its audio worklets). A tab is
   * busy after three samples in a row above 50 % of a core, and calm again
   * after three below 30 %. Called every few seconds.
   */
  cpuCheck(): void {
    // Electron gives a share of all cores; the limits are for one core.
    const cores = os.cpus().length;
    const cpu = new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.percentCPUUsage * cores]));
    for (const s of this.sessions.values()) {
      for (const t of s.tabs) {
        if (t.view.webContents.isDestroyed()) continue;
        const use = cpu.get(t.view.webContents.getOSProcessId()) ?? 0;
        this.hangCheck(s, t, use);
        const change = t.busy ? use < 30 : use > 50;
        t.cpuSamples = change ? (t.cpuSamples ?? 0) + 1 : 0;
        if (t.cpuSamples < 3) continue;
        t.busy = !t.busy;
        t.cpuSamples = 0;
        this.onChange();
      }
    }
  }

  /** A page's draw calls of the last second (page-preload.ts). */
  drawReport(webContentsId: number, draws: number): void {
    const tab = this.tabOf(webContentsId);
    if (!tab || !Number.isFinite(draws)) return;
    // The page draws less while it holds its frames for gpuCheck, and not at all while paused.
    if (tab.gpuPaused) { tab.pausedDraws = draws; tab.pausedDrawsAt = Date.now(); draws = 0; }
    else if (Date.now() < (tab.holdUntil ?? 0)) { tab.drawsAt = Date.now(); return; }
    tab.draws = draws;
    tab.drawsAt = Date.now();
  }

  private gpuChecking = false;

  /**
   * Which tab loads the GPU. All tabs share Chromium's GPU process, and only
   * its GPU time as a whole is known (gpu.ts). With one drawing tab, the load
   * is that tab's. With more and a high load, one of them at a time holds its
   * animation frames for a moment (each one every 15 s at most); what the
   * load goes down by (against the load before and after) is its share. A
   * share is shown until a newer one is found (30 s at most). A tab is busy
   * above 250 ms/s (a quarter of the GPU) and calm again below 100 ms/s.
   * A share above 500 ms/s for 15 s (and in two measurements at least)
   * pauses the page's animation (pauseGpu).
   * Called every few seconds; a check takes up to 4 s.
   */
  async gpuCheck(): Promise<void> {
    if (this.gpuChecking) return;
    this.gpuChecking = true;
    try { await this.gpuCheckOnce(); } catch (e: any) { log(`gpuCheck: ${e.message}`); } finally { this.gpuChecking = false; }
  }

  private async gpuCheckOnce(): Promise<void> {
    const now = Date.now();
    const tabs = [...this.sessions.values()].flatMap(s => s.tabs).filter(t => t.view && !t.view.webContents.isDestroyed());
    const drawing = tabs.filter(t => t.draws && now - (t.drawsAt ?? 0) < 3_000);
    const set = (t: Tab, ms: number | undefined) => {
      const before = gpuShown(t);
      t.gpu = ms;
      t.gpuAt = ms === undefined ? undefined : Date.now();
      t.gpuHits = ms !== undefined && ms >= GPU_PAUSE_MS ? (t.gpuHits ?? 0) + 1 : 0;
      const v = ms ?? 0;
      if (t.gpuBusy ? v < GPU_BUSY_MS * 0.4 : v > GPU_BUSY_MS) t.gpuBusy = !t.gpuBusy;
      return gpuShown(t) !== before;
    };
    let changed = false;
    for (const t of tabs) {
      if (!drawing.includes(t) || now - (t.gpuAt ?? 0) > 30_000) changed = set(t, undefined) || changed;
      if (this.escalateGpu(t, now)) changed = true;
    }
    const pid = app.getAppMetrics().find(m => m.type === 'GPU')?.pid;
    if (!drawing.length || !pid) { if (changed) this.onChange(); return; }
    const load = async (ms: number) => {
      const a = await gpuTimeNs(pid);
      const t0 = Date.now();
      await sleep(ms);
      const b = await gpuTimeNs(pid);
      return a === undefined || b === undefined ? undefined : (b - a) / 1e6 / ((Date.now() - t0) / 1000);
    };
    const all = await load(1000);
    if (all === undefined) { if (changed) this.onChange(); return; }
    if (process.env.HABITAB_GPU_TRACE) log(`gpu: ${Math.round(all)} ms/s; draws/s: ${drawing.map(t => `${t.view.webContents.getURL().slice(0, 80)} ${t.draws}`).join(', ')}`);
    if (drawing.length === 1) {
      changed = set(drawing[0], all) || changed;
    } else if (all > GPU_BUSY_MS) {
      // The tab with the oldest share, not again within 15 s (the freeze
      // stops its animation for a moment), and not the tab the agent is
      // sending input to right now.
      const t = drawing.filter(t => !t.agentInputs && now - (t.gpuAt ?? 0) > 15_000).sort((a, b) => (a.gpuAt ?? 0) - (b.gpuAt ?? 0))[0];
      if (t) {
        const held = await this.holdingFrames(t, () => sleep(500).then(() => load(1000)));
        // The load also afterwards: a page that stopped drawing meanwhile is no share of this tab.
        await sleep(300);
        const after = await load(1000);
        if (held != null && after !== undefined) changed = set(t, Math.max(0, Math.min(all, after) - held)) || changed;
        if (process.env.HABITAB_GPU_TRACE) log(`gpu: ${Math.round(all)} ms/s, ${Math.round(held ?? NaN)} while ${t.view.webContents.getURL().slice(0, 80)} holds its frames`);
      }
    } else {
      for (const t of drawing) changed = set(t, undefined) || changed;
    }
    for (const t of drawing) {
      if (t.gpuAllowed || (t.gpu ?? 0) < GPU_PAUSE_MS) { t.gpuSince = undefined; continue; }
      t.gpuSince ??= now;
      const page = this.pageOf(t.id);
      // Two measurements at least: one wrong one does not stop a page.
      if (page && now - t.gpuSince >= GPU_PAUSE_AFTER && (t.gpuHits ?? 0) >= 2) { this.pauseGpu(page.s, t); changed = true; }
    }
    if (changed) this.onChange();
  }

  /**
   * The page has loaded the GPU too much for too long: its animation frames
   * wait (page-preload.ts; the page shows its last frame) until it loads
   * again or the user resumes it (resumeGpu). The agent gets a note.
   */
  pauseGpu(s: Session, tab: Tab): void {
    const wc = tab.view.webContents;
    tab.gpuPaused = gpuShown(tab) || 10;
    tab.gpuLevel = 1;
    tab.gpuLevelAt = Date.now();
    tab.gpuSince = tab.gpu = tab.gpuAt = undefined;
    tab.gpuHits = 0;
    tab.gpuBusy = false;
    tab.draws = 0;
    wc.send('habitab:hold-frames', 1);
    log(`gpu: paused ${wc.getURL()} (${tab.gpuPaused} %)`);
    const title = wc.getTitle();
    this.pushToAgent(s, [
      NOTE_HEAD,
      `The browser paused the animation of the page ${wc.getURL()}${title ? ` ("${title}")` : ''}. Its drawing used about ${tab.gpuPaused} % of the GPU for more than ${Math.round(GPU_PAUSE_AFTER / 1000)} s, which slows down the user's whole computer.`,
      "While paused, the page's requestAnimationFrame callbacks wait (and its timers too, if it keeps drawing): the page shows its last frame, also in screenshots. It runs again when the page loads anew (reload or navigation), or when the user resumes it. If it still keeps drawing, the browser stops the page.",
      'Make the drawing cheaper before you go on: for example a lower resolution or pixel ratio, less work per pixel or vertex, fewer passes, or drawing only when something changes. Then reload the page and check that it runs without a high load.',
    ].join('\n'));
    this.onChange();
  }

  /**
   * A paused page that still draws (10 calls a second or more, after the
   * hold took effect): level 2 holds its timers too, level 3 stops its
   * renderer (the tab is empty until it loads again) and tells the agent.
   * Pages that draw from message events, workers or a loop of their own
   * get past the first two levels.
   */
  private escalateGpu(tab: Tab, now: number): boolean {
    const level = tab.gpuLevel ?? 0;
    if (!tab.gpuPaused || level >= 3) return false;
    // A report that covers the time after the last step only (reports come once a second).
    if ((tab.pausedDraws ?? 0) < 10 || (tab.pausedDrawsAt ?? 0) < (tab.gpuLevelAt ?? 0) + 1_100 || now - (tab.pausedDrawsAt ?? 0) > 2_500) return false;
    const wc = tab.view.webContents;
    tab.gpuLevel = level + 1;
    tab.gpuLevelAt = now;
    tab.pausedDraws = 0;
    if (tab.gpuLevel === 2) {
      wc.send('habitab:hold-frames', 2);
      log(`gpu: holds the timers of ${wc.getURL()} too`);
      return true;
    }
    const url = wc.getURL(), title = wc.getTitle();
    log(`gpu: stops ${url}`);
    tab.gone = 'stopped';
    wc.forcefullyCrashRenderer();
    const page = this.pageOf(tab.id);
    if (page) this.pushToAgent(page.s, [
      NOTE_HEAD,
      `The browser stopped the page ${url}${title ? ` ("${title}")` : ''}: it kept drawing and loading the GPU although its animation frames and timers were paused. The tab is empty until it loads again (reload or navigation).`,
      'Find what keeps drawing (for example a loop driven by message events, a worker or a loop of its own) and make the drawing cheaper before you load the page again.',
    ].join('\n'));
    return true;
  }

  /** The user lets the paused page run again (a stopped one loads again); it is not paused again until it loads anew. */
  resumeGpu(tab: Tab): void {
    if (!tab.gpuPaused) return;
    if (tab.gpuLevel === 3) { tab.view.webContents.reload(); return; }
    tab.gpuPaused = tab.gpuLevel = undefined;
    tab.gpuAllowed = true;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send('habitab:hold-frames', 0);
    this.onChange();
  }

  /** Runs `fn` while the tab's page holds its animation frames (page-preload.ts). */
  private async holdingFrames<T>(tab: Tab, fn: () => Promise<T>): Promise<T | undefined> {
    const wc = tab.view.webContents;
    tab.holdUntil = Infinity;
    wc.send('habitab:hold-frames', true);
    try { return await fn(); } finally {
      // The page's next report still covers part of the hold.
      tab.holdUntil = Date.now() + 1_200;
      if (!wc.isDestroyed()) wc.send('habitab:hold-frames', false);
    }
  }

  /**
   * A page whose renderer uses most of a core may be stuck in its
   * JavaScript: it gets a tiny script, and one that does not answer within
   * 5 s counts as hung. A page hung for HANG_STOP_MS is stopped. A page
   * paused in a debugger uses no CPU, so it is never asked.
   */
  private hangCheck(s: Session, tab: Tab, cpu: number): void {
    const wc = tab.view.webContents;
    if (tab.gone) return;
    if (tab.hungSince && Date.now() - tab.hungSince >= HANG_STOP_MS) {
      this.stopPage(s, tab, `its JavaScript did not respond for more than ${Math.round(HANG_STOP_MS / 1000)} s while it used a full CPU core (most likely a loop that does not end)`);
      return;
    }
    if (tab.pinging || cpu < 80) return;
    tab.pinging = true;
    let answered = false;
    const timer = setTimeout(() => {
      tab.pinging = false;
      if (answered || tab.gone || wc.isDestroyed()) return;
      if (!tab.hungSince) { tab.hungSince = Date.now(); log(`page not responding: ${wc.getURL()}`); this.onChange(); }
    }, 5_000);
    wc.executeJavaScript('0').then(() => {
      answered = true;
      clearTimeout(timer);
      tab.pinging = false;
      if (tab.hungSince) { tab.hungSince = undefined; this.onChange(); }
    }, () => {});
  }

  /**
   * Ends the page's renderer: the tab is empty until it loads again (Reload
   * Page in the top bar). The agent gets a note with the reason; `byUser`:
   * the user stopped it.
   */
  stopPage(s: Session, tab: Tab, reason: string, byUser = false): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || tab.gone) return;
    const url = wc.getURL(), title = wc.getTitle();
    log(`stops ${url}: ${reason}`);
    tab.hungSince = undefined;
    tab.gone = 'stopped';
    wc.forcefullyCrashRenderer();
    this.pushToAgent(s, [
      NOTE_HEAD,
      `${byUser ? 'The user stopped' : 'The browser stopped'} the page ${url}${title ? ` ("${title}")` : ''}: ${reason}. The tab is empty until it loads again (reload or navigation).`,
      'Find and fix the cause before you load the page again, so that it does not get stuck again.',
    ].join('\n'));
    this.onChange();
  }

  /** Reload that also works for a hung page: it is stopped first (its renderer would not answer). */
  reload(s: Session, tab: Tab): void {
    const wc = tab.view.webContents;
    if (tab.hungSince) this.stopPage(s, tab, 'it did not respond, and the user reloaded it', true);
    wc.reload();
  }

  /**
   * Control for the user, or back to the agent. Automatic control with tabs
   * holds only these tabs (added to the ones held automatically already);
   * else all tabs.
   */
  setHold(s: Session, hold: boolean, auto = false, tabs?: Iterable<Tab>): void {
    const wasAuto = !!s.autoResumeAt;
    clearTimeout(s.resumeTimer);
    s.resumeTimer = s.autoResumeAt = undefined;
    if (hold && auto) {
      s.autoResumeAt = Date.now() + AUTO_RESUME_MS;
      s.resumeTimer = setTimeout(() => this.setHold(s, false), AUTO_RESUME_MS);
    }
    const before = holdScope(s);
    // Tabs held automatically so far: none, or all (undefined). Manual control does not count: it ends here.
    const prev = s.held && wasAuto ? s.heldTabs : new Set<Tab>();
    s.heldTabs = hold && auto && tabs && prev ? new Set([...prev, ...tabs]) : undefined;
    s.held = hold;
    if (holdScope(s) !== before) s.line?.send(holdMessage(s));
    if (!hold) s.waiting = s.holdNoted = false;
    this.onChange();
  }

  // MARK: Context menu

  private contextMenu(s: Session, tab: Tab, p: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents;
    const items: MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      items.push({ label: 'Open Link in New Tab', click: () => void this.createTab(s, p.linkURL, true).then(t => { t.own = tab.own; this.onChange(); }) });
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
      { type: 'separator' },
      { label: 'Send Element to Agent…', click: () => this.onSendElement(s, tab, p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup();
  }
}

/** What a page may ask the user for. */
export type SiteAccess = 'media' | 'clipboard';
const ACCESS_PREF = { media: 'mediaAccess', clipboard: 'clipboardAccess' } as const;

/** "http://localhost:5173" for a URL or origin; the input itself if it is no URL. */
function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** Copies all cookies from one partition to another (sessions stay signed in). */
async function copyCookies(from: Electron.Session, to: Electron.Session): Promise<void> {
  await setCookies(to, await from.cookies.get({}));
}

async function setCookies(to: Electron.Session, cookies: Electron.Cookie[]): Promise<void> {
  for (const c of cookies) {
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
