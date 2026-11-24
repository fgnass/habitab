// Habitab app: one window with the session list on the left and the real
// Chromium view of the selected session on the right, DevTools docked.
import { app, BaseWindow, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, ShareMenu, shell, systemPreferences, WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ensureHome, log, openLog, paths } from '../shared/paths';
import { installLauncher } from '../installer/installer';
import { desktopEnv, installDesktopEntry } from '../shared/platform';
import { prefs, setPrefs, SidebarMode, sidebarMode } from './prefs';
import { Session, SessionManager, SiteAccess, Tab } from './sessions';
import { nearestModel, SpeechEvent, SpeechService } from './speech';
import type { Download } from './downloads';
import { uiState } from './ui-state';

/** Sidebar widths: thumbnails with titles, thumbnails only (room for the window buttons), none. */
const SIDEBAR_WIDTH: Record<SidebarMode, number> = { full: 280, compact: 84, hidden: 0 };
const sidebarWidth = () => SIDEBAR_WIDTH[sidebarMode()];
const TOPBAR = 46;
/** Height of the responsive mode bar above an emulated page. */
const RBAR = 38;
/** Space around an emulated page in responsive mode (room for the resize handles). */
const FRAME_SIDE = 18, FRAME_TOP = 10, FRAME_BOTTOM = 20;
/** Height of the status line under the top bar (closed); opened, it grows down over the page. */
const STATUSBAR = 28;
/** Height of the timeline's thumbnails below the status line (see status.html). */
const STRIP = 59;
/** DevTools get at least this width (the settings dialog needs it), the page at least PAGE_MIN. */
const DEVTOOLS_MIN = 520;
const PAGE_MIN = 320;
const UI = path.join(__dirname, '..', 'ui');

ensureHome();
openLog('app');
// Embedded Chromium data (in-memory partitions; only app-level caches here).
app.setPath('userData', paths.chromium);
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
// http dev origins the user marked as secure (session menu); Chromium reads them only here.
if (prefs().secureOrigins?.length) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', prefs().secureOrigins!.join(','));

if (!app.requestSingleInstanceLock()) app.quit();

// Tests run next to the user's work: no Dock icon, never activated, and an
// invisible window that ignores the mouse (it still renders, so screenshots
// work). HABITAB_TEST_VISIBLE=1 shows it, e.g. for the showcase.
const testControl = process.env.HABITAB_TEST_CONTROL === '1';
const testHidden = testControl && process.env.HABITAB_TEST_VISIBLE !== '1';
/**
 * Started by a launcher (Linux): the window stays hidden, like `open -g -j` on macOS.
 * GNOME gives every new window the focus, also with showInactive() or minimize().
 * Opening Habitab from the dock or the applications shows it (second-instance).
 */
const background = process.env.HABITAB_BACKGROUND === '1';
delete process.env.HABITAB_BACKGROUND;
if (testHidden && process.platform === 'darwin') app.setActivationPolicy('accessory');

// Errors never block the app with a modal dialog: they go to the log and
// appear as a small notice in the sidebar.
const errors: { message: string; at: number }[] = [];
function reportError(kind: string, e: unknown): void {
  const err = e as Error;
  log(`${kind}: ${err?.stack ?? err}`);
  errors.push({ message: String(err?.message ?? err).slice(0, 200), at: Date.now() });
  if (errors.length > 20) errors.shift();
  if (manager) publish();
}
process.on('uncaughtException', e => reportError('uncaughtException', e));
process.on('unhandledRejection', e => reportError('unhandledRejection', e));

let win: BaseWindow;
let sidebar: WebContentsView, topbar: WebContentsView, empty: WebContentsView, responsive: WebContentsView, splitter: WebContentsView, annotator: WebContentsView, status: WebContentsView, timeline: WebContentsView, link: WebContentsView, find: WebContentsView;
/** Height the status line needs (it reports it). */
let statusHeight = STATUSBAR;
/** Marking mode: the annotator overlay lies over the selected page. */
let annotating = false;
/** While the user marks, the agent's commands wait: the session held for it, and the control it had before (put back after). */
let annotateHold: { s: Session; before: 'none' | 'auto' | 'manual'; tabs?: Set<Tab> } | null = null;
/** What the user marked, taken at once (by the overlay's id of the mark): the page may change before the comments are written. */
const marks = new Map<number, { tab: Tab; rect: Electron.Rectangle; done: Promise<Mark>; now?: Electron.Rectangle | null }>();
/** Marks the user kept to send together with the next one (the overlay reports how many). */
let annotateKept = 0;
/** A marked area with the user's comment, as the overlay sends it (`id`: its mark). */
type Note = { id?: number; rect: Electron.Rectangle; text: string; dictated?: boolean };
type Mark = { image: Electron.NativeImage; url: string; css: Electron.Rectangle; page: { title: string; primary: string[]; inside: string[]; scroll?: { x: number; y: number } } };
/** The page's frame in the overlay, as last sent to it (JSON). */
let annotateFrame = '';
/** Find in page: the bar lies at the top right of the selected page; the running query, its tab and the key hook. */
let findOpen = false, findText = '';
let findTab: Tab | undefined;
let findKeyHandler: ((e: Electron.Event, input: Electron.Input) => void) | undefined;
const FIND_W = 340, FIND_H = 40;
/** The status line is open (the timeline); with an older change chosen, its screenshot lies over the page. */
let timelineOpen = false, timelinePreview = false;
/** The change the user chose in the timeline (its first step's id); null: live, the page itself. */
let timelineStep: number | null = null;
/**
 * What the preview view shows, as it reports it ('timelineShown'). Until it
 * shows the chosen change, the view stays under the page: shown at once, it
 * would show its last picture first (maybe of another session).
 */
let previewShown: { session: string; step: number } | null = null;
/** Height of the bubble with the hovered link's URL; it sits at the right edge when the pointer is on the left. */
const LINK = 24;
let linkRight = false;
/** Short message in the top bar, e.g. after copying to the clipboard. */
let notice: { text: string; until: number } | undefined;
/** The last download: the status line shows it while it runs and a short while after. */
let download: (Download & { at: number }) | undefined;
let downloadPublished = 0;
const DOWNLOAD_SHOWN = 8000;
let manager: SessionManager;
let devtoolsRatio = prefs().devtoolsRatio ?? 0.42;
let splitting = false;

/** Width of the page next to docked DevTools. */
function pageWidthWithDevtools(width: number): number {
  let dt = Math.round(width * devtoolsRatio);
  dt = Math.max(dt, Math.min(DEVTOOLS_MIN, width - PAGE_MIN));
  return width - Math.min(dt, width - PAGE_MIN);
}
let upstream = '';
let setupWindow: BrowserWindow | undefined;
let quitting = false;

function upstreamUrl(): string {
  if (upstream) return upstream;
  const [port, wsPath] = fs.readFileSync(path.join(app.getPath('userData'), 'DevToolsActivePort'), 'utf8').trim().split('\n');
  upstream = `ws://127.0.0.1:${port}${wsPath}`;
  return upstream;
}

function uiView(file: string): WebContentsView {
  const v = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  v.setBackgroundColor('#00000000');
  // State is only pushed on change, so a freshly loaded view needs its own copy.
  v.webContents.on('did-finish-load', publish);
  void v.webContents.loadFile(path.join(UI, file));
  win.contentView.addChildView(v);
  return v;
}

