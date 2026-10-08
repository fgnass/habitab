// Habitab app: one window with the session list on the left and the real
// Chromium view of the selected session on the right, DevTools docked.
import { app, BaseWindow, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeTheme, screen, shell, WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ensureHome, log, openLog, paths } from '../shared/paths';
import { installLauncher } from '../installer/installer';
import { prefs, setPrefs, SidebarMode, sidebarMode } from './prefs';
import { Session, SessionManager, Tab } from './sessions';
import { uiState } from './ui-state';

/** Sidebar widths: thumbnails with titles, thumbnails only (room for the window buttons), none. */
const SIDEBAR_WIDTH: Record<SidebarMode, number> = { full: 280, compact: 84, hidden: 0 };
const sidebarWidth = () => SIDEBAR_WIDTH[sidebarMode()];
const TOPBAR = 46;
/** Height of the responsive mode bar above an emulated page. */
const RBAR = 38;
/** Space around an emulated page in responsive mode (room for the resize handles). */
const FRAME_SIDE = 18, FRAME_TOP = 10, FRAME_BOTTOM = 20;
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
let sidebar: WebContentsView, topbar: WebContentsView, empty: WebContentsView, responsive: WebContentsView, splitter: WebContentsView, annotator: WebContentsView;
/** Marking mode: the annotator overlay lies over the selected page. */
let annotating = false;
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
  const area = { x: SIDEBAR, y: TOPBAR, width: width - SIDEBAR, height: height - TOPBAR };
  const selected = manager.sessions.get(manager.selected ?? '');
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
  const sel = selected?.active;
  const selDevtools = !!selected?.devtools && selected.devtoolsTab === sel;
  const selPageWidth = selDevtools ? pageWidthWithDevtools(area.width) : area.width;
  responsive.setVisible(!!sel?.emulation);
  responsive.setBounds(sel?.emulation ? { x: area.x, y: area.y, width: selPageWidth, height: RBAR } : { x: 0, y: 0, width: 1, height: 1 });
  order.push(responsive);
  if (sel) order.push(sel.view);
  if (selDevtools) order.push(selected!.devtools!);
  // The splitter sits on the edge; while dragging it covers the whole area to keep the pointer.
  splitter.setVisible(selDevtools);
  splitter.setBounds(!selDevtools ? { x: 0, y: 0, width: 1, height: 1 } : splitting ? area : { x: area.x + selPageWidth - 3, y: area.y, width: 7, height: area.height });
  order.push(splitter);
  // Marking mode: the overlay covers exactly the selected page view.
  if (annotating && !sel) annotating = false;
  annotator.setVisible(annotating);
  annotator.setBounds(annotating && sel ? sel.view.getBounds() : { x: 0, y: 0, width: 1, height: 1 });
  order.push(annotator);
  for (const v of order) if (!v.webContents.isDestroyed()) win.contentView.addChildView(v);
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
    const state = { ...uiState(manager), errors: errors.slice(-3), annotating, notice: notice && notice.until > Date.now() ? notice.text : null };
    for (const v of [sidebar, topbar, empty, responsive, annotator]) if (!v.webContents.isDestroyed()) v.webContents.send('state', state);
    updateMenu();
  }, 50);
}

function selected(): Session | undefined { return manager.sessions.get(manager.selected ?? ''); }

