// End-to-end test of the browser bridge: chrome-devtools-mcp unchanged and
// without the launcher. Its global config (cd4a) names Habitab's browser
// script as executablePath; Puppeteer starts it in place of Chrome.
//   npm run build && node tests/integration/browser.mjs
// Uses its own HABITAB_HOME, socket and XDG_CONFIG_HOME; nothing real is touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import net from 'node:net';
import { McpClient, sleep, check } from './mcp-client.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const electronBin = createRequire(import.meta.url)('electron');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-browser-'));
const env = {
  HABITAB_HOME: path.join(tmp, 'home'),
  HABITAB_SOCKET: process.env.HABITAB_SOCKET ?? path.join(os.tmpdir(), `hb-b-${process.pid}.sock`),
  HABITAB_NO_APP_LAUNCH: '1',
  HABITAB_TEST_CONTROL: '1',
  ...(process.env.HABITAB_TEST_VISIBLE ? { HABITAB_TEST_VISIBLE: process.env.HABITAB_TEST_VISIBLE } : {}),
  HABITAB_AUTO_RESUME_MS: '2500',
  HABITAB_FAKE_SPEECH: '1',
  // The app sets the global config at start (as outside tests).
  HABITAB_TEST_MIGRATE: '1',
  // The server's global config lives under XDG_CONFIG_HOME (macOS and Linux).
  XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
  // A fake Codex app-server daemon listens under this CODEX_HOME (see below). Short: unix socket paths are limited.
  CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cx-')),
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '',
  CLAUDE_CODE_MESSAGING_TOKEN: '',
  HABITAB_CODEX_COMMAND: '',
};
const { WebSocketServer } = createRequire(import.meta.url)('ws');
const browserScript = path.join(env.HABITAB_HOME, 'bin', 'habitab-browser');
const cd4aConfig = path.join(env.XDG_CONFIG_HOME, 'cd4a', 'config.json');
const server = ['npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'];
const launcher = ['node', path.join(root, 'dist/launcher/main.js'), 'mcp', '--', ...server];
const habitab = args => execFileSync('node', [path.join(root, 'dist/launcher/main.js'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const chromePids = () => {
  const pattern = process.platform === 'darwin' ? 'Google Chrome.app/Contents/MacOS/Google Chrome' : '^[^ ]*(google-chrome|/chrome/chrome|chromium)( |$)';
  try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
};
const chromesBefore = new Set(chromePids());

// --- app with test control channel
let app, events = [];
function startApp() {
  events = [];
  app = spawn(electronBin, [root], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  readline.createInterface({ input: app.stdout }).on('line', l => { try { events.push(JSON.parse(l)); } catch {} });
  app.stderr.on('data', () => {});
}
const waitFor = async (pred, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(pred); if (e) return e; await sleep(100); } return null; };
const control = async line => { const n = events.length; app.stdin.write(line + '\n'); const end = Date.now() + 5000; while (Date.now() < end) { const e = events.slice(n).find(x => x.ack === line || x.state); if (e) return e; await sleep(50); } };
const state = async () => (await control('state'))?.state;
const sessionOf = async (name, pred = () => true) => {
  for (let i = 0; i < 100; i++) {
    const s = (await state()).sessions.find(x => x.projectPath && x.projectPath.endsWith(name) && pred(x));
    if (s) return s;
    await sleep(200);
  }
};
const project = name => { const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const pageId = async c => +((await c.tool('list_pages')).text.match(/^(\d+):.*\[selected\]/m)?.[1] ?? 1);

// --- test pages
const page = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1><a href="/linked">Link</a>`);
});
await new Promise(r => page.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${page.address().port}`;

// --- fake Codex app-server daemon: JSON-RPC over a WebSocket on the control socket
const daemonSock = path.join(env.CODEX_HOME, 'app-server-control', 'app-server-control.sock');
fs.mkdirSync(path.dirname(daemonSock), { recursive: true });
const daemon = { requests: [], clients: new Set(), thread: { id: 'thread-abc', name: 'Fix the login', status: { type: 'active' } } };
const daemonHttp = http.createServer();
const wss = new WebSocketServer({ server: daemonHttp });
wss.on('connection', ws => {
  daemon.clients.add(ws);
  ws.on('message', d => {
    const m = JSON.parse(String(d));
    if (m.id === undefined) return;
    daemon.requests.push(m);
    const reply = result => ws.send(JSON.stringify({ id: m.id, result }));
    if (m.method === 'initialize') return reply({ userAgent: 'fake' });
    if (m.method === 'thread/list') return reply({ data: m.params.cwd === daemon.thread.cwd ? [{ ...daemon.thread }] : [], nextCursor: null });
    if (m.method === 'thread/read') return reply({ thread: { ...daemon.thread, turns: m.params.includeTurns ? [{ id: 'turn-0', status: 'completed' }, { id: 'turn-1', status: 'inProgress' }] : undefined } });
    if (m.method === 'thread/resume') return reply({ thread: { ...daemon.thread } });
    if (m.method === 'turn/steer' || m.method === 'turn/start') return reply({ turn: { id: 'turn-1' } });
    reply({});
  });
  ws.on('close', () => daemon.clients.delete(ws));
});
const notifyDaemon = (method, params) => { for (const c of daemon.clients) c.send(JSON.stringify({ method, params })); };
await new Promise(r => daemonHttp.listen(daemonSock, r));

// --- fake Claude Code inbox socket (cross-session messaging)
const inboxPath = path.join(tmp, 'inbox.sock');
const inboxLines = [];
const inbox = net.createServer(sock => {
  let buf = '';
  sock.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { try { inboxLines.push(JSON.parse(buf.slice(0, i))); } catch {} buf = buf.slice(i + 1); } });
});
await new Promise(r => inbox.listen(inboxPath, r));

// Nothing is set up yet: the app does that at start.
fs.rmSync(cd4aConfig, { force: true });
startApp();
const ready = await waitFor(e => e.ready);
check(!!ready, 'app starts', `Chromium ${ready?.chrome}`);
for (let i = 0; i < 50 && !fs.existsSync(browserScript); i++) await sleep(100);
check(fs.existsSync(browserScript), 'the app installs the browser script', browserScript);
for (let i = 0; i < 100 && !fs.existsSync(cd4aConfig); i++) await sleep(100);
check(fs.existsSync(cd4aConfig) && JSON.parse(fs.readFileSync(cd4aConfig, 'utf8')).executablePath === browserScript, 'the app names its browser in the global config at start', fs.readFileSync(cd4aConfig, 'utf8').replace(/\n/g, ' '));
check(/already names/.test(habitab(['cd4a', '--apply'])), 'habitab cd4a --apply: nothing more to do');
check(/names Habitab's browser/.test(habitab(['cd4a'])), 'habitab cd4a: shows the entry');

// A session signed on by a launcher of Habitab 0.2 (no server pid) is marked: its server needs a restart
{ const sock = net.connect(env.HABITAB_SOCKET);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ type: 'hello', sessionId: 'hb-legacy001', launcherPid: process.pid, meta: { cwd: project('old-way'), projectName: 'old-way', client: 'claude' } }) + '\n');
  let legacy;
  for (let i = 0; i < 50 && !legacy; i++) { await sleep(100); legacy = (await state()).sessions.find(s => s.id === 'hb-legacy001'); }
  check(legacy?.legacy === true, 'a session of an old launcher shows that its server needs a restart');
  sock.write(JSON.stringify({ type: 'bye', reason: 'test' }) + '\n'); sock.end();
  await sleep(300);
  await control('remove hb-legacy001');
}