function layout(): void {
  if (!win || win.isDestroyed() || quitting) return;
  const { width, height } = win.getContentBounds();
  const SIDEBAR = sidebarWidth();
  sidebar.setVisible(SIDEBAR > 0);
  sidebar.setBounds({ x: 0, y: 0, width: Math.max(SIDEBAR, 1), height });
  topbar.setBounds({ x: SIDEBAR, y: 0, width: width - SIDEBAR, height: TOPBAR });
  const selected = manager.sessions.get(manager.selected ?? '');
  if (timelineOpen && !selected) timelineOpen = false;
  // The timeline is the front tab's: another tab (or session) ends the preview of an earlier step.
  if (timelinePreview && !selected?.timeline.some(x => x.id === timelineStep && x.tab === selected.active?.id)) { timelinePreview = false; timelineStep = null; previewShown = null; }
  const previewReady = timelinePreview && previewShown?.session === selected?.id && previewShown?.step === timelineStep;
  // The status line takes the same room in every session, so switching sessions resizes no page.
  const bar = selected ? STATUSBAR : 0;
  const area = { x: SIDEBAR, y: TOPBAR + bar, width: width - SIDEBAR, height: height - TOPBAR - bar };
  // All page views stay visible and stacked in the content area; the
  // selected tab is on top. A view that is hidden or removed stops
  // producing frames, and the agent's screenshots would hang.
  const order: WebContentsView[] = [];
  let framesChanged = false;
  for (const s of manager.sessions.values()) {
    const isSel = s === selected;
    const dt = isSel && s.devtools && s.devtoolsTab === s.active;
    const pageWidth = dt ? pageWidthWithDevtools(area.width) : area.width;
    for (const t of s.tabs) {
      if (t.view.webContents.isDestroyed()) continue;
      const centered = (w: number, top: number) => ({ x: area.x + Math.max(0, Math.round((pageWidth - w) / 2)), y: top });
      const e = t.emulation;
      if (e) {
        // Responsive mode: the emulated viewport below the bar. Filled dimensions
        // take the free space; with zoom "fit" a larger viewport is scaled down.
        const room = { width: Math.max(50, pageWidth - 2 * FRAME_SIDE), height: Math.max(50, area.height - RBAR - FRAME_TOP - FRAME_BOTTOM) };
        // The agent's size is always shown whole: scaled down when it does not fit (the agent sees no change).
        const width = e.by === 'user' && e.fillWidth ? room.width : e.width, height = e.by === 'user' && e.fillHeight ? room.height : e.height;
        const fit = Math.min(1, room.width / width, room.height / height);
        const wanted = e.zoom === 'fit' ? fit : e.by === 'agent' ? Math.min(e.zoom, fit) : e.zoom;
        manager.applyEmulation(t, width, height, Math.max(0.1, Math.round(wanted * 1000) / 1000));
        const scale = e.scale ?? 1;
        const w = Math.round(e.width * scale), h = Math.round(e.height * scale);
        const pos = centered(w, area.y + RBAR + FRAME_TOP);
        t.view.setBounds({ ...pos, width: w, height: h });
        const frame = { x: pos.x - area.x, y: pos.y - area.y, width: w, height: h, scale };
        if (JSON.stringify(frame) !== JSON.stringify(t.frame)) { t.frame = frame; framesChanged = true; }
      } else {
        t.view.setBounds({ ...area, width: pageWidth });
      }
      t.view.setVisible(true);
      if (!(isSel && t === s.active)) order.push(t.view);
    }
    if (s.devtools && !s.devtools.webContents.isDestroyed()) {
      s.devtools.setVisible(!!dt);
      // With the timeline open, DevTools start below its thumbnails (the page keeps its size).
      const below = timelineOpen ? STRIP : 0;
      s.devtools.setBounds(dt ? { x: area.x + pageWidth, y: area.y + below, width: area.width - pageWidth, height: Math.max(1, area.height - below) } : { x: 0, y: 0, width: 1, height: 1 });
    }
  }
  // The preview with a picture that is not the chosen one yet: under the background, where it renders unseen.
  if (timelinePreview && !previewReady) order.push(timeline);
  // Background behind the selected page (also covers other sessions).
  empty.setBounds(area);
  empty.setVisible(true);
  order.push(empty);
  // A tab whose webContents is gone (the 'destroyed' event is still running) has no view to show.
  const sel = selected?.active?.view.webContents && !selected.active.view.webContents.isDestroyed() ? selected.active : undefined;
  const selDevtools = !!selected?.devtools && selected.devtoolsTab === sel;
  const selPageWidth = selDevtools ? pageWidthWithDevtools(area.width) : area.width;
  if (sel) order.push(sel.view);
  // The responsive mode bar: with the timeline open, below its thumbnails, over the page (the page keeps its size).
  responsive.setVisible(!!sel?.emulation);
  responsive.setBounds(sel?.emulation ? { x: area.x, y: area.y + (timelineOpen ? STRIP : 0), width: selPageWidth, height: RBAR } : { x: 0, y: 0, width: 1, height: 1 });
  order.push(responsive);
  if (selDevtools) order.push(selected!.devtools!);
  // Status line: above the page and DevTools; opened, it grows down over them.
  // Its view also holds the floating details (taller only while they are open).
  const sh = Math.min(statusHeight, height - TOPBAR);
  status.setVisible(!!bar);
  status.setBounds(bar ? { x: area.x, y: TOPBAR, width: area.width, height: sh } : { x: 0, y: 0, width: 1, height: 1 });
  // The splitter sits on the edge; while dragging it covers the whole area to keep the pointer.
  splitter.setVisible(selDevtools);
  splitter.setBounds(!selDevtools ? { x: 0, y: 0, width: 1, height: 1 } : splitting ? area : { x: area.x + selPageWidth - 3, y: area.y, width: 7, height: area.height });
  order.push(splitter);
  // The screenshot of the timeline change the user chose: over the page (not DevTools), below the open status line.
  timeline.setVisible(timelinePreview);
  const top = TOPBAR + bar + STRIP;
  const shotBounds = { x: area.x, y: top, width: selPageWidth, height: Math.max(1, height - top) };
  timeline.setBounds(timelinePreview ? shotBounds : { x: 0, y: 0, width: 1, height: 1 });
  if (previewReady) order.push(timeline);
  // Marking mode: the overlay covers the page area (in responsive mode also the
  // room around the viewport, so the comment form is not cut off there), or that
  // screenshot. The user marks only inside the page: its frame in the overlay.
  if (annotating && !sel) { annotating = false; clearMarks(); releaseMarkHold(); }
  annotator.setVisible(annotating);
  if (annotating && sel) {
    // Another session came to the front while marking: now its agent waits.
    if (selected) holdForMark(selected);
    const page = sel.view.getBounds();
    const overlay = timelinePreview ? shotBounds : sel.emulation ? { x: area.x, y: area.y + RBAR, width: selPageWidth, height: Math.max(1, area.height - RBAR) } : page;
    annotator.setBounds(overlay);
    const frame = timelinePreview ? { x: 0, y: 0, width: overlay.width, height: overlay.height } : { x: page.x - overlay.x, y: page.y - overlay.y, width: page.width, height: page.height };
    const key = JSON.stringify(frame);
    if (key !== annotateFrame && !annotator.webContents.isDestroyed()) { annotateFrame = key; annotator.webContents.send('annotate-frame', frame); }
  } else annotator.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  order.push(annotator);
  // Opened, the status line lies over the page and that screenshot.
  order.push(status);
  // The hovered link's URL, at the bottom of the page. It must not lie under
  // the pointer, or the page would lose the hover: it goes to the right
  // instead, or stays hidden.
  let linkBounds: Electron.Rectangle | undefined;
  if (sel?.targetUrl && !annotating && !timelinePreview) {
    const b = sel.view.getBounds();
    const w = Math.min(b.width, Math.max(240, Math.round(b.width * 0.6)));
    const left = { x: b.x, y: b.y + b.height - LINK, width: w, height: LINK };
    const right = { ...left, x: b.x + b.width - w };
    const cb = win.getContentBounds(), p = screen.getCursorScreenPoint();
    const c = { x: p.x - cb.x, y: p.y - cb.y };
    const under = (r: Electron.Rectangle) => c.x >= r.x && c.x < r.x + r.width && c.y >= r.y - 4 && c.y < r.y + r.height;
    linkBounds = !under(left) ? left : !under(right) ? right : undefined;
    linkRight = linkBounds === right;
  }
  link.setVisible(!!linkBounds);
  link.setBounds(linkBounds ?? { x: 0, y: 0, width: 1, height: 1 });
  order.push(link);
  // The find bar, at the top right of the selected page (over it, under the status line).
  if (findOpen && !sel) findOpen = false;
  find.setVisible(findOpen);
  if (findOpen && sel) {
    const b = sel.view.getBounds();
    find.setBounds({ x: b.x + b.width - Math.min(FIND_W, b.width) - 12, y: b.y + 8, width: Math.min(FIND_W, b.width), height: FIND_H });
  } else find.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  order.push(find);
  for (const v of order) if (v.webContents && !v.webContents.isDestroyed()) win.contentView.addChildView(v);
  win.contentView.addChildView(sidebar);
  win.contentView.addChildView(topbar);
  // The resize handles (in the background view) follow the emulated page.
  if (framesChanged) publish();
}

let publishTimer: NodeJS.Timeout | undefined;
function publish(): void {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (quitting || win.isDestroyed()) return;
    const state = { ...uiState(manager), errors: errors.slice(-3), annotating, annotateKept, findText: findOpen ? findText : null, timelineOpen, timelinePreview, timelineStep, linkRight, notice: notice && notice.until > Date.now() ? notice.text : null, download: shownDownload() };
    for (const v of [sidebar, topbar, empty, responsive, annotator, status, timeline, link, find]) if (!v.webContents.isDestroyed()) v.webContents.send('state', state);
    updateMenu();
    manager.saveSoon();
  }, 50);
}

function selected(): Session | undefined { return manager.sessions.get(manager.selected ?? ''); }

function select(id: string, tabId?: number): void {
  const s = manager.sessions.get(id);
  if (!s) return;
  if (findOpen && (id !== manager.selected || (tabId !== undefined && tabId !== s.active?.id))) closeFind();
  manager.selected = id;
  if (tabId !== undefined) { s.active = s.tabs.find(t => t.id === tabId) ?? s.active; manager.thumbSoon(s, 300); }
  if (s.devtools && s.devtoolsTab !== s.active) { manager.closeDevtools(s); manager.toggleDevtools(s); }
  manager.throttle(s, false);
  layout();
  publish();
  focusView(s.active?.view);
}

/** Moves keyboard focus inside the window, but never takes focus from another app. */
function focusView(v: WebContentsView | undefined): void {
  if (v && win.isFocused()) v.webContents.focus();
}

// MARK: UI actions

ipcMain.handle('action', (_e, name: string, ...args: any[]) => action(name, ...args));

// Actions that change the page the agent works on: the user takes control.
const USER_ACTIONS = new Set(['navigate', 'back', 'forward', 'reload', 'stop', 'responsive', 'emulate']);