function select(id: string, tabId?: number): void {
  const s = manager.sessions.get(id);
  if (!s) return;
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
    case 'persistentProfile': { const x = manager.sessions.get(args[0]); if (x) { await manager.togglePersistentProfile(x); layout(); publish(); } return; }
    case 'sidebar': return toggleSidebarWidth();
    case 'annotate': return setAnnotating(args[0] ?? !annotating);
    case 'annotateSubmit': return s?.active && annotateSubmit(s, s.active, args[0]);
    case 'sessionMenu': { const x = manager.sessions.get(args[0]); if (x) sessionMenu(x, args[1], args[2]); return; }
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
  const how = manager.submitFeedback(s, { text, comment: data.text, url: wc.getURL(), image: image.isEmpty() ? undefined : image.toPNG().toString('base64') });
  if (how === 'sent') return showNotice('Sent to the waiting agent');
  if (how === 'pushed') return showNotice('Sent to Claude Code');
  if (testHidden) lastClipboard = text; // tests must not touch the user's clipboard
  else await clipboard.write([new ClipboardItem({ 'text/plain': text, 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
  showNotice('Kept for the agent’s next feedback call, and copied to the clipboard');
}
let lastClipboard = '';

/** Native context menu of a session (x, y: sidebar coordinates = window coordinates). */
function sessionMenu(s: Session, x: number, y: number): void {
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
    { type: 'separator' },
    { label: 'Copy Session ID', click: () => clipboard.writeText(s.meta.agentSessionId ?? s.id) },
    { label: 'Close Browser', enabled: s.tabs.length > 0, click: () => { manager.closeBrowser(s); layout(); } },
    { label: 'Remove from List', enabled: s.ended, click: () => manager.remove(s) },
  ]).popup({ window: win, x, y });
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
      { role: 'selectAll', label: 'Select All' },
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
      { label: 'Responsive Mode', type: 'checkbox', checked: !!s?.active?.emulation, accelerator: 'CmdOrCtrl+Shift+M', enabled: !!s?.active, click: () => void action('responsive') },
      { label: 'Reset Agent Size', enabled: !!s?.active?.fixedSize, click: () => { if (s?.active) { s.active.fixedSize = undefined; layout(); publish(); } } },
      { role: 'togglefullscreen', label: 'Toggle Full Screen' },
    ] },
    { label: 'Session', submenu: [
      { label: s?.autoResumeAt ? 'Keep Control' : s?.held ? 'Resume Agent' : 'Take Control', accelerator: 'CmdOrCtrl+Shift+P', enabled: !!s && !s.ended, click: () => s && manager.toggleHold(s) },
      { label: 'Mark Area for Agent…', accelerator: 'CmdOrCtrl+Shift+A', enabled: !!s?.active, click: () => setAnnotating(true) },
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
  manager.onThumb = s => { if (!sidebar.webContents.isDestroyed()) sidebar.webContents.send('thumb', s.id, s.thumb ?? null); };
  empty = uiView('empty.html');
  responsive = uiView('responsive.html');
  splitter = uiView('splitter.html');
  annotator = uiView('annotate.html');
  sidebar = uiView('sidebar.html');
  sidebar.webContents.on('did-finish-load', () => { for (const s of manager.sessions.values()) if (s.thumb) manager.onThumb(s); });
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
  manager.listen();
  if (testControl) {
    if (testHidden) { win.setOpacity(0); win.setIgnoreMouseEvents(true); }
    win.showInactive();
  }
  layout();
  updateMenu();
  setInterval(() => manager.idleCheck(), 30_000);

  // Stable launcher for client configurations.
  try {
    const launcherJs = path.join(__dirname, '..', 'launcher', 'main.js');
    installLauncher(process.execPath, launcherJs);
    // In development the executable is Electron itself and needs the app dir.
    const args = app.isPackaged ? [] : [app.getAppPath()];
    fs.writeFileSync(paths.appPathFile, JSON.stringify({ exe: process.execPath, args }), { mode: 0o600 });
  } catch (e: any) { log(`launcher install failed: ${e.message}`); }
  if (process.env.HABITAB_TEST_CONTROL === '1') (await import('./test-control')).attach(manager, { win, select, layout, upstreamUrl, action, quit: () => app.quit(), clipboard: () => lastClipboard, background: () => empty });
  log(`app ready, chromium ${process.versions.chrome}`);
});

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('activate', () => { win?.show(); });
app.on('before-quit', e => {
  if (quitting) return;
  e.preventDefault();
  void (async () => {
    const live = [...manager.sessions.values()].filter(s => !s.ended);
    if (live.length && !testControl) {
      const r = await dialog.showMessageBox({
        type: 'question', buttons: ['Quit', 'Cancel'], defaultId: 1,
        message: `${live.length} session(s) are connected.`,
        detail: 'Quitting closes their browsers. The agents start Habitab again the next time they use the browser. Only projects with a persistent profile keep their cookies and storage.',
      });
      if (r.response !== 0) return;
    }
    quitting = true;
    manager.close();
    for (const s of manager.sessions.values()) s.proxy?.close();
    // app.exit() skips Chromium's shutdown, so kept profiles are written first.
    await manager.flushProfiles();
    app.exit(0);
  })();
});
