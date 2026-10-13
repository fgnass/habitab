// Habitab app: one window with the session list on the left and the real
// Chromium view of the selected session on the right, DevTools docked.
import { app, BaseWindow, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, ShareMenu, shell, systemPreferences, WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ensureHome, log, openLog, paths } from '../shared/paths';
import { installLauncher } from '../installer/installer';
import { prefs, setPrefs, SidebarMode, sidebarMode } from './prefs';
import { Session, SessionManager, SiteAccess, Tab } from './sessions';
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
/** Find in page: the bar lies at the top right of the selected page; the running query, its tab and the key hook. */
let findOpen = false, findText = '';
let findTab: Tab | undefined;
let findKeyHandler: ((e: Electron.Event, input: Electron.Input) => void) | undefined;
const FIND_W = 340, FIND_H = 40;
/** The status line is open (the timeline); with an older change chosen, its screenshot lies over the page. */
let timelineOpen = false, timelinePreview = false;
/** The change the user chose in the timeline (its first step's id); null: the newest one, live. */
let timelineStep: number | null = null;
/** Height of the bubble with the hovered link's URL; it sits at the right edge when the pointer is on the left. */
const LINK = 24;
let linkRight = false;
/** Short message in the top bar, e.g. after copying to the clipboard. */
let notice: { text: string; until: number } | undefined;
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
        if (e.by === 'user') {
          const width = e.fillWidth ? room.width : e.width, height = e.fillHeight ? room.height : e.height;
          const scale = e.zoom === 'fit' ? Math.min(1, room.width / width, room.height / height) : e.zoom;
          manager.applyEmulation(t, width, height, Math.max(0.1, Math.round(scale * 1000) / 1000));
        }
        const scale = e.scale ?? 1;
        const w = Math.round(e.width * scale), h = Math.round(e.height * scale);
        const pos = centered(w, area.y + RBAR + FRAME_TOP);
        t.view.setBounds({ ...pos, width: w, height: h });
        const frame = { x: pos.x - area.x, y: pos.y - area.y, width: w, height: h, scale };
        if (JSON.stringify(frame) !== JSON.stringify(t.frame)) { t.frame = frame; framesChanged = true; }
      } else if (t.fixedSize) {
        t.view.setBounds({ ...centered(t.fixedSize.width, area.y), ...t.fixedSize });
      } else {
        t.view.setBounds({ ...area, width: pageWidth });
      }
      t.view.setVisible(true);
      if (!(isSel && t === s.active)) order.push(t.view);
    }
    if (s.devtools && !s.devtools.webContents.isDestroyed()) {
      s.devtools.setVisible(!!dt);
      s.devtools.setBounds(dt ? { x: area.x + pageWidth, y: area.y, width: area.width - pageWidth, height: area.height } : { x: 0, y: 0, width: 1, height: 1 });
    }
  }
  // Background behind the selected page (also covers other sessions).
  empty.setBounds(area);
  empty.setVisible(true);
  order.push(empty);
  // A tab whose webContents is gone (the 'destroyed' event is still running) has no view to show.
  const sel = selected?.active?.view.webContents && !selected.active.view.webContents.isDestroyed() ? selected.active : undefined;
  const selDevtools = !!selected?.devtools && selected.devtoolsTab === sel;
  const selPageWidth = selDevtools ? pageWidthWithDevtools(area.width) : area.width;
  responsive.setVisible(!!sel?.emulation);
  responsive.setBounds(sel?.emulation ? { x: area.x, y: area.y, width: selPageWidth, height: RBAR } : { x: 0, y: 0, width: 1, height: 1 });
  order.push(responsive);
  if (sel) order.push(sel.view);
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
  // The screenshot of the timeline change the user chose: over the page, below the open status line.
  timeline.setVisible(timelinePreview);
  const top = TOPBAR + bar + STRIP;
  const shotBounds = { x: area.x, y: top, width: area.width, height: Math.max(1, height - top) };
  timeline.setBounds(timelinePreview ? shotBounds : { x: 0, y: 0, width: 1, height: 1 });
  order.push(timeline);
  // Marking mode: the overlay covers exactly the selected page view, or that screenshot.
  if (annotating && !sel) annotating = false;
  annotator.setVisible(annotating);
  annotator.setBounds(annotating && sel ? (timelinePreview ? shotBounds : sel.view.getBounds()) : { x: 0, y: 0, width: 1, height: 1 });
  order.push(annotator);
  // Opened, the status line lies over the page, DevTools and that screenshot.
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
    const state = { ...uiState(manager), errors: errors.slice(-3), annotating, findText: findOpen ? findText : null, timelineOpen, timelinePreview, timelineStep, linkRight, notice: notice && notice.until > Date.now() ? notice.text : null };
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
  if (s && USER_ACTIONS.has(name)) manager.userInput(s);
  switch (name) {
    case 'select': return select(args[0], args[1]);
    case 'navigate': {
      if (!s?.active) return;
      return s.active.view.webContents.loadURL(normalizeUrl(args[0])).catch(() => {});
    }
    case 'back': return s?.active?.view.webContents.navigationHistory.goBack();
    case 'forward': return s?.active?.view.webContents.navigationHistory.goForward();
    case 'reload': return s?.active?.view.webContents.reload();
    case 'stop': return s?.active?.view.webContents.stop();
    case 'devtools': return s && manager.toggleDevtools(s);
    case 'closeTab': {
      const target = manager.sessions.get(args[0])?.tabs.find(t => t.id === args[1]);
      return target?.view.webContents.close();
    }
    case 'hold': return s && manager.toggleHold(s);
    case 'pin': { const x = manager.sessions.get(args[0]); if (x) { x.pinned = !x.pinned; publish(); } return; }
    case 'mute': return s && manager.setMuted(s, typeof args[0] === 'boolean' ? args[0] : !s.muted);
    // Top bar: turn the paused debugger of the front tab on now, or pause it (and keep the project option on).
    case 'debugger': {
      if (!s?.active) return;
      if (s.active.debuggerPaused) return manager.pauseDebugger(s, s.active, false);
      return manager.setPausesDebugger(s, true);
    }
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
    case 'annotateSubmit': return s?.active && annotateSubmit(s, s.active, args[0]);
    // Console errors: the badge opens the DevTools console of the tab (optionally another session's tab first);
    // its context menu sends them to the agent.
    case 'problems': {
      if (args[0]) select(args[0], args[1]);
      const x = selected();
      if (x?.active) manager.showConsole(x, x.active);
      return;
    }
    case 'problemsMenu': {
      const x = args[0] ? manager.sessions.get(args[0]) : selected();
      const tab = args[1] ? x?.tabs.find(t => t.id === args[1]) : x?.active;
      if (x && tab) problemsMenu(x, tab, args[2], args[3]);
      return;
    }
    case 'problemsSend': return s?.active && sendProblems(s, s.active, args[0]);
    case 'problemsClear': { if (s?.active) manager.clearProblems(s.active); return; }
    // Timeline: open or close, the large preview, screenshots of steps, open a step's URL.
    case 'timeline': return setTimelineOpen(typeof args[0] === 'boolean' ? args[0] : !timelineOpen);
    case 'timelinePreview': { timelineStep = typeof args[0] === 'number' && timelineOpen ? args[0] : null; timelinePreview = timelineStep !== null; layout(); publish(); return; }
    case 'statusHeight': { const h = Math.max(STATUSBAR, Math.round(args[0])); if (h !== statusHeight) { statusHeight = h; layout(); } return; }
    case 'timelineImages': {
      const x = manager.sessions.get(args[0]);
      if (!x) return {};
      const ids: number[] = args[1] ?? [];
      return Object.fromEntries(await Promise.all(ids.map(async id => [id, await manager.stepImage(x, id, !!args[2])])));
    }
    case 'timelineOpenUrl': {
      if (!s?.active || typeof args[0] !== 'string' || !/^https?:|^file:/.test(args[0])) return;
      manager.userInput(s);
      setTimelineOpen(false);
      return s.active.view.webContents.loadURL(args[0]).catch(() => {});
    }
    case 'sessionMenu': { const x = manager.sessions.get(args[0]); if (x) sessionMenu(x, args[1], args[2], args[3]); return; }
    case 'closeBrowser': { const x = manager.sessions.get(args[0]); if (x) { manager.closeBrowser(x); layout(); } return; }
    case 'remove': { const x = manager.sessions.get(args[0]); if (x) manager.remove(x); return; }
    case 'resetSize': { if (s?.active) { s.active.fixedSize = undefined; layout(); publish(); } return; }
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
    case 'openLog': return shell.openPath(path.join(paths.logs, 'app.log'));
    case 'dismissErrors': errors.length = 0; publish(); return;
  }
}