async function action(name: string, ...args: any[]): Promise<unknown> {
  const s = selected();
  // In the user's own tab the agent goes on.
  if (s && USER_ACTIONS.has(name) && !s.active?.own) manager.userInput(s, true, s.active);
  switch (name) {
    case 'select': return select(args[0], args[1]);
    case 'navigate': {
      if (!s?.active) return;
      return s.active.view.webContents.loadURL(normalizeUrl(args[0])).catch(() => {});
    }
    case 'back': return s?.active?.view.webContents.navigationHistory.goBack();
    case 'forward': return s?.active?.view.webContents.navigationHistory.goForward();
    case 'reload': return s?.active && manager.reload(s, s.active);
    // Top bar: the user stops the page that does not respond.
    case 'stopPage': return s?.active && manager.stopPage(s, s.active, 'it did not respond, and the user stopped it', true);
    case 'stop': return s?.active?.view.webContents.stop();
    case 'devtools': return s && manager.toggleDevtools(s);
    case 'closeTab': {
      const x = manager.sessions.get(args[0]), target = x?.tabs.find(t => t.id === args[1]);
      return x && target && manager.closeTab(x, target, 'button');
    }
    case 'hold': return s && manager.toggleHold(s);
    case 'fork': return s && manager.forkTab(s);
    case 'pin': { const x = manager.sessions.get(args[0]); if (x) { x.pinned = !x.pinned; publish(); } return; }
    case 'mute': return s && manager.setMuted(s, typeof args[0] === 'boolean' ? args[0] : !s.muted);
    // Top bar: turn the paused debugger of the front tab on now, or pause it (and keep the project option on).
    case 'debugger': {
      if (!s?.active) return;
      if (s.active.debuggerPaused) return manager.pauseDebugger(s, s.active, false);
      return manager.setPausesDebugger(s, true);
    }
    // Top bar: pause the animation of the front tab (high GPU load), or let it run again.
    case 'gpuPause': return s?.active && manager.pauseGpu(s, s.active);
    case 'gpuResume': return s?.active && manager.resumeGpu(s.active);
    case 'persistentProfile': { const x = manager.sessions.get(args[0]); if (x) { await manager.togglePersistentProfile(x); layout(); publish(); } return; }
    case 'sidebar': return toggleSidebarWidth();
    case 'annotate': return setAnnotating(args[0] ?? !annotating);
    // Find in page: open the bar (keys come from the page), step, close. findText is for programmatic use (tests).
    case 'find': return s?.active && openFind(s.active);
    case 'findText': {
      if (!findTab && s?.active) openFind(s.active);
      const a = args[0] ?? {};
      if (typeof a.text === 'string') findText = a.text;
      return runFind({ forward: a.forward ?? true, next: a.next });
    }
    case 'findStep': return void (findTab && runFind({ forward: args[0] !== false, next: true }));
    case 'findClose': return closeFind();
    case 'annotateMark': return s?.active && annotateMark(s.active, args[0]);
    case 'annotateDrop': return dropMark(args[0]);
    // A click on the sign of marks out of view: the page scrolls to the mark.
    case 'annotateShow': { const m = marks.get(args[0]); return void (m && !m.tab.view.webContents.isDestroyed() && m.tab.view.webContents.send('habitab:mark-show', args[0])); }
    case 'annotateKept': annotateKept = args[0]; return publish();
    // ⌥ held in the overlay: the user's mouse goes on to the page (a hover menu can open), in view coordinates of the page.
    case 'annotatePointer': return void (annotating && !timelinePreview && s?.active && annotatePointer(s.active, args[0]));
    // The status line's Send: the overlay sends its marks.
    case 'annotateSend': return void (annotating && !annotator.webContents.isDestroyed() && annotator.webContents.send('annotate-send'));
    case 'annotateSubmit': return s?.active && annotateSubmit(s, s.active, args[0]);
    // Console errors of the front tab: the button opens the DevTools console; its context menu sends them to the agent.
    case 'problems': return s?.active && manager.showConsole(s, s.active);
    case 'problemsMenu': return s?.active && problemsMenu(s, s.active, args[0], args[1]);
    case 'problemsSend': return s?.active && sendProblems(s, s.active, args[0]);
    case 'problemsClear': { if (s?.active) manager.clearProblems(s.active); return; }
    // Timeline: open or close, the large preview, screenshots of steps, open a step's URL.
    case 'timeline': return setTimelineOpen(typeof args[0] === 'boolean' ? args[0] : !timelineOpen);
    case 'timelinePreview': { timelineStep = typeof args[0] === 'number' && timelineOpen ? args[0] : null; timelinePreview = timelineStep !== null; if (!timelinePreview) previewShown = null; layout(); publish(); return; }
    // The preview view shows this change now (or nothing: null): it may come to the front.
    case 'timelineShown': { previewShown = typeof args[0] === 'string' && typeof args[1] === 'number' ? { session: args[0], step: args[1] } : null; layout(); return; }
    case 'statusHeight': { const h = Math.max(STATUSBAR, Math.round(args[0])); if (h !== statusHeight) { statusHeight = h; layout(); } return; }
    case 'timelineImages': {
      const x = manager.sessions.get(args[0]);
      if (!x) return {};
      const ids: number[] = args[1] ?? [];
      return Object.fromEntries(await Promise.all(ids.map(async id => [id, await manager.stepImage(x, id, !!args[2])])));
    }
    case 'timelineOpenUrl': {
      if (!s?.active || typeof args[0] !== 'string' || !/^https?:|^file:/.test(args[0])) return;
      manager.userInput(s, true, s.active);
      setTimelineOpen(false);
      return s.active.view.webContents.loadURL(args[0]).catch(() => {});
    }
    case 'sessionMenu': { const x = manager.sessions.get(args[0]); if (x) sessionMenu(x, args[1], args[2], args[3]); return; }
    case 'closeBrowser': { const x = manager.sessions.get(args[0]); if (x) { manager.closeBrowser(x); layout(); } return; }
    case 'remove': { const x = manager.sessions.get(args[0]); if (x) manager.remove(x); return; }
    case 'split': {
      // Splitter drag: start, move (screen x), end.
      if (args[0] === 'move') {
        const b = win.getContentBounds();
        const areaWidth = b.width - sidebarWidth();
        devtoolsRatio = Math.min(0.8, Math.max(0.15, (b.x + b.width - Number(args[1])) / areaWidth));
      } else {
        splitting = args[0] === 'start';
        if (!splitting) setPrefs({ devtoolsRatio });
      }
      layout();
      return;
    }
    case 'responsive': return s?.active && toggleResponsive(s.active);
    case 'emulate': {
      const e = s?.active?.emulation;
      if (!s?.active || !e) return;
      const patch = args[0] ?? {};
      const next = { ...e, ...patch };
      // The agent's size, now changed by the user: it fits the free space from now on.
      if (e.by === 'agent' && patch.zoom === undefined) next.zoom = 'fit';
      // A given size fixes that dimension, unless the change says to fill it.
      if (patch.width !== undefined && patch.fillWidth === undefined) next.fillWidth = false;
      if (patch.height !== undefined && patch.fillHeight === undefined) next.fillHeight = false;
      if (patch.rotate) [next.width, next.height, next.fillWidth, next.fillHeight] = [e.height, e.width, e.fillHeight, e.fillWidth];
      delete next.rotate;
      next.width = Math.max(50, Math.min(4000, Math.round(next.width)));
      next.height = Math.max(50, Math.min(4000, Math.round(next.height)));
      return manager.emulate(s.active, next);
    }
    case 'setup': return openSetup();
    case 'showDownload': return download && shell.showItemInFolder(download.file);
    case 'openLog': return shell.openPath(path.join(paths.logs, 'app.log'));
    case 'dismissErrors': errors.length = 0; publish(); return;
  }
}

/** Marking on or off. Off: the agent goes on, unless the hold is kept (released after the feedback went out). */
function setAnnotating(on: boolean, keepHold = false): void {
  const s = selected();
  annotating = on && !!s?.active;
  if (annotating && s) holdForMark(s);
  else { clearMarks(); if (!keepHold) releaseMarkHold(); }
  layout();
  publish();
  if (annotating) focusView(annotator);
}

function clearMarks(): void {
  for (const tab of new Set([...marks.values()].map(m => m.tab))) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send('habitab:unmark', null);
  marks.clear();
  annotateKept = 0;
}

/**
 * While the overlay is open, the agent's commands wait: what the user marks
 * must stay on the screen until the comment is written. Control the user
 * took stays as it was afterwards.
 */
function holdForMark(s: Session): void {
  if (annotateHold?.s === s) return;
  releaseMarkHold();
  if (s.ended || !s.line) return;
  annotateHold = { s, before: !s.held ? 'none' : s.autoResumeAt ? 'auto' : 'manual', tabs: s.heldTabs };
  if (annotateHold.before !== 'manual') manager.setHold(s, true);
}

function releaseMarkHold(): void {
  if (!annotateHold) return;
  const { s, before, tabs } = annotateHold;
  annotateHold = null;
  if (before === 'manual' || s.ended) return;
  // Meanwhile the user resumed the agent or took control: that stays.
  if (!s.held || s.autoResumeAt) return;
  if (before === 'auto') manager.setHold(s, true, true, tabs);
  else manager.setHold(s, false);
}

function setTimelineOpen(on: boolean): void {
  timelineOpen = on && !!selected();
  timelinePreview = false;
  timelineStep = null;
  previewShown = null;
  layout();
  publish();
  if (timelineOpen) focusView(status);
  else focusView(selected()?.active?.view);
}

/**
 * ⌘F: a find bar over the page. The page keeps keyboard focus — Chromium only
 * runs a find for a focused page — so the bar is display-only and the keys are
 * read from the page through before-input-event while the bar is open.
 */
function openFind(tab: Tab): void {
  if (findOpen && findTab !== tab) closeFind();
  findTab = tab;
  findOpen = true;
  const wc = tab.view.webContents;
  wc.focus();
  if (!findKeyHandler) { findKeyHandler = (_e, input) => onFindKey(input, _e); wc.on('before-input-event', findKeyHandler); }
  // Prefill from the page's selection (like Chrome).
  void wc.executeJavaScript('String(getSelection()).trim()', true).then(sel => {
    if (findOpen && findTab === tab && typeof sel === 'string' && sel && sel.length < 200) { findText = sel; runFind({ forward: true }); }
  }).catch(() => {});
  layout();
  publish();
}

