// End-to-end test: Habitab app + launcher + unchanged chrome-devtools-mcp.
//   npm run build && node tests/integration/app.mjs
// Uses its own HABITAB_HOME and socket; a real installation is not touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { McpClient, sleep, check } from './mcp-client.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-app-'));
const env = {
  HABITAB_HOME: path.join(tmp, 'home'),
  HABITAB_SOCKET: process.env.HABITAB_SOCKET ?? path.join(os.tmpdir(), `hb-${process.pid}.sock`),
  HABITAB_NO_APP_LAUNCH: '1',
  HABITAB_TEST_CONTROL: '1',
  ...(process.env.HABITAB_TEST_VISIBLE ? { HABITAB_TEST_VISIBLE: process.env.HABITAB_TEST_VISIBLE } : {}),
  HABITAB_AUTO_RESUME_MS: '2500',
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
};
const launcher = ['node', path.join(root, 'dist/launcher/main.js'), 'mcp', '--', 'npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'];
const chromesBefore = new Set(execFileSync('pgrep', ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'], { encoding: 'utf8' }).split('\n').filter(Boolean));

// --- app with test control channel
let app, events = [];
function startApp() {
  events = [];
  app = spawn(path.join(root, 'node_modules/.bin/electron'), [root], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  readline.createInterface({ input: app.stdout }).on('line', l => { try { const e = JSON.parse(l); if (e.focus && Date.now() - selectedAt < 1500) e.afterSelect = true; events.push(e); } catch {} });
  app.stderr.on('data', () => {});
}
const waitFor = async (pred, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(pred); if (e) return e; await sleep(100); } return null; };
let selectedAt = 0;
const control = async line => { if (/^(select|userclick|action) /.test(line)) selectedAt = Date.now(); const n = events.length; app.stdin.write(line + '\n'); const end = Date.now() + 5000; while (Date.now() < end) { const e = events.slice(n).find(x => x.ack === line || x.state); if (e) return e; await sleep(50); } };
const state = async () => (await control('state'))?.state;
const sessionOf = async proc => {
  for (let i = 0; i < 50; i++) {
    const s = (await state()).sessions.find(x => x.projectPath && x.projectPath.endsWith(proc.project));
    if (s) return s;
    await sleep(200);
  }
};

// --- test pages
const page = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>
    <button id=p onclick="window.open('/popup','_blank')">Popup</button>
    <script>if (location.pathname === '/popup') document.title = 'Popup opener=' + (window.opener ? 'yes' : 'no');</script>`);
});
await new Promise(r => page.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${page.address().port}`;

const project = name => { const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const client = (name, clientName) => {
  const c = new McpClient(launcher[0], launcher.slice(1), { env, cwd: project(name), clientName });
  c.project = name;
  return c;
};
const pageId = async c => +((await c.tool('list_pages')).text.match(/^(\d+):.*\[selected\]/m)?.[1] ?? 1);

startApp();
const ready = await waitFor(e => e.ready);
check(!!ready, 'app starts', `Chromium ${ready?.chrome}`);
const a = client('alpha-shop', 'claude-code'), b = client('beta-api', 'codex-mcp-client');
const [initA] = await Promise.all([a.initialize(), b.initialize()]);
check(/never by its pageId/.test(initA.result?.instructions ?? '') && initA.result?.serverInfo, 'launcher adds tab naming instructions to the server answer', (initA.result?.instructions ?? '').slice(0, 80));
let sa = await sessionOf(a), sb = await sessionOf(b);
check(sa && sb && sa.id !== sb.id, 'two sessions registered');
check(!sa.browser && sa.tabs.length === 0, 'lazy: no browser before the first tool call');
check(sa.client === 'claude' && sb.client === 'codex', 'client from clientInfo', `${sa.client}/${sb.client}`);

await Promise.all([a.tool('navigate_page', { pageId: await pageId(a), url: `${base}/alpha` }), b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/beta` }, { threadId: 'thread-123' })]);
sa = await sessionOf(a); sb = await sessionOf(b);
check(sa.browser && sa.tabs.some(t => t.url.endsWith('/alpha')), 'session A shows its page in the app');
check(sb.agentSessionId === 'thread-123', 'Codex thread id from _meta', sb.agentSessionSource);
const la = (await a.tool('list_pages')).text, lb = (await b.tool('list_pages')).text;
check(!la.includes('/beta') && !lb.includes('/alpha'), 'each agent sees only its own tabs');
const pa = await pageId(a), pb = await pageId(b);
const agentStart = Date.now();
await a.tool('evaluate_script', { pageId: pa, function: '() => { document.cookie = "who=a"; localStorage.setItem("who","a"); return 1 }' });
const iso = await b.tool('evaluate_script', { pageId: pb, function: '() => JSON.stringify({c: document.cookie, l: localStorage.getItem("who")})' });
check(iso.text.includes('\\"c\\":\\"\\"') && iso.text.includes('\\"l\\":null'), 'cookies and storage separated');

// Parallel work in both sessions, one of them not visible.
await control(`select ${sa.id}`);
for (const [name, c, p] of [['A visible', a, pa], ['B hidden', b, pb]]) {
  const t = Date.now();
  const r = await Promise.race([c.tool('take_screenshot', { pageId: p }), sleep(10000).then(() => ({ isError: true, text: 'TIMEOUT' }))]);
  check(!r.isError, `screenshot ${name}`, `${Date.now() - t} ms ${r.isError ? r.text.slice(0, 100) : ''}`);
}
const t0 = Date.now();
const par = await Promise.all([
  ...[1, 2, 3].map(i => a.tool('take_screenshot', { pageId: pa })),
  ...[1, 2, 3].map(i => b.tool('take_screenshot', { pageId: pb })),
]);
check(par.every(r => !r.isError), 'parallel screenshots in visible and hidden session', `${Date.now() - t0} ms`);

// new_page / close_page and popups with opener
const np = await a.tool('new_page', { url: `${base}/second` });
check(!np.isError && np.text.includes('/second'), 'new_page opens a tab in the session');
const second = +((await a.tool('list_pages')).text.match(/^(\d+):.*\/second/m)?.[1]);
check(!(await a.tool('close_page', { pageId: second })).isError, 'close_page closes it');
const snap = (await a.tool('take_snapshot', { pageId: pa })).text;
await a.tool('click', { pageId: pa, uid: snap.match(/uid=(\S+) button "Popup"/)?.[1] });
await sleep(1000);
const withPopup = (await a.tool('list_pages')).text;
check(withPopup.includes('/popup') && !(await b.tool('list_pages')).text.includes('/popup'), 'popup becomes a tab of the same session');
check(withPopup.includes('opener=yes'), 'popup keeps window.opener', withPopup.match(/Popup opener=\w+/)?.[0]);

// resize_page sets the exact size
const pa2 = +(withPopup.match(/^(\d+):.*\/alpha/m)?.[1] ?? pa);
await a.tool('select_page', { pageId: pa2 });
await a.tool('resize_page', { pageId: pa2, width: 820, height: 600 });
const vp = (await a.tool('evaluate_script', { pageId: pa2, function: '() => innerWidth + "x" + innerHeight' })).text.match(/\d+x\d+/)?.[0];
check(vp === '820x600', 'resize_page sets exact viewport', vp);

// Responsive mode: the user's emulation reaches the page; the agent's own shows in the bar
// DevTools docked while the agent works
await control(`devtools ${sa.id}`);
await sleep(1200);
const dt = await Promise.all([a.tool('take_snapshot', { pageId: pa2 }), a.tool('evaluate_script', { pageId: pa2, function: '() => 1' })]);
check(dt.every(r => !r.isError) && !(await a.tool('list_pages')).text.includes('devtools://'), 'agent works with DevTools docked; DevTools hidden from agent');
check((await state()).sessions.find(s => s.id === sa.id).devtools, 'DevTools shown in the app');

// Human control: tool calls wait
await control(`hold ${sb.id} on`);
await sleep(300);
let done = false;
const held = b.tool('evaluate_script', { pageId: pb, function: '() => 42' }).then(r => { done = true; return r; });
await sleep(2000);
check(!done, 'tool call waits while the human has control');
await control(`hold ${sb.id} off`);
check((await held).text.includes('42') && done, 'tool call continues after release');

// Automatic control: agent input does not count, a user click does
await a.tool('press_key', { pageId: pa2, key: 'Tab' });
await a.tool('click', { pageId: pa2, uid: (await a.tool('take_snapshot', { pageId: pa2 })).text.match(/uid=(\S+) heading/)?.[1] });
check(!(await state()).sessions.find(s => s.id === sa.id).held, 'agent input does not take control');
await control(`select ${sb.id}`);
await control(`userclick ${sb.id}`);
await sleep(300);
const auto = (await state()).sessions.find(s => s.id === sb.id);
check(auto.held && auto.autoResumeIn > 0, 'user click takes control automatically', JSON.stringify({ held: auto.held, in: auto.autoResumeIn }));
let autoDone = false;
const t1 = Date.now();
const waiting = b.tool('evaluate_script', { pageId: pb, function: '() => 43' }).then(r => { autoDone = true; return r; });
await sleep(1000);
check(!autoDone, 'tool call waits during automatic control');
check((await waiting).text.includes('43') && !(await state()).sessions.find(s => s.id === sb.id).held, 'agent resumes by itself after a pause', `${Date.now() - t1} ms`);

// Switching to another app ends automatic control at once
await control(`userclick ${sb.id}`);
await sleep(300);
const heldBefore = (await state()).sessions.find(s => s.id === sb.id).held;
await control('blur');
await sleep(200);
check(heldBefore && !(await state()).sessions.find(s => s.id === sb.id).held, 'leaving the app ends automatic control at once');
await control(`hold ${sb.id} on`);
await control('blur');
await sleep(200);
check((await state()).sessions.find(s => s.id === sb.id).held, 'manual control stays when leaving the app');
await control(`hold ${sb.id} off`);

// Feedback tool: listed, waits for the user's marked area; never held back
const toolList = await b.request('tools/list', {});
check(toolList.result?.tools?.some(t => t.name === 'wait_for_user_feedback'), 'feedback tool added to the tool list');
await control(`hold ${sb.id} on`);
const asked = b.tool('wait_for_user_feedback', { question: 'Which part?', timeout_seconds: 60 });
let fbState;
for (let i = 0; i < 30 && !fbState; i++) { await sleep(100); fbState = (await state()).sessions.find(s => s.id === sb.id).feedback; }
check(fbState?.question === 'Which part?', 'Habitab shows the question of the waiting agent (also while held)', JSON.stringify(fbState));
await control(`action ${sb.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 300, "height": 120}, "text": "This heading please"}`);
const answer = await asked;
check(answer.text.includes('This heading please') && answer.text.includes('Elements in the area') && answer.raw.result.content.some(c => c.type === 'image' && c.data.length > 100),
  'feedback tool returns comment, elements and the area as image', answer.text.replace(/\n/g, ' | ').slice(0, 200));
await control(`hold ${sb.id} off`);
await control(`action ${sb.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 100, "height": 50}, "text": "Copy me"}`);
await sleep(600);
check((await state()).clipboard?.includes('Copy me') && (await state()).sessions.find(s => s.id === sb.id).feedbackQueued === 1, 'without a waiting agent the area is kept (and copied to the clipboard)');
const queued = await b.tool('wait_for_user_feedback', { timeout_seconds: 30 });
check(queued.text.includes('Copy me') && queued.text.includes('call wait_for_user_feedback again') && queued.raw.result.content.some(c => c.type === 'image'),
  'the next feedback call returns kept feedback at once, with the follow-up hint', queued.text.replace(/\n/g, ' | ').slice(0, 160));

// Claude Code channel: with the development flag, feedback arrives as a channel event
const d = new McpClient(process.execPath, [path.join(import.meta.dirname, 'channel-parent.mjs'), '--dangerously-load-development-channels', 'server:chrome-devtools', '--', ...launcher],
  { env, cwd: project('delta'), clientName: 'claude-code' });
const initD = await d.initialize();
check(initD.result?.capabilities?.experimental?.['claude/channel'], 'launcher declares the claude/channel capability for Claude Code');
await d.tool('navigate_page', { pageId: await pageId(d), url: `${base}/delta` });
const sd = (await state()).sessions.find(s => s.project === 'delta');
check(sd?.channel === true && (await state()).sessions.find(s => s.id === sa.id)?.channel === false, 'channel detected from the client command line (and only there)');
await control(`action ${sd.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 200, "height": 80}, "text": "Make it green"}`);
let event;
for (let i = 0; i < 30 && !event; i++) { await sleep(100); event = d.notifications.find(n => n.method === 'notifications/claude/channel'); }
check(event?.params?.content.includes('Make it green') && event.params.content.includes('wait_for_user_feedback') && !event.params.content.includes('Elements'),
  'marked area pushed as channel event (user words only)', JSON.stringify(event?.params ?? null).slice(0, 160));
const afterPush = await d.tool('wait_for_user_feedback', { timeout_seconds: 30 });
check(afterPush.text.includes('Make it green') && afterPush.raw.result.content.some(c => c.type === 'image'), 'the feedback call after the event returns screenshot and elements at once');
await d.close();

// bringToFront shows the tab in its session (without raising the window)
await b.tool('select_page', { pageId: pb, bringToFront: true });
await sleep(300);
{ const sb2 = (await state()).sessions.find(s => s.id === sb.id); check(sb2.tabs.find(t => t.active)?.url.endsWith('/beta'), 'bringToFront activates the tab in Habitab', sb2.tabs.find(t => t.active)?.url); }
const viewport = async () => JSON.parse((await b.tool('evaluate_script', { pageId: pb, function: '() => JSON.stringify([screen.width, screen.height, devicePixelRatio])' })).text.match(/\[[^\]]*\]/)?.[0] ?? 'null');
await control(`action ${sb.id} responsive`);
await sleep(500);
// Default: the viewport fills the free space at 100 %
let nav = (await state()).sessions.find(s => s.id === sb.id).nav;
let vp0 = await viewport();
check(nav.emulation.fillWidth && nav.emulation.fillHeight && nav.frame?.scale === 1 && vp0?.[0] === nav.frame.width && vp0?.[1] === nav.frame.height,
  'responsive mode fills the free space by default', JSON.stringify({ vp0, frame: nav.frame }));
// Tailwind breakpoint: width fixed, height still fills
await control(`action ${sb.id} emulate {"preset": "responsive", "width": 768}`);
await sleep(400);
nav = (await state()).sessions.find(s => s.id === sb.id).nav;
check((await viewport())?.[0] === 768 && !nav.emulation.fillWidth && nav.emulation.fillHeight, 'breakpoint sets the width, the height keeps filling');
// Dragging the right handle by 50 px widens the centered viewport by 100 px
await control(`draghandle ${sb.id} 50`);
await sleep(500);
check((await viewport())?.[0] === 868, 'dragging the right handle changes the width', JSON.stringify(await viewport()));
await control(`action ${sb.id} emulate {"preset":"iphone-se","width":375,"height":667,"dpr":2,"mobile":true}`);
await sleep(500);
let vpa = await viewport();
let emu = (await state()).sessions.find(s => s.id === sb.id).nav.emulation;
check(vpa?.[0] === 375 && vpa?.[1] === 667 && vpa?.[2] === 2 && emu?.by === 'user', 'responsive mode emulates the device for the agent too', JSON.stringify({ vpa, emu }));
await control(`action ${sb.id} emulate {"rotate":true}`);
await sleep(400);
vpa = await viewport();
check(vpa?.[0] === 667 && vpa?.[1] === 375, 'rotate swaps width and height', JSON.stringify(vpa));
await b.tool('emulate', { pageId: pb, viewport: '500x400x1' });
await sleep(400);
emu = (await state()).sessions.find(s => s.id === sb.id).nav.emulation;
check(emu?.by === 'agent' && emu.width === 500 && emu.height === 400, "the agent's emulation replaces the user's and shows in the bar", JSON.stringify(emu));
await control(`action ${sb.id} responsive`);
await sleep(400);
vpa = await viewport();
check(!(await state()).sessions.find(s => s.id === sb.id).nav.emulation && vpa?.[0] > 600 && vpa?.[2] === 2, 'leaving responsive mode restores the page size', JSON.stringify(vpa));

// Agents work in the background: the window never took focus by itself
// (Ignores the app start and the test's own select commands, which focus the page like a user click.)
{ const f = events.filter(e => e.focus && e.at > agentStart && !e.afterSelect); check(f.length === 0, 'window never takes focus during agent work', f.map(e => e.stack).join(' || ')); }

// No Chrome started, one app in the Dock
const chromesAfter = execFileSync('pgrep', ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'], { encoding: 'utf8' }).split('\n').filter(Boolean).filter(p => !chromesBefore.has(p));
check(chromesAfter.length === 0, 'no Chrome process started', chromesAfter.join(','));
const dock = execFileSync('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'], { encoding: 'utf8' });
// The test app has no Dock icon unless it runs visibly (HABITAB_TEST_VISIBLE=1).
if (process.env.HABITAB_TEST_VISIBLE === '1') check((dock.match(/Electron|Habitab/g) ?? []).length === 1, 'exactly one Habitab/Electron app in the Dock');

// Regular end closes the session browser
await a.close();
await sleep(800);
sa = (await state()).sessions.find(s => s.id === sa.id);
check(sa.phase === 'ended' && sa.tabs.length === 0, 'regular end closes all tabs of the session', sa.phase);

// Pinned session keeps its browser after a hard crash of the launcher
await control(`pin ${sb.id} on`);
b.proc.kill('SIGKILL');
await sleep(1000);
sb = (await state()).sessions.find(s => s.id === sb.id);
check(sb.phase === 'kept' && sb.tabs.length > 0, 'launcher SIGKILL: pinned session keeps its browser', sb.phase);
await control(`remove ${sb.id}`);
check(!(await state()).sessions.find(s => s.id === sb.id), 'removing the session closes it');

// App restart: the launcher reconnects; a new browser starts on demand
const c = client('gamma', 'claude-code');
await c.initialize();
await c.tool('navigate_page', { pageId: await pageId(c), url: `${base}/gamma` });
const cookie = async () => (await c.tool('evaluate_script', { pageId: await pageId(c), function: '() => document.cookie' })).text;
await c.tool('evaluate_script', { pageId: await pageId(c), function: '() => { document.cookie = "login=yes; max-age=3600"; return 1 }' });
// Persistent profile: the running browser moves to the project profile and keeps the cookie
const sc = (await state()).sessions.find(s => s.project === 'gamma');
await control(`action ${sc.id} persistentProfile "${sc.id}"`);
await sleep(2500);
check((await state()).sessions.find(s => s.id === sc.id)?.persistentProfile && (await cookie()).includes('login=yes'), 'persistent profile: the session moves to it with its cookies', (await cookie()).slice(0, 120));
await control('quit');
await sleep(2500);
startApp();
await waitFor(e => e.ready);
await sleep(2500);
const afterRestart = await c.tool('list_pages');
const pc = +(afterRestart.text.match(/^(\d+):/m)?.[1] ?? 1);
const nav2 = await c.tool('navigate_page', { pageId: pc, url: `${base}/gamma-2` });
check(!nav2.isError, 'after app restart the agent continues with a new session browser', nav2.text.slice(0, 80));
check((await cookie()).includes('login=yes'), 'persistent profile survives an app restart', (await cookie()).slice(0, 120));
// A second, parallel session of the same project gets a copy, not the profile itself
const c2 = client('gamma', 'claude-code');
await c2.initialize();
await c2.tool('navigate_page', { pageId: await pageId(c2), url: `${base}/gamma-3` });
const c2cookie = (await c2.tool('evaluate_script', { pageId: await pageId(c2), function: '() => document.cookie' })).text;
const c2pages = (await c2.tool('list_pages')).text;
check(c2cookie.includes('login=yes') && !c2pages.includes('gamma-2'), 'parallel session of the project: copied cookies, own tabs', c2pages.replace(/\n/g, ' ').slice(0, 160));
await c2.close();
await c.close();

app.kill();
page.close();
// The app may still write its profile while it exits.
await new Promise(r => (app.exitCode !== null ? r() : app.once('exit', r)));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