function setAnnotating(on: boolean): void {
  annotating = on && !!selected()?.active;
  layout();
  publish();
  if (annotating) focusView(annotator);
}

function setTimelineOpen(on: boolean): void {
  timelineOpen = on && !!selected();
  timelinePreview = false;
  timelineStep = null;
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
    detail: `Asked by a page in “${project}”.${s.meta.client ? ` The agent (${s.meta.clientName ?? s.meta.client}) may be using this tab.` : ''}`,
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

/** Sends a tab's console errors (all, or the given ones) to the agent and tells the user how. */
function sendProblems(s: Session, tab: Tab, ids?: number[]): void {
  const how = manager.sendProblems(s, tab, ids);
  if (how) showNotice(how === 'sent' ? 'Sent to the waiting agent' : how === 'pushed' ? 'Sent to the agent' : 'Kept for the agent’s next feedback call');
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

function showNotice(text: string): void {
  notice = { text, until: Date.now() + 5000 };
  publish();
  setTimeout(publish, 5100);
}

/** Describes the elements in a page area (runs in an isolated world, reads the DOM only). */
const DESCRIBE_AREA = `(r => {
  const seen = new Set(), out = [];
  const label = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + CSS.escape(el.id);
    const cls = [...el.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
    return s + cls;
  };
  const path = el => { const parts = []; for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) { parts.unshift(label(e)); if (e.id) break; } return parts.join(' > '); };
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const el = document.elementFromPoint(r.x + r.width * i / 6, r.y + r.height * j / 6);
    if (!el || seen.has(el) || el === document.documentElement || el === document.body) continue;
    seen.add(el);
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push('- ' + path(el) + (text ? ' "' + text + '"' : ''));
  }
  return { title: document.title, elements: out.slice(0, 12) };
})`;

/** The user marked an area: to the waiting agent, otherwise to the clipboard. */
async function annotateSubmit(s: Session, tab: Tab, data: { rect: Electron.Rectangle; text: string }): Promise<void> {
  if (timelinePreview && timelineStep !== null) return annotateScreenshot(s, timelineStep, data);
  setAnnotating(false);
  const wc = tab.view.webContents;
  const r = data.rect;
  const image = await wc.capturePage(r);
  // View pixels to CSS pixels of the page (zoom, responsive-mode scale).
  const f = wc.getZoomFactor() * (tab.emulation?.scale ?? 1);
  const css = { x: r.x / f, y: r.y / f, width: r.width / f, height: r.height / f };
  let page: { title: string; elements: string[] } = { title: wc.getTitle(), elements: [] };
  try { page = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: `${DESCRIBE_AREA}(${JSON.stringify(css)})` }]); } catch {}
  const text = [
    data.text ? `The user says: ${data.text}` : 'The user marked an area without a comment.',
    `Page: ${wc.getURL()}${page.title ? ` ("${page.title}")` : ''}`,
    `Marked area (CSS px in the viewport): x ${Math.round(css.x)}, y ${Math.round(css.y)}, ${Math.round(css.width)} × ${Math.round(css.height)}`,
    ...(page.elements.length ? ['Elements in the area:', ...page.elements] : []),
  ].join('\n');
  await deliverFeedback(s, { text, comment: data.text, url: wc.getURL(), image });
}