/** A key while the find bar is open: type into the query, step, or close. */
function onFindKey(input: Electron.Input, e: Electron.Event): void {
  if (!findOpen || input.type !== 'keyDown') return;
  if (input.key === 'Escape') { e.preventDefault(); closeFind(); return; }
  if (input.key === 'Enter') { e.preventDefault(); runFind({ forward: !input.shift, next: true }); return; }
  if (input.key === 'Backspace') { e.preventDefault(); findText = findText.slice(0, -1); runFind({ forward: true }); return; }
  // A single printable character, no command/control/alt (⌘G, ⌘C, … pass through).
  if (input.key.length === 1 && !input.meta && !input.control && !input.alt) { e.preventDefault(); findText += input.key; runFind({ forward: true }); }
}

/** Runs the current query on the find tab; stepping with `next`. */
function runFind(f: { forward?: boolean; next?: boolean }): void {
  const wc = findTab?.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (!findText) { if (findTab) findTab.find = undefined; wc.stopFindInPage('clearSelection'); publish(); return; }
  wc.focus();
  wc.findInPage(findText, { findNext: !!f.next, forward: f.forward ?? true });
}

function closeFind(): void {
  if (!findOpen) return;
  findOpen = false;
  findText = '';
  const tab = findTab;
  findTab = undefined;
  if (tab && !tab.view.webContents.isDestroyed()) {
    if (findKeyHandler) tab.view.webContents.removeListener('before-input-event', findKeyHandler);
    tab.find = undefined;
    tab.view.webContents.stopFindInPage('keepSelection');
  }
  findKeyHandler = undefined;
  layout();
  publish();
}

/**
 * A page asks for camera/microphone or to read the clipboard: the user answers
 * in a sheet, and the answer is kept for the origin in this project (unless
 * unticked). A camera/microphone allow also asks macOS once to let Habitab
 * itself use the device.
 */
async function askSiteAccess(s: Session, kind: SiteAccess, origin: string, types: ('video' | 'audio')[]): Promise<boolean> {
  // Tests never show a sheet; they answer through the stored preference.
  if (testHidden) return false;
  const what = kind === 'clipboard' ? 'see text and images you copied to the clipboard'
    : `use your ${types.includes('video') && types.includes('audio') ? 'camera and microphone' : types.includes('audio') ? 'microphone' : 'camera'}`;
  const project = s.meta.projectName ?? 'this project';
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1,
    message: `${origin} wants to ${what}`,
    detail: `Asked by a page in “${project}”.${s.meta.client ? ` The agent (${s.meta.client}) may be using this tab.` : ''}`,
    checkboxLabel: `Remember for ${origin} in “${project}”`, checkboxChecked: true,
  });
  const allow = r.response === 0;
  if (r.checkboxChecked) manager.setSiteAccess(s, kind, origin, allow ? 'allow' : 'block');
  if (!allow || kind !== 'media' || process.platform !== 'darwin') return allow;
  for (const t of types) {
    const device = t === 'video' ? 'camera' : 'microphone';
    if (systemPreferences.getMediaAccessStatus(device) === 'granted') continue;
    if (!(await systemPreferences.askForMediaAccess(device))) {
      showNotice(`macOS does not let Habitab use the ${device}: System Settings → Privacy & Security → ${device === 'camera' ? 'Camera' : 'Microphone'}`);
      return false;
    }
  }
  return true;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** Shared files may be large; Chrome refuses big shares too. */
const SHARE_MAX_BYTES = 50 * 1024 * 1024;
/** The last share request (for tests, which show no menu). */
let lastShare: { title?: string; text?: string; url?: string; files?: string[] } | null = null;

/**
 * navigator.share() of a page (see page-preload.ts): the macOS share menu at
 * the pointer with the text, URL and files. The menu does not tell whether
 * the user shared, so closing it counts as done ("ok").
 */
async function sharePage(senderId: number, json: string): Promise<string> {
  const page = manager.pageOf(senderId);
  if (!page) return 'AbortError';
  let d: { title?: string; text?: string; url?: string; files?: { name: string; type: string; data: string }[] };
  try { d = JSON.parse(json); } catch { return 'DataError'; }
  const size = (d.files ?? []).reduce((n, f) => n + f.data.length * 0.75, 0);
  if (size > SHARE_MAX_BYTES) return 'DataError';
  lastShare = { title: d.title, text: d.text, url: d.url, files: d.files?.map(f => f.name) };
  if (testHidden || process.platform !== 'darwin') return 'AbortError';
  // Files go to a private temp folder the share services can read; it goes away later.
  let dir: string | undefined;
  const filePaths: string[] = [];
  if (d.files?.length) {
    dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'habitab-share-'));
    for (const [i, f] of d.files.entries()) {
      const name = path.basename(f.name || `file-${i + 1}`).replace(/[/\\:]/g, '_') || `file-${i + 1}`;
      const file = path.join(dir, filePaths.some(p => path.basename(p) === name) ? `${i + 1}-${name}` : name);
      await fs.promises.writeFile(file, Buffer.from(f.data, 'base64'), { mode: 0o600 });
      filePaths.push(file);
    }
  }
  const texts = [d.text ?? (d.url ? undefined : d.title)].filter((t): t is string => !!t);
  const urls = d.url ? [d.url] : [];
  await new Promise<void>(resolve => new ShareMenu({ texts, urls, filePaths }).popup({ window: win, callback: () => resolve() }));
  if (dir) setTimeout(() => void fs.promises.rm(dir!, { recursive: true, force: true }), 10 * 60_000).unref();
  return 'ok';
}

// MARK: Speech recognition (pages and dictation)

const speech = new SpeechService();
/** Recognitions of the pages and views, by webContents and the page's own id. */
const recognitions = new Map<string, { helperId?: number; ended: boolean; send: (e: SpeechEvent) => void }>();

/**
 * A request of the Web Speech API in a page (page-preload.ts) or of Habitab's
 * dictation (preload.ts): JSON in, "ok" or an answer out; the events of a
 * recognition go back over 'habitab:speech'. A page needs microphone access
 * for its origin (asked like getUserMedia); Habitab's own views need macOS's
 * permission for the app.
 */
async function speechRequest(wc: Electron.WebContents, json: string): Promise<string> {
  let r: { op: string; id?: number; lang?: string; interim?: boolean; continuous?: boolean };
  try { r = JSON.parse(json); } catch { return 'error'; }
  const page = manager.pageOf(wc.id);
  // Habitab's own views dictate in the chosen language; a page names its own.
  const lang = (typeof r.lang === 'string' ? r.lang : '') || (page ? '' : dictationLanguage());
  if (r.op === 'available') return speech.available(lang);
  if (r.op === 'install') return String(await speech.install(lang));
  if (r.op === 'setLanguage') { setPrefs({ dictationLanguage: lang || undefined }); return 'ok'; }
  // Dictation of the app: the language, its model (downloaded when missing) and the choices.
  if (r.op === 'prepare') {
    const preferred = app.getPreferredSystemLanguages();
    const byPreference = (a: string, b: string) => (preferred.indexOf(a) + 1 || 99) - (preferred.indexOf(b) + 1 || 99);
    const languages = (await speech.languages()).sort(byPreference);
    // A system language the recognizer has no model for, e.g. en-DE, is shown as its nearest model (en-US).
    const l = nearestModel(dictationLanguage(), languages);
    let status = await speech.available(l);
    if (status === 'downloadable' || status === 'downloading') status = (await speech.install(l)) ? 'available' : 'unavailable';
    return JSON.stringify({ status, lang: l, languages });
  }
  const key = `${wc.id}:${r.id}`;
  const rec = recognitions.get(key);
  if (r.op === 'stop' || r.op === 'abort') {
    if (!rec) return 'ok';
    if (rec.helperId !== undefined) (r.op === 'stop' ? speech.stop : speech.abort).call(speech, rec.helperId);
    // Ended before the permission question was answered: no recognition starts,
    // and the overlay gets its end now (it waits for it).
    else { log(`dictation ${r.op} before the recognition started`); rec.send({ type: 'end' }); }
    return 'ok';
  }
  if (r.op !== 'start' || typeof r.id !== 'number') return 'error';
  const send = (e: SpeechEvent) => {
    if (mine.ended) return;
    if (e.type === 'end') { if (recognitions.get(key) === mine) recognitions.delete(key); mine.ended = true; }
    if (!wc.isDestroyed()) wc.send('habitab:speech', JSON.stringify({ id: r.id, ...e }));
  };
  const mine: { helperId?: number; ended: boolean; send: typeof send } = { ended: false, send };
  recognitions.set(key, mine);
  const s = page?.s ?? selected();
  let allowed = speech.supported;
  if (!allowed) send({ type: 'error', error: 'service-not-allowed', message: 'Speech recognition is not available on this computer' });
  else if (page) {
    const origin = originOf(wc.getURL());
    const known = manager.siteAccess(page.s, 'media', origin);
    allowed = known ? known === 'allow' : await askSiteAccess(page.s, 'media', origin, ['audio']);
  } else allowed = await ownMicrophoneAccess();
  if (mine.ended) return 'ok';
  if (!allowed) {
    if (speech.supported) send({ type: 'error', error: 'not-allowed', message: 'Microphone access is not allowed' });
    send({ type: 'end' });
    return 'ok';
  }
  mine.helperId = speech.start({ lang, interim: !!r.interim, context: speechContext(s) }, send);
  return 'ok';
}

/** The language of the app's dictation: chosen in the overlay, else the system's first language. */
function dictationLanguage(): string {
  return prefs().dictationLanguage || app.getPreferredSystemLanguages()[0] || app.getLocale();
}