// chrome-devtools-mcp without launcher, in a shell script named "claude" (the client above the server)
const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, `#!/bin/sh\n${server.join(' ')}\n`, { mode: 0o755 });
const a = new McpClient(fakeClaude, [], { env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: inboxPath, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' }, cwd: project('zeta-app') });
const init = await a.initialize();
check(init.result?.serverInfo?.name, 'server starts without the launcher', `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`);
let sa = await sessionOf('zeta-app');
check(!sa, 'lazy: no session before the first tool call');
const nav = await a.tool('navigate_page', { pageId: await pageId(a), url: `${base}/zeta` });
check(!nav.isError, 'navigate_page works through the browser bridge', nav.text.slice(0, 120).replace(/\n/g, ' | '));
sa = await sessionOf('zeta-app', s => s.tabs.length);
check(sa && sa.browser && sa.tabs.some(t => t.url.endsWith('/zeta')), 'the session shows the page in the app', JSON.stringify(sa?.tabs.map(t => t.url)));
check(sa && /^hb-p\d+$/.test(sa.id), 'session id from the server process', sa?.id);
check(sa?.client === 'claude', 'client found in the process tree', `${sa?.client} (${sa?.clientName ?? 'no clientInfo'})`);
check(chromePids().filter(p => !chromesBefore.has(p)).length === 0, 'no Chrome started');
const pa = await pageId(a);
const shot = await a.tool('take_screenshot', { pageId: pa });
check(!shot.isError && shot.raw.result?.content?.some(c => c.type === 'image'), 'take_screenshot works');
const snap = await a.tool('take_snapshot', { pageId: pa });
check(!snap.isError && /link "Link"/.test(snap.text), 'take_snapshot works');
const np = await a.tool('new_page', { url: `${base}/second` });
check(!np.isError && (await a.tool('list_pages')).text.includes('/second'), 'new_page opens a tab in the session');

// Steps from CDP: readable names, none for calls that change nothing. An agent
// pauses between calls (model latency); calls without a pause become one step.
const pause = () => sleep(900);
await pause();
const stepsBefore = (await state()).sessions.find(s => s.id === sa.id).activity.length;
for (const [tool, args] of [
  ['take_screenshot', { pageId: pa }], ['take_snapshot', { pageId: pa }], ['list_pages', {}], ['list_console_messages', { pageId: pa }],
  ['evaluate_script', { pageId: pa, function: '() => { const answer = 42; return answer }' }],
  ['click', { pageId: pa, uid: snap.text.match(/uid=(\S+) link "Link"/)?.[1] }],
]) { await a.tool(tool, args); await pause(); }
await sleep(600);
const after = (await state()).sessions.find(s => s.id === sa.id);
const tools = after.activity.slice(0, after.activity.length - stepsBefore).reverse();
check(tools.map(x => x.tool).join(',') === 'Screenshot,Snapshot,Script,Click', 'steps from CDP: one readable step per tool, none for list_pages', tools.map(x => x.tool).join(','));
check(tools.every(x => !x.isError), 'steps without errors', JSON.stringify(tools.filter(x => x.isError).map(x => [x.tool, x.detail])));
const script = tools.find(x => x.tool === 'Script');
check(script?.summary?.includes('const answer = 42'), 'the script step shows the agent\'s source', script?.summary);
check(after.timelineCount >= 4, 'steps land in the timeline', String(after.timelineCount));
await a.tool('navigate_page', { pageId: pa, type: 'back' });
await pause();

// Human control: commands wait
await control(`hold ${sa.id} on`);
await sleep(300);
let done = false;
const held = a.tool('evaluate_script', { pageId: pa, function: '() => 7' }).then(r => { done = true; return r; });
await sleep(1500);
check(!done, 'while the user has control, the agent waits');
await control(`hold ${sa.id} off`);
const heldResult = await held;
check(done && !heldResult.isError && heldResult.text.includes('7'), 'the call goes on after resume');

// Feedback for a Claude Code bridge session: the whole note through the inbox, the image as a file
check((await state()).sessions.find(s => s.id === sa.id).push === true, 'Claude Code bridge session can push feedback (inbox from the environment)');
await control(`select ${sa.id}`);
await sleep(300);
await control(`action ${sa.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 200, "height": 100}, "text": "This heading please"}`);
for (let i = 0; i < 50 && !inboxLines.some(l => l.type === 'user'); i++) await sleep(100);
const note = inboxLines.find(l => l.type === 'user')?.message?.content ?? '';
const notePng = note.match(/(\/\S+feedback-\d+\.png)/)?.[1];
check(/This heading please/.test(note) && /Page: http/.test(note) && notePng && fs.existsSync(notePng), 'feedback reaches Claude Code as a note with the details and the image file', note.slice(0, 160).replace(/\n/g, ' | '));
check(inboxLines.some(l => l.type === 'auth' && l.token === 'tok'), 'inbox message carries the token');

// A second server of another project, below a process named "codex": its own session,
// its thread from the (fake) app-server daemon, tool calls from the daemon's items
const etaDir = project('eta-api');
daemon.thread.cwd = fs.realpathSync(etaDir);
const fakeCodex = path.join(tmp, 'codex');
fs.writeFileSync(fakeCodex, `#!/bin/sh\n${server.join(' ')}\n`, { mode: 0o755 });
const b = new McpClient(fakeCodex, [], { env, cwd: etaDir });
await b.initialize();
await b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/eta` });
let sb = await sessionOf('eta-api', s => s.tabs.length);
check(sb && sb.id !== sa.id && sb.tabs.some(t => t.url.endsWith('/eta')), 'second server gets its own session');
check(sb?.client === 'codex', 'client codex from the process tree', sb?.client);
for (let i = 0; i < 50 && !sb.agentSessionId; i++) { await sleep(100); sb = (await state()).sessions.find(s => s.id === sb.id); }
check(sb.agentSessionId === 'thread-abc' && sb.agentSessionSource === 'codex-app-server', 'Codex thread found in the app-server daemon by cwd', `${sb.agentSessionId} (${sb.agentSessionSource})`);
check(daemon.requests.some(r => r.method === 'thread/resume' && r.params.threadId === 'thread-abc'), 'the app subscribes to the thread');
check(sb.push === true, 'Codex bridge session can push feedback');
const codexActs = sb.activity.length;
notifyDaemon('item/started', { threadId: 'thread-abc', turnId: 't1', item: { id: 'i1', type: 'mcpToolCall', server: 'chrome-devtools', tool: 'take_snapshot', arguments: { pageId: 1 }, status: 'inProgress' } });
await sleep(300);
sb = (await state()).sessions.find(s => s.id === sb.id);
check(sb.currentTool?.tool === 'take_snapshot', 'a tool call of the thread shows while it runs', JSON.stringify(sb.currentTool));
notifyDaemon('item/completed', { threadId: 'thread-abc', turnId: 't1', item: { id: 'i1', type: 'mcpToolCall', server: 'chrome-devtools', tool: 'take_snapshot', arguments: { pageId: 1 }, status: 'completed', durationMs: 321 } });
notifyDaemon('item/started', { threadId: 'thread-abc', turnId: 't1', item: { id: 'i2', type: 'commandExecution', command: 'ls' } });
notifyDaemon('item/completed', { threadId: 'thread-abc', turnId: 't1', item: { id: 'i2', type: 'commandExecution', command: 'ls' } });
notifyDaemon('item/started', { threadId: 'other-thread', turnId: 't9', item: { id: 'i3', type: 'mcpToolCall', server: 'chrome-devtools', tool: 'click', status: 'inProgress' } });
await b.tool('take_screenshot', { pageId: await pageId(b) });
await sleep(1200);
sb = (await state()).sessions.find(s => s.id === sb.id);
const fromDaemon = sb.activity.slice(0, sb.activity.length - codexActs);
check(fromDaemon.length === 1 && fromDaemon[0].tool === 'take_snapshot' && fromDaemon[0].durationMs === 321, 'tool calls come from the daemon only: no shell items, no other threads, no CDP steps', JSON.stringify(fromDaemon.map(x => [x.tool, x.durationMs])));
await control(`select ${sb.id}`);
await sleep(300);
await control(`action ${sb.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 200, "height": 100}, "text": "Make this red"}`);
let steer;
for (let i = 0; i < 50 && !steer; i++) { await sleep(100); steer = daemon.requests.find(r => r.method === 'turn/steer' || r.method === 'turn/start'); }
const steerText = steer?.params?.input?.find(x => x.type === 'text')?.text ?? '';
const steerImage = steer?.params?.input?.find(x => x.type === 'localImage')?.path;
check(steer?.method === 'turn/steer' && steer.params.threadId === 'thread-abc' && steer.params.expectedTurnId === 'turn-1', 'feedback goes to the running Codex turn (turn/steer with its id)', `${steer?.method} ${steer?.params?.expectedTurnId}`);
check(/Make this red/.test(steerText) && !/\.png/.test(steerText) && steerImage && fs.existsSync(steerImage), 'the Codex message has the text and the image as an input', steerText.slice(0, 120).replace(/\n/g, ' | '));
check(!(await b.tool('list_pages')).text.includes('/zeta') && !(await a.tool('list_pages')).text.includes('/eta'), 'each agent sees only its own tabs');

// A Habitab 0.2 configuration (`habitab mcp -- <server>`) still works: the command runs the server unchanged, and the global config gives it its browser
const c = new McpClient(launcher[0], launcher.slice(1), { env, cwd: project('theta-web') });
const initC = await c.initialize();
check(initC.result?.serverInfo?.name, '0.2 wrapper: the server starts through the pass-through');
await c.tool('navigate_page', { pageId: await pageId(c), url: `${base}/theta` });
const sc = await sessionOf('theta-web', s => s.tabs.length);
check(sc && sc.tabs.some(t => t.url.endsWith('/theta')), '0.2 wrapper: the session shows its page');
await c.close();

// Server exit ends the session (and the thread subscription)
await b.close();
let endedB;
for (let i = 0; i < 100 && !endedB; i++) { await sleep(200); endedB = (await state()).sessions.find(s => s.id === sb.id)?.endReason; }
check(!!endedB, 'the session ends with its server', endedB);
await sleep(300);
check(daemon.requests.some(r => r.method === 'thread/unsubscribe' && r.params.threadId === 'thread-abc'), 'the app unsubscribes from the thread');
await a.close();

// Remove the entry
check(/removed/.test(habitab(['cd4a', '--remove'])) && !fs.existsSync(cd4aConfig), 'habitab cd4a --remove deletes the file');

const finalErrors = (await state()).errors;
check(!finalErrors.length, 'no errors reported during the test', finalErrors.join('; '));
check(chromePids().filter(p => !chromesBefore.has(p)).length === 0, 'still no Chrome started');
await control('quit');
await sleep(1500);
app.kill();
page.close();
daemonHttp.close();
inbox.close();
fs.rmSync(env.CODEX_HOME, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