/**
 * The user marked an area of an earlier screenshot (timeline): the area is cut
 * out of the stored screenshot, and the agent learns that it is about an
 * earlier state of the page, not the live one. An image has no elements.
 */
async function annotateScreenshot(s: Session, stepId: number, data: { rect: Electron.Rectangle; text: string }): Promise<void> {
  setAnnotating(false);
  const step = s.timeline.find(x => x.id === stepId);
  const file = manager.stepShotFile(s, stepId);
  const full = file ? nativeImage.createFromPath(file) : undefined;
  if (!step || !full || full.isEmpty()) return showNotice('This screenshot is no longer kept');
  // Where the screenshot lies in its view; the marked rectangle is in the same coordinates.
  let box: Electron.Rectangle | null = null;
  try { box = await timeline.webContents.executeJavaScript(`(() => { const r = document.querySelector('#frame img')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`); } catch {}
  const size = full.getSize();
  let crop = { x: 0, y: 0, width: size.width, height: size.height };
  if (box && box.width > 0 && box.height > 0) {
    const r = data.rect, k = size.width / box.width;
    const x1 = Math.max(r.x, box.x), y1 = Math.max(r.y, box.y), x2 = Math.min(r.x + r.width, box.x + box.width), y2 = Math.min(r.y + r.height, box.y + box.height);
    if (x2 - x1 > 2 && y2 - y1 > 2) crop = { x: Math.round((x1 - box.x) * k), y: Math.round((y1 - box.y) * k), width: Math.round((x2 - x1) * k), height: Math.round((y2 - y1) * k) };
  }
  const image = full.crop(crop);
  const at = new Date(step.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const url = step.url || 'unknown';
  const text = [
    data.text ? `The user says: ${data.text}` : 'The user marked an area without a comment.',
    `This is about an earlier state, not the live page: the screenshot Habitab took after your tool call ${step.tool} at ${at}.`,
    `Page then: ${url}${step.title ? ` ("${step.title}")` : ''}`,
    `Marked area (px of the ${size.width} × ${size.height} screenshot): x ${crop.x}, y ${crop.y}, ${crop.width} × ${crop.height}`,
  ].join('\n');
  await deliverFeedback(s, { text, comment: data.text, url, image, what: 'marked an area of an earlier screenshot of' });
}

/** Feedback to the waiting agent, pushed to it, or kept (and copied to the clipboard). */
async function deliverFeedback(s: Session, f: { text: string; comment: string; url: string; image: Electron.NativeImage; what?: string }): Promise<void> {
  const { text, image } = f;
  const how = manager.submitFeedback(s, { text, comment: f.comment, url: f.url, what: f.what, image: image.isEmpty() ? undefined : image.toPNG().toString('base64') });
  if (how === 'sent') return showNotice('Sent to the waiting agent');
  if (how === 'pushed') return showNotice('Sent to Claude Code');
  if (testHidden) lastClipboard = text; // tests must not touch the user's clipboard
  else await clipboard.write([new ClipboardItem({ 'text/plain': text, 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
  showNotice('Kept for the agent’s next feedback call, and copied to the clipboard');
}
let lastClipboard = '';

/** Native menu of a session in the sidebar, from its header or one of its tabs (x, y: window coordinates). */
function sessionMenu(s: Session, x: number, y: number, tabId?: number): void {
  const tab = s.tabs.find(t => t.id === tabId);
  const project = s.meta.projectName ?? 'this project';
  const persistent = manager.hasPersistentProfile(s);
  Menu.buildFromTemplate([
    {
      label: `Persistent Profile for “${project}”`, type: 'checkbox', checked: persistent, enabled: !!manager.projectRoot(s),
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
    { label: 'Keep Browser After Session Ends', type: 'checkbox', checked: s.pinned, click: () => { s.pinned = !s.pinned; publish(); } },
    { label: 'Mute Session', type: 'checkbox', checked: s.muted, click: () => manager.setMuted(s, !s.muted) },
    // Stored answers of the project (camera/microphone, clipboard), one per origin; a click forgets it (the page asks again).
    ...(sitePermissionItems(s).length ? [{ label: 'Site Permissions', submenu: sitePermissionItems(s) }] : []),
    // A dev server on plain http under its own host name (e.g. app.test → 127.0.0.1) is no secure
    // context, so camera, clipboard & co. are missing. Chromium can treat such an origin as secure.
    ...secureOriginItems(tab ?? s.active),
    {
      label: 'Pause Debugger While You Test', type: 'checkbox', checked: manager.pausesDebugger(s), enabled: !!manager.projectRoot(s),
      click: () => manager.setPausesDebugger(s, !manager.pausesDebugger(s)),
    },
    { type: 'separator' },
    { label: 'Copy Session ID', click: () => clipboard.writeText(s.meta.agentSessionId ?? s.id) },
    ...(tab?.problems.length ? [{ label: sendLabel(tab.problems.length), click: () => sendProblems(s, tab) }] : []),
    ...(tab ? [{ label: 'Close Tab', click: () => tab.view.webContents.close() }] : []),
    { label: 'Close All Tabs of Session', enabled: s.tabs.length > 0, click: () => { manager.closeBrowser(s); layout(); } },
    { label: 'Remove from List', enabled: s.ended, click: () => manager.remove(s) },
  ]).popup({ window: win, x, y });
}

function sitePermissionItems(s: Session): Electron.MenuItemConstructorOptions[] {
  const name = { media: 'Camera & Microphone', clipboard: 'Clipboard' } as const;
  return (['media', 'clipboard'] as const).flatMap(kind => Object.entries(manager.siteAccessOrigins(s, kind)).map(([origin, answer]) => ({
    label: `${name[kind]} ${answer === 'allow' ? 'allowed' : 'blocked'}: ${origin} — Forget`, click: () => manager.setSiteAccess(s, kind, origin, undefined),
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
  if (origin && !list.includes(origin)) items.push({ label: `Treat ${origin} as Secure…`, click: () => void changeSecureOrigins([...list, origin], `${origin} is treated as a secure context (camera, clipboard and other APIs that need https).`) });
  for (const o of list) items.push({ label: `Stop Treating ${o} as Secure…`, click: () => void changeSecureOrigins(list.filter(x => x !== o), `${o} is a normal http origin again.`) });
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

/** Button and ⌘\: full width ↔ thumbnails only. A hidden sidebar comes back first. */
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

function installer(op: string, ids?: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'setup-worker.js'), { workerData: { op, ids } });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

ipcMain.handle('setup', (_e, op: string, ids?: string[]) => installer(op, ids));
ipcMain.handle('habitab:share', (e, json: string) => sharePage(e.sender.id, json));

function openSetup(): void {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 760, height: 620, minWidth: 600, minHeight: 420, title: 'Habitab – Setup', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
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
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: !!s?.active, click: () => s?.active?.view.webContents.close() },
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
      { label: 'Thumbnails Only', type: 'checkbox', checked: !!prefs().sidebarCompact, accelerator: 'CmdOrCtrl+\\', click: toggleSidebarWidth },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: !!s?.active, click: () => s?.active?.view.webContents.reload() },
      { label: 'Reload Without Cache', accelerator: 'CmdOrCtrl+Shift+R', enabled: !!s?.active, click: () => s?.active?.view.webContents.reloadIgnoringCache() },
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => s?.active?.view.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => s?.active?.view.webContents.navigationHistory.goForward() },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
      { type: 'separator' },
      { label: 'DevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', enabled: !!s?.active, click: () => s && manager.toggleDevtools(s) },
      { label: 'Timeline', type: 'checkbox', checked: timelineOpen, accelerator: 'CmdOrCtrl+Shift+Y', enabled: !!s, click: () => setTimelineOpen(!timelineOpen) },
      { label: 'Responsive Mode', type: 'checkbox', checked: !!s?.active?.emulation, accelerator: 'CmdOrCtrl+Shift+M', enabled: !!s?.active, click: () => void action('responsive') },
      { label: 'Reset Agent Size', enabled: !!s?.active?.fixedSize, click: () => { if (s?.active) { s.active.fixedSize = undefined; layout(); publish(); } } },
      { role: 'togglefullscreen', label: 'Toggle Full Screen' },
    ] },
    { label: 'Session', submenu: [
      { label: s?.autoResumeAt ? 'Keep Control' : s?.held ? 'Resume Agent' : 'Take Control', accelerator: 'CmdOrCtrl+Shift+P', enabled: !!s && !s.ended, click: () => s && manager.toggleHold(s) },
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
    show: !testControl,
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const } : {}),
  });
  manager = new SessionManager(win, upstreamUrl);
  manager.onChange = publish;
  manager.onLayout = layout;
  manager.onSendElement = (s, t, x, y) => void sendElement(s, t, x, y);
  manager.onThumb = t => { if (!sidebar.webContents.isDestroyed()) sidebar.webContents.send('thumb', t.id, t.thumb ?? null); };
  manager.onNotice = showNotice;
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
    // The window hides; the app keeps serving agents until Cmd+Q.
    if (!quitting && process.platform === 'darwin') { e.preventDefault(); win.hide(); }
  });
  // Sessions of the last run come back before their launchers reconnect.
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
  setInterval(() => manager.cpuCheck(), 3_000);

  // Stable launcher for client configurations.
  try {
    const launcherJs = path.join(__dirname, '..', 'launcher', 'main.js');
    installLauncher(process.execPath, launcherJs);
    // In development the executable is Electron itself and needs the app dir.
    const args = app.isPackaged ? [] : [app.getAppPath()];
    fs.writeFileSync(paths.appPathFile, JSON.stringify({ exe: process.execPath, args }), { mode: 0o600 });
  } catch (e: any) { log(`launcher install failed: ${e.message}`); }
  if (process.env.HABITAB_TEST_CONTROL === '1') (await import('./test-control')).attach(manager, { win, select, layout, publish, upstreamUrl, action, quit: () => app.quit(), clipboard: () => lastClipboard, background: () => empty, errors: () => errors.map(e => e.message), annotating: () => annotating, findText: () => findOpen ? findText : null, lastShare: () => lastShare, view: name => ({ sidebar, topbar, timeline, annotator, status, find, devtools: selected()?.devtools } as Record<string, WebContentsView | undefined>)[name] });
  log(`app ready, chromium ${process.versions.chrome}`);
});

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('activate', () => { win?.show(); });
/** Set by a signal (e.g. Ctrl+C on `npm start`): quit without asking. */
let quitBySignal = false;
/** Set when the user chose a restart: quit without asking. */
let restarting = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { quitBySignal = true; app.quit(); });
app.on('before-quit', e => {
  if (quitting) return;
  e.preventDefault();
  void (async () => {
    const live = [...manager.sessions.values()].filter(s => !s.ended);
    if (live.length && !testControl && !quitBySignal && !restarting) {
      const r = await dialog.showMessageBox({
        type: 'question', buttons: ['Quit', 'Cancel'], defaultId: 1,
        message: `${live.length} session(s) are connected.`,
        detail: 'Habitab opens their tabs again at the next start, and the agents continue. Cookies come back; other storage (localStorage, IndexedDB) only with a persistent profile.',
      });
      if (r.response !== 0) return;
    }
    quitting = true;
    await manager.save();
    manager.close();
    for (const s of manager.sessions.values()) s.proxy?.close();
    // app.exit() skips Chromium's shutdown, so kept profiles are written first.
    await manager.flushProfiles();
    app.exit(0);
  })();
});