/** Tests (fake speech): macOS's microphone question stays open until the test control answers it. */
let fakeMicWaits = false;
let fakeMicAnswer: (() => void) | undefined;

/** Habitab's own dictation: macOS must let the app use the microphone. */
async function ownMicrophoneAccess(): Promise<boolean> {
  if (process.env.HABITAB_FAKE_SPEECH === '1') { if (fakeMicWaits) await new Promise<void>(r => { fakeMicAnswer = r; }); return true; }
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  log(`dictation: microphone access is ${status}, asking macOS`);
  if (await systemPreferences.askForMediaAccess('microphone')) return true;
  showNotice('macOS does not let Habitab use the microphone: System Settings → Privacy & Security → Microphone');
  return false;
}

/**
 * Words the recognizer should expect (like a custom vocabulary): the project,
 * what the session's tabs show, and what the agent did last.
 */
function speechContext(s?: Session): string[] {
  const out = new Set<string>(['Habitab']);
  const add = (x?: string) => { const t = x?.trim(); if (t && t.length > 2 && t.length <= 60) out.add(t); };
  if (s) {
    add(s.meta.projectName);
    for (const t of s.tabs) {
      const wc = t.view.webContents;
      if (wc.isDestroyed()) continue;
      const title = wc.getTitle();
      add(title);
      for (const w of title.split(/[\s|·•—–:,()[\]"']+/)) if (/^[\p{L}\p{N}][\p{L}\p{N}.'-]*$/u.test(w)) add(w);
      try { add(new URL(wc.getURL()).hostname); } catch {}
    }
    for (const a of s.activity.slice(0, 8)) add(a.summary);
  }
  return [...out].slice(0, 100);
}

/** Sends a tab's console errors (all, or the given ones) to the agent and tells the user how. */
function sendProblems(s: Session, tab: Tab, ids?: number[]): void {
  const how = manager.sendProblems(s, tab, ids);
  if (how) showNotice(how === 'pushed' ? 'Sent to the agent' : 'Not sent: this agent has no channel for feedback');
}

const sendLabel = (n: number) => n === 1 ? 'Send Console Error to Agent' : n > 1 ? `Send ${n} Console Errors to Agent` : 'Send Console Errors to Agent';

/** Context menu of an error badge (sidebar, top bar): send the tab's console errors, open the console, clear. */
function problemsMenu(s: Session, tab: Tab, x: number, y: number): void {
  const n = tab.problems.length;
  Menu.buildFromTemplate([
    { label: sendLabel(n), enabled: n > 0, click: () => sendProblems(s, tab) },
    { label: 'Open Console', click: () => { select(s.id, tab.id); manager.showConsole(s, tab); } },
    { type: 'separator' },
    { label: 'Clear', enabled: n > 0, click: () => manager.clearProblems(tab) },
  ]).popup({ window: win, x, y });
}

/**
 * Context menu "Send Element to Agent…": the marking overlay opens with the
 * element under the pointer already marked, so the user only writes a comment.
 */
async function sendElement(s: Session, tab: Tab, x: number, y: number): Promise<void> {
  const wc = tab.view.webContents;
  // View pixels <-> CSS pixels of the page (zoom, responsive-mode scale).
  const f = wc.getZoomFactor() * (tab.emulation?.scale ?? 1);
  let r: Electron.Rectangle | null = null;
  try {
    r = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: `(p => {
      const el = document.elementFromPoint(p.x, p.y);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })(${JSON.stringify({ x: x / f, y: y / f })})` }]);
  } catch {}
  const b = tab.view.getBounds();
  const pad = 3;
  const rect = r && {
    x: Math.max(0, Math.round(r.x * f) - pad), y: Math.max(0, Math.round(r.y * f) - pad),
    width: 0, height: 0,
  };
  if (rect && r) {
    rect.width = Math.min(b.width, Math.round((r.x + r.width) * f) + pad) - rect.x;
    rect.height = Math.min(b.height, Math.round((r.y + r.height) * f) + pad) - rect.y;
  }
  if (selected() !== s || s.active !== tab) select(s.id, tab.id);
  setAnnotating(true);
  if (rect && rect.width > 4 && rect.height > 4 && !annotator.webContents.isDestroyed()) annotator.webContents.send('annotate-rect', rect);
}

/** A download in the status line: progress at most a few times a second, the end at once (and gone after a while). */
function showDownload(d: Download): void {
  const changed = d.state !== download?.state || d.file !== download?.file;
  download = { ...d, at: Date.now() };
  // The newer news wins: a notice from before goes.
  if (changed) notice = undefined;
  if (!changed && Date.now() - downloadPublished < 250) return;
  downloadPublished = Date.now();
  publish();
  if (d.state !== 'progressing') setTimeout(publish, DOWNLOAD_SHOWN + 100);
}
function shownDownload() {
  if (!download || (download.state !== 'progressing' && Date.now() - download.at > DOWNLOAD_SHOWN)) return null;
  const { name, state, received, total } = download;
  return { name, state, received, total };
}

function showNotice(text: string): void {
  notice = { text, until: Date.now() + 5000 };
  publish();
  setTimeout(publish, 5100);
}

/**
 * Describes the elements in a page area (runs in an isolated world, reads the
 * DOM only). The elements about the size of the area (or smaller) are what
 * the user meant: they come with a short text. Bigger ones only contain the
 * area and are named as the way down to the first one.
 */
const DESCRIBE_AREA = `(r => {
  const label = el => {
    const s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + CSS.escape(el.id);
    return s + [...el.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
  };
  const short = el => {
    const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ');
    return t.length <= 40 ? t : t.slice(0, 40).replace(/\\s+\\S*$/, '') + '…';
  };
  const size = el => { const b = el.getBoundingClientRect(); return Math.max(1, b.width * b.height); };
  const hits = new Map();
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const el = document.elementFromPoint(r.x + r.width * i / 6, r.y + r.height * j / 6);
    if (!el || el === document.documentElement || el === document.body) continue;
    hits.set(el, (hits.get(el) || 0) + 1);
  }
  const els = [...hits.keys()];
  let primary = els.filter(el => size(el) <= r.width * r.height * 4).sort((a, b) => hits.get(b) - hits.get(a) || size(a) - size(b));
  // Neighbors touched by the edge of the area are not what was meant.
  if (primary.length) primary = primary.filter(el => hits.get(el) >= hits.get(primary[0]) / 5);
  if (!primary.length) primary = els.sort((a, b) => size(a) - size(b)).slice(0, 1);
  primary = primary.slice(0, 4);
  const inside = [];
  for (let e = primary[0]?.parentElement; e && e !== document.body && inside.length < 3; e = e.parentElement) inside.push(label(e));
  return { title: document.title, primary: primary.map(el => label(el) + (short(el) ? ' "' + short(el) + '"' : '')), inside, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) } };
})`;

/**
 * The user marked an area (the overlay reports it as soon as the drag ends):
 * the picture, the URL and the elements are taken now, not when the comment
 * is sent, so the feedback shows what the user saw.
 */
function annotateMark(tab: Tab, m: { id: number; rect: Electron.Rectangle }): void {
  if (timelinePreview) return; // An earlier screenshot: it does not change.
  const done = captureMark(tab, m.rect);
  done.catch(() => {}); // A mark that is cancelled is never awaited.
  marks.set(m.id, { tab, rect: m.rect, done });
  // The page tells where the mark is when it scrolls (page-preload.ts).
  const wc = tab.view.webContents, f = viewScale(tab);
  wc.send('habitab:mark', { id: m.id, css: { x: m.rect.x / f, y: m.rect.y / f, width: m.rect.width / f, height: m.rect.height / f } });
}

function dropMark(id: number): void {
  const m = marks.get(id);
  marks.delete(id);
  if (m && !m.tab.view.webContents.isDestroyed()) m.tab.view.webContents.send('habitab:unmark', id);
}

/** View pixels per CSS pixel of the page (zoom, responsive-mode scale). */
const viewScale = (tab: Tab) => tab.view.webContents.getZoomFactor() * (tab.emulation?.scale ?? 1);

/** Where the marks of a page are now (page-preload.ts): to the overlay, in view pixels (null: the element is gone). */
function marksMoved(sender: Electron.WebContents, list: { id: number; x?: number; y?: number; width?: number; height?: number; gone?: boolean }[]): void {
  if (!annotating || !Array.isArray(list)) return;
  const out: { id: number; rect: Electron.Rectangle | null }[] = [];
  for (const p of list) {
    const m = marks.get(p?.id);
    if (!m || m.tab.view.webContents !== sender) continue;
    const f = viewScale(m.tab);
    m.now = p.gone ? null : { x: Math.round(Number(p.x) * f), y: Math.round(Number(p.y) * f), width: Math.round(Number(p.width) * f), height: Math.round(Number(p.height) * f) };
    out.push({ id: p.id, rect: m.now });
  }
  if (out.length && !annotator.webContents.isDestroyed()) annotator.webContents.send('annotate-marks', out);
}

type PagePointer = { type: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'mouseWheel'; x: number; y: number; button?: 'left' | 'middle'; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: string[] };
function annotatePointer(tab: Tab, e: PagePointer): void {
  const wc = tab.view.webContents;
  if (wc.isDestroyed() || !['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel'].includes(e.type)) return;
  const at = { x: Number(e.x) || 0, y: Number(e.y) || 0 };
  const modifiers = (e.modifiers ?? []).filter(m => m === 'leftbuttondown' || m === 'middlebuttondown') as Electron.MouseInputEvent['modifiers'];
  if (e.type === 'mouseWheel') wc.sendInputEvent({ type: 'mouseWheel', ...at, deltaX: Number(e.deltaX) || 0, deltaY: Number(e.deltaY) || 0 });
  else wc.sendInputEvent({ type: e.type, ...at, button: e.button === 'middle' ? 'middle' : 'left', clickCount: Number(e.clickCount) || 1, modifiers });
}

