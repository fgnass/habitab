// Screenshots of the real app with the demo sessions, for the website in site/.
// Usage: npm run build && node scripts/site-screenshots.mjs [outDir]   (default: site/img)
// Starts a visible app with test control and captures its window by id, so the
// window never takes focus. Crops are in device pixels of a Retina window.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { demoSite } from '../tests/integration/demo-site.mjs';
import { McpClient, sleep } from '../tests/integration/mcp-client.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'site/img'));
fs.mkdirSync(outDir, { recursive: true });

const electronBin = createRequire(path.join(root, 'package.json'))('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-shot-'));
const env = {
  HABITAB_HOME: path.join(tmp, 'home'), HABITAB_SOCKET: path.join(os.tmpdir(), `hb-shot-${process.pid}.sock`),
  HABITAB_NO_APP_LAUNCH: '1', HABITAB_TEST_CONTROL: '1', HABITAB_TEST_VISIBLE: '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '', HABITAB_CODEX_COMMAND: '',
};
// Development builds only: Electron warns about the CSP in each page's console.
const appEnv = { ...process.env, ...env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
const app = spawn(electronBin, [root], { env: appEnv, stdio: ['pipe', 'pipe', 'ignore'] });
const events = [];
readline.createInterface({ input: app.stdout }).on('line', l => { try { events.push(JSON.parse(l)); } catch {} });
while (!events.some(e => e.ready)) await sleep(100);
const control = line => app.stdin.write(line + '\n');
const ask = (line, key) => new Promise(r => {
  const n = events.length; control(line);
  const t = setInterval(() => { const e = events.slice(n).find(x => x[key] !== undefined); if (e) { clearInterval(t); r(e[key]); } }, 50);
});

const page = http.createServer(demoSite);
await new Promise(r => page.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${page.address().port}`;
const launcher = ['node', path.join(root, 'dist/launcher/main.js'), 'mcp', '--', 'npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'];
const session = async (name, clientName, url, meta) => {
  const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  const c = new McpClient(launcher[0], launcher.slice(1), { env, cwd: d, clientName });
  await c.initialize();
  await c.tool('navigate_page', { pageId: 1, url }, meta);
  return c;
};

// Claude Code works through the shop up to the broken checkout; Codex reads the API docs.
const a = await session('juice-shop', 'claude-code', `${base}/shop`);
for (const [tool, args] of [
  ['evaluate_script', { pageId: 1, function: '() => { window.scrollTo({ top: 520 }); return scrollY; }' }],
  ['new_page', { url: `${base}/shop/juice/blood-orange` }],
  ['take_snapshot', { pageId: 2 }],
  ['new_page', { url: `${base}/shop/cart` }],
  // The last tab goes the whole way: its timeline shows the steps to the checkout.
  ['new_page', { url: `${base}/shop` }],
  ['evaluate_script', { pageId: 4, function: '() => { window.scrollTo({ top: 520 }); return scrollY; }' }],
  ['navigate_page', { pageId: 4, url: `${base}/shop/juice/carrot-ginger` }],
  ['navigate_page', { pageId: 4, url: `${base}/shop/cart` }],
  ['navigate_page', { pageId: 4, url: `${base}/shop/checkout` }],
  ['list_console_messages', { pageId: 4 }],
]) { await sleep(900); await a.tool(tool, args); }
const b = await session('relay-docs', 'codex-mcp-client', `${base}/docs/messages/send`, { threadId: '019e1c2a-77aa-7c10-b0f3-1d2e3f4a5b6c' });
await sleep(1200);

const st = await ask('state', 'state');
const shop = st.sessions.find(s => s.client === 'claude');
const windowId = String(await ask('windowid', 'windowId')).split(':')[1];
const shot = async (name, wait = 1800) => {
  await sleep(wait);
  const file = path.join(outDir, `${name}.png`);
  execFileSync('screencapture', ['-l', windowId, '-x', '-o', file]);
  console.log('shot', name);
  return file;
};
// sips -c height width --cropOffset y x
const crop = (from, name, [h, w, y, x]) => {
  const file = path.join(outDir, `${name}.png`);
  execFileSync('sips', ['-c', String(h), String(w), '--cropOffset', String(y), String(x), from, '--out', file], { stdio: 'ignore' });
  console.log('crop', name);
};
const tmpShot = name => shot(`raw-${name}`);

control('deselect');
await sleep(1500);
control('deselect');
await shot('start');
control(`select ${shop.id} ${shop.tabs.at(-1).id}`);
crop(await tmpShot('main'), 'sidebar', [1000, 560, 150, 0]);
control(`action ${shop.id} timeline true`);
crop(await tmpShot('timeline'), 'timeline', [172, 2318, 92, 562]);
control(`action ${shop.id} timeline false`);
await sleep(600);
// The error count opens the tab's console: the count in the top bar and the docked console.
control(`action ${shop.id} problems`);
crop(await tmpShot('problems'), 'problems', [576, 1037, 0, 1843]);
control(`devtools ${shop.id}`);
await sleep(600);
control(`devtools ${shop.id}`);
await shot('devtools');
control(`devtools ${shop.id}`);
await sleep(600);
control(`action ${shop.id} responsive`);
crop(await shot('responsive'), 'control', [230, 2318, 0, 562]);
control(`action ${shop.id} responsive`);
await sleep(600);
control(`action ${shop.id} annotate true`);
await shot('annotate');

// KEEP_RAW=1 keeps the uncropped shots (to find new crop rectangles).
if (!process.env.KEEP_RAW) for (const f of fs.readdirSync(outDir)) if (f.startsWith('raw-')) fs.rmSync(path.join(outDir, f));
await Promise.race([Promise.all([a, b].map(x => x.close().catch(() => {}))), sleep(4000)]);
if (app.exitCode === null) { app.kill(); await new Promise(r => app.once('exit', r)); }
page.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(0);