async function captureMark(tab: Tab, r: Electron.Rectangle): Promise<Mark> {
  const wc = tab.view.webContents;
  const url = wc.getURL();
  const image = await wc.capturePage(r);
  // View pixels to CSS pixels of the page (zoom, responsive-mode scale).
  const f = viewScale(tab);
  const css = { x: r.x / f, y: r.y / f, width: r.width / f, height: r.height / f };
  let page: Mark['page'] = { title: wc.getTitle(), primary: [], inside: [] };
  try { page = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: `${DESCRIBE_AREA}(${JSON.stringify(css)})` }]); } catch {}
  return { image, url, css, page };
}

const sameRect = (a: Electron.Rectangle, b: Electron.Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
/** The smallest rectangle that contains all of them. */
function union(rects: Electron.Rectangle[]): Electron.Rectangle {
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
}
const said = (n: Note) => n.text ? `The user says${n.dictated ? ' (dictated: a word may be misheard)' : ''}: "${n.text}"` : 'The user marked an area without a comment.';
/** Several marks go out as one message: the agent reads them together. */
const together = (n: number, of: string) => `The user marked ${n} areas of ${of} at once (numbered in the order they were marked); they may belong together.`;

/** The user marked one or more areas: to the waiting agent, otherwise to the clipboard. */
async function annotateSubmit(s: Session, tab: Tab, data: Note | { notes: Note[] }): Promise<void> {
  const notes = 'notes' in data ? data.notes : [data];
  if (!notes.length) return;
  if (timelinePreview && timelineStep !== null) return annotateScreenshot(s, timelineStep, notes);
  // The marks taken when the drags ended; without one (a direct call) the page is taken now.
  const kept = notes.map(n => { const m = n.id !== undefined ? marks.get(n.id) : undefined; return m && m.tab === tab && sameRect(m.rect, n.rect) ? m.done : null; });
  // Where the marks are now (the page may have scrolled since): for the overview.
  const now = notes.map(n => { const m = n.id !== undefined ? marks.get(n.id) : undefined; return m?.now === undefined ? n.rect : m.now; });
  setAnnotating(false, true);
  try {
    const shots = await Promise.all(notes.map((n, i) => kept[i] ?? captureMark(tab, n.rect)));
    const { url, page } = shots[0];
    const marked = ({ css, page }: Mark) => {
      // The user can scroll between marks: then the place in the viewport needs the scroll position.
      const scrolled = page.scroll && (page.scroll.x || page.scroll.y) ? ` in the viewport, page scrolled to ${page.scroll.x}, ${page.scroll.y}` : '';
      const where = `${Math.round(css.width)} × ${Math.round(css.height)} px at ${Math.round(css.x)}, ${Math.round(css.y)}${scrolled}`;
      return `Marked: ${page.primary.length ? page.primary.join(', ') + ' ' : ''}(${where}${page.inside.length ? `, inside ${page.inside.join(' > ')}` : ''})`;
    };
    const pageLine = `Page: ${url}${page.title ? ` ("${page.title}")` : ''}`;
    const text = (notes.length === 1
      ? [said(notes[0]), pageLine, marked(shots[0])]
      : [together(notes.length, 'the page'), pageLine, ...notes.flatMap((n, i) => [`${i + 1}. ${said(n)}`, `   ${marked(shots[i])}`])]
    ).join('\n');
    // For the clipboard (one image only): the part of the page with all marks, taken now (the agent still waits).
    // When a mark is out of view (or gone), the first mark's image.
    const b = tab.view.getBounds();
    const inView = (r: Electron.Rectangle | null): r is Electron.Rectangle => !!r && r.x >= 0 && r.y >= 0 && r.x + r.width <= b.width && r.y + r.height <= b.height;
    const overview = async () => now.every(inView) ? tab.view.webContents.capturePage(union(now as Electron.Rectangle[])) : shots[0].image;
    await deliverFeedback(s, { text, comment: notes.map(n => n.text).filter(Boolean).join('\n'), url, images: shots.map(x => x.image), overview });
  } finally { releaseMarkHold(); }
}

/**
 * The user marked areas of an earlier screenshot (timeline): the areas are cut
 * out of the stored screenshot, and the agent learns that it is about an
 * earlier state of the page, not the live one. An image has no elements.
 */
async function annotateScreenshot(s: Session, stepId: number, notes: Note[]): Promise<void> {
  setAnnotating(false, true);
  try { await annotateScreenshotSend(s, stepId, notes); } finally { releaseMarkHold(); }
}
async function annotateScreenshotSend(s: Session, stepId: number, notes: Note[]): Promise<void> {
  const step = s.timeline.find(x => x.id === stepId);
  const file = manager.stepShotFile(s, stepId);
  const full = file ? nativeImage.createFromPath(file) : undefined;
  if (!step || !full || full.isEmpty()) return showNotice('This screenshot is no longer kept');
  // Where the screenshot lies in its view; the marked rectangles are in the same coordinates.
  let box: Electron.Rectangle | null = null;
  try { box = await timeline.webContents.executeJavaScript(`(() => { const r = document.querySelector('#frame img')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`); } catch {}
  const size = full.getSize();
  const cropOf = (r: Electron.Rectangle) => {
    if (box && box.width > 0 && box.height > 0) {
      const k = size.width / box.width;
      const x1 = Math.max(r.x, box.x), y1 = Math.max(r.y, box.y), x2 = Math.min(r.x + r.width, box.x + box.width), y2 = Math.min(r.y + r.height, box.y + box.height);
      if (x2 - x1 > 2 && y2 - y1 > 2) return { x: Math.round((x1 - box.x) * k), y: Math.round((y1 - box.y) * k), width: Math.round((x2 - x1) * k), height: Math.round((y2 - y1) * k) };
    }
    return { x: 0, y: 0, width: size.width, height: size.height };
  };
  const crops = notes.map(n => cropOf(n.rect));
  const at = new Date(step.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const url = step.url || 'unknown';
  const area = (c: Electron.Rectangle) => `Marked area (px of the ${size.width} × ${size.height} screenshot): x ${c.x}, y ${c.y}, ${c.width} × ${c.height}`;
  const text = [
    notes.length === 1 ? said(notes[0]) : together(notes.length, 'an earlier screenshot'),
    `This is about an earlier state, not the live page: the screenshot Habitab took after your tool call ${step.tool} at ${at}.`,
    `Page then: ${url}${step.title ? ` ("${step.title}")` : ''}`,
    ...(notes.length === 1 ? [area(crops[0])] : notes.flatMap((n, i) => [`${i + 1}. ${said(n)}`, `   ${area(crops[i])}`])),
  ].join('\n');
  await deliverFeedback(s, {
    text, comment: notes.map(n => n.text).filter(Boolean).join('\n'), url, what: 'marked an area of an earlier screenshot of',
    images: crops.map(c => full.crop(c)), overview: async () => full.crop(union(crops)),
  });
}

/** Feedback to the waiting agent, pushed to it, or kept (and copied to the clipboard; `overview`: its one image when there are several). */
async function deliverFeedback(s: Session, f: { text: string; comment: string; url: string; images: Electron.NativeImage[]; overview?: () => Promise<Electron.NativeImage>; what?: string }): Promise<void> {
  const { text, images } = f;
  const how = manager.submitFeedback(s, { text, comment: f.comment, url: f.url, what: f.what, images: images.filter(i => !i.isEmpty()).map(i => i.toPNG().toString('base64')) });
  if (how === 'pushed') return showNotice(`Sent to ${s.meta.client === 'codex' ? 'Codex' : s.meta.client === 'claude' ? 'Claude Code' : 'the agent'}`);
  if (testHidden) lastClipboard = text; // tests must not touch the user's clipboard
  else {
    const image = images.length > 1 && f.overview ? await f.overview().catch(() => images[0]) : images[0];
    await clipboard.write([new ClipboardItem({ 'text/plain': text, 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
  }
  showNotice('Copied to the clipboard: this agent has no channel for feedback');
}
let lastClipboard = '';

/** An SF Symbol for a native menu item (macOS only; other systems show no icon). */
const sym = (name: string): Electron.NativeImage | undefined => process.platform === 'darwin' ? nativeImage.createMenuSymbol(name) : undefined;

/**
 * Native menu of a session in the sidebar, from its header or one of its tabs (x, y: window coordinates).
 * Three groups: what is kept for the project, what is kept for the session, and actions.
 */
function sessionMenu(s: Session, x: number, y: number, tabId?: number): void {
  const tab = s.tabs.find(t => t.id === tabId);
  const project = s.meta.projectName ?? 'this project';
  const persistent = manager.hasPersistentProfile(s);
  const permissions = sitePermissionItems(s);
  Menu.buildFromTemplate([
    { label: `Project “${project}”`, type: 'header' },
    {
      label: 'Persistent Profile', type: 'checkbox', checked: persistent, enabled: !!manager.projectRoot(s), icon: sym('externaldrive'),
      click: async () => {
        if (persistent) {
          const r = await dialog.showMessageBox(win, {
            type: 'warning', buttons: ['Delete Profile', 'Cancel'], defaultId: 1, cancelId: 1,
            message: `Delete the persistent profile of “${project}”?`,
            detail: 'Its cookies, localStorage, IndexedDB, service workers and cache are deleted. New sessions of this project start with an empty in-memory profile again.',
          });
          if (r.response !== 0) return;
        }
        await manager.togglePersistentProfile(s);
        layout(); publish();
      },
    },
    {
      label: 'Pause Debugger While You Test', type: 'checkbox', checked: manager.pausesDebugger(s), enabled: !!manager.projectRoot(s), icon: sym('ant'),
      click: () => manager.setPausesDebugger(s, !manager.pausesDebugger(s)),
    },
    // Stored answers of the project (camera/microphone, clipboard), one per origin; a click forgets it (the page asks again).
    ...(permissions.length ? [{ label: 'Site Permissions', icon: sym('hand.raised'), submenu: permissions }] : []),
    // A dev server on plain http under its own host name (e.g. app.test → 127.0.0.1) is no secure
    // context, so camera, clipboard & co. are missing. Chromium can treat such an origin as secure.
    ...secureOriginItems(tab ?? s.active),
    { type: 'separator' },
    { label: 'Session', type: 'header' },
    { label: 'Keep Browser After Session Ends', type: 'checkbox', checked: s.pinned, icon: sym('pin'), click: () => { s.pinned = !s.pinned; publish(); } },
    { label: 'Mute Session', type: 'checkbox', checked: s.muted, icon: sym('speaker.slash'), click: () => manager.setMuted(s, !s.muted) },
    { label: 'Copy Session ID', icon: sym('doc.on.doc'), click: () => clipboard.writeText(s.meta.agentSessionId ?? s.id) },
    { type: 'separator' },
    ...(tab?.problems.length ? [{ label: sendLabel(tab.problems.length), icon: sym('exclamationmark.bubble'), click: () => sendProblems(s, tab) }] : []),
    ...(tab ? [{ label: 'Close Tab', icon: sym('xmark'), click: () => manager.closeTab(s, tab, 'context menu') }] : []),
    { label: 'Close All Tabs of Session', enabled: s.tabs.length > 0, icon: sym('xmark.square'), click: () => { manager.closeBrowser(s); layout(); } },
    { label: 'Remove from List', enabled: s.ended, icon: sym('trash'), click: () => manager.remove(s) },
  ]).popup({ window: win, x, y });
}

function sitePermissionItems(s: Session): Electron.MenuItemConstructorOptions[] {
  const name = { media: 'Camera & Microphone', clipboard: 'Clipboard' } as const;
  return (['media', 'clipboard'] as const).flatMap(kind => Object.entries(manager.siteAccessOrigins(s, kind)).map(([origin, answer]) => ({
    label: `${name[kind]} ${answer === 'allow' ? 'allowed' : 'blocked'}: ${origin} — Forget`, icon: sym(kind === 'media' ? 'video' : 'clipboard'), click: () => manager.setSiteAccess(s, kind, origin, undefined),
  })));
}

/** The tab's origin if it is plain http and not secure by itself (localhost, 127.0.0.1, ::1 and *.localhost are). */
function insecureOrigin(tab: Tab | undefined): string | undefined {
  try {
    const u = new URL(tab?.view.webContents.getURL() ?? '');
    if (u.protocol !== 'http:') return undefined;
    const h = u.hostname;
    if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h)) return undefined;
    return u.origin;
  } catch { return undefined; }
}

/** "Treat … as Secure" for the tab's insecure http origin, or "Stop Treating …" for one already listed. */
function secureOriginItems(tab: Tab | undefined): Electron.MenuItemConstructorOptions[] {
  const list = prefs().secureOrigins ?? [];
  const origin = insecureOrigin(tab);
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (origin && !list.includes(origin)) items.push({ label: `Treat ${origin} as Secure…`, icon: sym('lock.open'), click: () => void changeSecureOrigins([...list, origin], `${origin} is treated as a secure context (camera, clipboard and other APIs that need https).`) });
  for (const o of list) items.push({ label: `Stop Treating ${o} as Secure…`, icon: sym('lock'), click: () => void changeSecureOrigins(list.filter(x => x !== o), `${o} is a normal http origin again.`) });
  return items;
}

/** Stores the list (Chromium reads it only at start) and offers the restart; sessions and tabs come back. */
async function changeSecureOrigins(list: string[], what: string): Promise<void> {
  setPrefs({ secureOrigins: list });
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
    message: 'Restart Habitab to apply the change?',
    detail: `${what} Chromium reads this setting only when it starts. Sessions and their tabs come back after the restart, and the agents reconnect.`,
  });
  if (r.response !== 0) return;
  restarting = true;
  app.relaunch();
  app.quit();
}

/** Button and ⇧⌘B: full width ↔ thumbnails only. A hidden sidebar comes back first. */
function toggleSidebarWidth(): void {
  setPrefs(prefs().sidebarHidden ? { sidebarHidden: false } : { sidebarCompact: !prefs().sidebarCompact });
  layout();
  publish();
}

/** View → Show Sidebar: hides or shows it, keeping its width. */
function toggleSidebarHidden(): void {
  setPrefs({ sidebarHidden: !prefs().sidebarHidden });
  layout();
  publish();
}

function toggleResponsive(tab: Tab): void {
  if (tab.emulation) return manager.emulate(tab, null);
  // Like Chrome's responsive mode, but filling the free space until a size is set.
  const b = tab.view.getBounds();
  const scaleFactor = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  manager.emulate(tab, { preset: 'responsive', width: b.width, height: b.height, fillWidth: true, fillHeight: true, dpr: scaleFactor, mobile: false, zoom: 'fit' });
}

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (/^[^\s]+\.[^\s]+$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

// MARK: Setup (runs in a worker: the Claude CLI calls are synchronous)

/**
 * One way only: at start the app names its browser in the global config of
 * chrome-devtools-mcp (unless the file is invalid or names its own browser)
 * and removes the launcher wrappers of Habitab 0.2 from the client
 * configurations. Servers already running keep their old browser until they
 * restart (the sidebar says so).
 */
async function migrate(): Promise<void> {
  try {
    const r = await installer('migrate', testControl ? ['cd4a'] : undefined) as { error?: string; cd4a?: { ok: boolean; message: string }; results?: { ok: boolean; message: string; finding: { name: string } }[] };
    if (r.error) return log(`migration failed: ${r.error}`);
    if (r.cd4a) log(`migration: ${r.cd4a.message}`);
    for (const x of r.results ?? []) log(`migration: ${x.finding.name}: ${x.message}`);
    const changed = (r.cd4a?.ok ? 1 : 0) + (r.results ?? []).filter(x => x.ok).length;
    if (changed) showNotice('Set up: chrome-devtools-mcp opens its browser here from now on. Running agent sessions need a restart of their server.');
    if (r.cd4a && !r.cd4a.ok) showNotice(`Setup: ${r.cd4a.message}`);
  } catch (e: any) { log(`migration failed: ${e.message}`); }
}

function installer(op: string, ids?: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'setup-worker.js'), { workerData: { op, ids } });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

ipcMain.handle('setup', (_e, op: string, ids?: string[]) => installer(op, ids));
ipcMain.handle('habitab:share', (e, json: string) => sharePage(e.sender.id, json));
ipcMain.handle('habitab:speech', (e, json: string) => speechRequest(e.sender, json));
ipcMain.on('habitab:marks', (e, list) => marksMoved(e.sender, list));
ipcMain.on('habitab:draws', (e, draws: number) => manager?.drawReport(e.sender.id, draws));

function openSetup(): void {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 760, height: 620, minWidth: 600, minHeight: 420, title: 'Habitab – Setup', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  setupWindow.setMenuBarVisibility(false);
  void setupWindow.loadFile(path.join(UI, 'setup.html'));
}

// MARK: Menu

function updateMenu(): void {
  const s = selected();
  const isMac = process.platform === 'darwin';
  const nextTab = (d: number) => () => {
    if (!s?.active) return;
    const i = s.tabs.indexOf(s.active);
    const t = s.tabs[(i + d + s.tabs.length) % s.tabs.length];
    if (t) select(s.id, t.id);
  };
  const sessionsList = [...manager.sessions.values()].filter(x => x.tabs.length);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const, submenu: [
      { role: 'about' as const, label: 'About Habitab' }, { type: 'separator' as const },
      { label: 'Setup…', accelerator: 'Cmd+,', click: openSetup }, { type: 'separator' as const },
      { role: 'hide' as const, label: 'Hide Habitab' }, { role: 'hideOthers' as const, label: 'Hide Others' }, { type: 'separator' as const },
      { role: 'quit' as const, label: 'Quit Habitab' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: !!s?.active, click: () => s?.active && manager.closeTab(s, s.active, 'app menu') },
      { type: 'separator' },
      { label: 'Edit Address', accelerator: 'CmdOrCtrl+L', click: () => { topbar.webContents.focus(); topbar.webContents.send('focus-url'); } },
      { label: 'Search Sessions', accelerator: 'CmdOrCtrl+K', click: () => { sidebar.webContents.focus(); sidebar.webContents.send('focus-search'); } },
      ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Setup…', click: openSetup }, { role: 'quit' as const, label: 'Quit' }]),
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' }, { type: 'separator' },
      { role: 'cut', label: 'Cut' }, { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' },
      { role: 'selectAll', label: 'Select All' }, { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', enabled: !!s?.active, click: () => void action('find') },
      { label: 'Find Next', accelerator: 'CmdOrCtrl+G', enabled: findOpen && !!findText, click: () => runFind({ forward: true, next: true }) },
      { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', enabled: findOpen && !!findText, click: () => runFind({ forward: false, next: true }) },
    ] },
    { label: 'View', submenu: [
      { label: 'Show Sidebar', type: 'checkbox', checked: !prefs().sidebarHidden, accelerator: isMac ? 'Ctrl+Cmd+S' : 'Ctrl+Shift+S', click: toggleSidebarHidden },
      { label: 'Thumbnails Only', type: 'checkbox', checked: !!prefs().sidebarCompact, accelerator: 'CmdOrCtrl+Shift+B', click: toggleSidebarWidth },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: !!s?.active, click: () => s?.active && manager.reload(s, s.active) },
      { label: 'Reload Without Cache', accelerator: 'CmdOrCtrl+Shift+R', enabled: !!s?.active, click: () => s?.active?.view.webContents.reloadIgnoringCache() },
      // Linux: the browser keys (Ctrl+[ is hard to type on many layouts).
      { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => s?.active?.view.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => s?.active?.view.webContents.navigationHistory.goForward() },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
      { type: 'separator' },
      { label: 'DevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', enabled: !!s?.active, click: () => s && manager.toggleDevtools(s) },
      { label: 'Timeline', type: 'checkbox', checked: timelineOpen, accelerator: 'CmdOrCtrl+Shift+Y', enabled: !!s, click: () => setTimelineOpen(!timelineOpen) },
      { label: 'Responsive Mode', type: 'checkbox', checked: !!s?.active?.emulation, accelerator: 'CmdOrCtrl+Shift+M', enabled: !!s?.active, click: () => void action('responsive') },
      { role: 'togglefullscreen', label: 'Toggle Full Screen' },
    ] },
    { label: 'Session', submenu: [
      { label: s?.autoResumeAt ? 'Keep Control' : s?.held ? 'Resume Agent' : 'Take Control', accelerator: 'CmdOrCtrl+Shift+P', enabled: !!s && !s.ended, click: () => s && manager.toggleHold(s) },
      { label: 'Continue in Own Tab', accelerator: 'CmdOrCtrl+Shift+O', enabled: !!s?.active && !s.active.own && !s.ended, click: () => s && void manager.forkTab(s) },
      { label: 'Mark Area for Agent…', accelerator: 'CmdOrCtrl+Shift+A', enabled: !!s?.active, click: () => setAnnotating(true) },
      { label: 'Show Console', accelerator: 'CmdOrCtrl+Shift+E', enabled: !!s?.active, click: () => void action('problems') },
      { label: sendLabel(s?.active?.problems.length ?? 0), enabled: !!s?.active?.problems.length, click: () => s?.active && sendProblems(s, s.active) },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: nextTab(1) },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: nextTab(-1) },
      { type: 'separator' },
      ...sessionsList.slice(0, 9).map((x, i) => ({ label: x.meta.projectName ?? x.id, accelerator: `CmdOrCtrl+${i + 1}`, click: () => select(x.id) })),
    ] },
    { role: 'windowMenu', label: 'Window' },
  ]));
}

function zoom(delta: number): void {
  const wc = selected()?.active?.view.webContents;
  if (!wc) return;
  wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
}

// MARK: Start

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'system';
  win = new BaseWindow({
    width: 1500, height: 960, minWidth: 900, minHeight: 560, title: 'Habitab',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 16 },
    show: !testControl && !background,
    // Linux under X11; Wayland takes the icon of the desktop entry.
    icon: process.platform === 'linux' ? path.join(UI, 'icon.png') : undefined,
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const } : {}),
  });
  // Linux, Windows: no menu bar. The menu stays, as it holds the keyboard shortcuts.
  win.setMenuBarVisibility(false);
  manager = new SessionManager(win, upstreamUrl);
  manager.onChange = publish;
  manager.onLayout = layout;
  manager.onSendElement = (s, t, x, y) => void sendElement(s, t, x, y);
  manager.onThumb = t => { if (!sidebar.webContents.isDestroyed()) sidebar.webContents.send('thumb', t.id, t.thumb ?? null); };
  manager.onNotice = showNotice;
  manager.onDownload = showDownload;
  manager.onAccessRequest = askSiteAccess;
  empty = uiView('empty.html');
  responsive = uiView('responsive.html');
  splitter = uiView('splitter.html');
  annotator = uiView('annotate.html');
  status = uiView('status.html');
  timeline = uiView('timeline.html');
  link = uiView('link.html');
  find = uiView('find.html');
  sidebar = uiView('sidebar.html');
  sidebar.webContents.on('did-finish-load', () => { for (const s of manager.sessions.values()) for (const t of s.tabs) if (t.thumb) manager.onThumb(t); });
  topbar = uiView('topbar.html');
  win.on('resize', layout);
  // Switching to another app ends automatic control; no need to wait for the countdown.
  win.on('blur', () => manager.releaseAutoHolds());
  // Diagnostics: the window should only come to the front by the user's action.
  win.on('focus', () => {
    const recent = [...manager.sessions.values()].map(s => s.currentTool?.tool ?? (s.lastActivity && Date.now() - s.lastActivity < 3000 ? s.activity[0]?.tool : undefined)).filter(Boolean);
    log(`window focus${recent.length ? ` (agent tools: ${recent.join(', ')})` : ''}`);
  });
  win.on('close', e => {
    // Closing the window quits the app. A browser bridge starts it again when its agent needs the browser.
    if (!quitting) { e.preventDefault(); app.quit(); }
  });
  // Sessions of the last run come back before their bridges reconnect.
  await manager.restore();
  manager.listen();
  if (testControl) {
    if (testHidden) { win.setOpacity(0); win.setIgnoreMouseEvents(true); }
    win.showInactive();
  }
  layout();
  updateMenu();
  // Also saves now and then: cookies change without a state change.
  setInterval(() => { manager.idleCheck(); manager.saveSoon(); }, 30_000);
  setInterval(() => { manager.cpuCheck(); void manager.gpuCheck(); }, 3_000);

  // The habitab command and the browser script (executablePath of the global config).
  try {
    const launcherJs = path.join(__dirname, '..', 'launcher', 'main.js');
    installLauncher(process.execPath, launcherJs);
    if (!testControl || process.env.HABITAB_TEST_MIGRATE === '1') void migrate();
    // In development the executable is Electron itself and needs the app dir.
    const args = app.isPackaged ? [] : [app.getAppPath()];
    fs.writeFileSync(paths.appPathFile, JSON.stringify({ exe: process.execPath, args, env: desktopEnv() }), { mode: 0o600 });
    if (!testControl) installDesktopEntry({ exe: process.execPath, args }, path.join(UI, 'icon.png'), paths.home);
  } catch (e: any) { log(`script install failed: ${e.message}`); }
  if (process.env.HABITAB_TEST_CONTROL === '1') (await import('./test-control')).attach(manager, { win, select, layout, publish, upstreamUrl, action, quit: () => app.quit(), clipboard: () => lastClipboard, background: () => empty, errors: () => errors.map(e => e.message), annotating: () => annotating, annotateKept: () => annotateKept, findText: () => findOpen ? findText : null, lastShare: () => lastShare, speechResult: (text, final) => speech.fakeResult(text, final), speechLevel: level => speech.fakeLevel(level), speechPermission: (wait: boolean) => { fakeMicWaits = wait; if (!wait) { fakeMicAnswer?.(); fakeMicAnswer = undefined; } }, speechStall: (on: boolean) => speech.fakeStall(on), view: name => ({ sidebar, topbar, responsive, timeline, annotator, status, find, devtools: selected()?.devtools } as Record<string, WebContentsView | undefined>)[name] });
  log(`app ready, chromium ${process.versions.chrome}`);
  ready = true;
  if (pendingLink) openLink(pendingLink);
});

app.on('second-instance', () => { win?.show(); win?.focus(); });

// MARK: habitab:// links

/** A link that started the app waits until the window and the sessions are there. */
let ready = false;
let pendingLink: string | undefined;
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (ready) openLink(url); else pendingLink = url;
});

/**
 * habitab://session/<id> selects the session and shows the window. A terminal app
 * uses it to go from the agent's terminal to its browser.
 */
function openLink(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { return; }
  log(`link ${url}`);
  if (u.hostname === 'session') {
    const id = decodeURIComponent(u.pathname.slice(1));
    if (manager.sessions.has(id)) select(id);
  }
  win.show();
  win.focus();
}

app.on('activate', () => { win?.show(); });
/** Quitting asks first when an agent called a tool in this time. */
const BUSY_MS = 15_000;
/** Set by a signal (e.g. Ctrl+C on `npm start`): quit without asking. */
let quitBySignal = false;
/** Set when the user chose a restart: quit without asking. */
let restarting = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { quitBySignal = true; app.quit(); });
/** The quit question is open: a second close or Cmd+Q does not show another one. */
let asking = false;
app.on('before-quit', e => {
  if (quitting) return;
  e.preventDefault();
  if (asking) return;
  void (async () => {
    // Ask only while an agent works: a tool call runs, or the last one ended a short time ago.
    const busy = [...manager.sessions.values()].filter(s => !s.ended && (s.currentTool || Date.now() - (s.lastActivity ?? 0) < BUSY_MS));
    if (busy.length && !testControl && !quitBySignal && !restarting) {
      asking = true;
      const r = await dialog.showMessageBox({
        type: 'question', buttons: ['Quit', 'Cancel'], defaultId: 1,
        message: busy.length === 1 ? 'An agent is working in Habitab.' : `${busy.length} agents are working in Habitab.`,
        detail: 'Habitab opens their tabs again at the next start, and the agents continue. Cookies come back; other storage (localStorage, IndexedDB) only with a persistent profile.',
      });
      asking = false;
      if (r.response !== 0) return;
    }
    quitting = true;
    speech.dispose();
    await manager.save();
    manager.close();
    for (const s of manager.sessions.values()) s.proxy?.close();
    // app.exit() skips Chromium's shutdown, so kept profiles are written first.
    await manager.flushProfiles();
    app.exit(0);
  })();
});
