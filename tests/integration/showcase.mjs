// Opens the current build with a few demo sessions, to look at changes
// before installing them. A separate instance (own HABITAB_HOME and socket):
// the installed app and real agents are not affected.
//   npm run preview                                  until you quit it (⌘Q / Ctrl-C)
//   npm run build && node tests/integration/showcase.mjs [seconds]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { McpClient, sleep } from './mcp-client.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-show-'));
const env = { HABITAB_HOME: path.join(tmp, 'home'), HABITAB_SOCKET: process.env.HABITAB_SOCKET ?? path.join(os.tmpdir(), `hb-show-${process.pid}.sock`), HABITAB_NO_APP_LAUNCH: '1', HABITAB_TEST_CONTROL: '1', HABITAB_TEST_VISIBLE: process.env.HABITAB_TEST_VISIBLE ?? '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' };
const app = spawn(path.join(root, 'node_modules/.bin/electron'), [root], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
const events = [];
readline.createInterface({ input: app.stdout }).on('line', l => { try { events.push(JSON.parse(l)); } catch {} });
while (!events.some(e => e.ready)) await sleep(100);
const control = line => app.stdin.write(line + '\n');

const page = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${req.url === '/' ? 'Shop' : req.url.slice(1)} – Demo</title>
  <style>body{font:16px system-ui;margin:0}header{background:#1f2937;color:#fff;padding:18px 32px;font-weight:600}main{padding:32px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.c{border:1px solid #e5e7eb;border-radius:12px;padding:18px}.c b{display:block;margin-bottom:6px}button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:8px 14px;margin-top:10px}</style>
  <header>Demo Shop ${req.url}</header><main>${[1,2,3,4,5,6].map(i => `<div class=c><b>Product ${i}</b>Description ${i}<br><button>Add to Cart</button></div>`).join('')}</main>`);
});
await new Promise(r => page.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${page.address().port}`;
const launcher = ['node', path.join(root, 'dist/launcher/main.js'), 'mcp', '--', 'npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'];
const mk = async (name, clientName, url, meta) => {
  const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  const c = new McpClient(launcher[0], launcher.slice(1), { env, cwd: d, clientName });
  await c.initialize();
  await c.tool('navigate_page', { pageId: 1, url }, meta);
  return c;
};
const a = await mk('webshop', 'claude-code', `${base}/`, undefined);
// Older tabs: the agent moved on to a new tab and left these open.
await a.tool('new_page', { url: `${base}/cart` });
await a.tool('new_page', { url: `${base}/checkout` });
const b = await mk('api-docs', 'codex-mcp-client', `${base}/docs`, { threadId: '019e1c2a-77aa-7c10-b0f3-1d2e3f4a5b6c' });
const c = await mk('webshop', 'codex-mcp-client', `${base}/admin`, { threadId: '019e1c2b-1234-7c10-b0f3-aaaaaaaaaaaa' });
await sleep(800);
const st = await new Promise(r => { const n = events.length; control('state'); const t = setInterval(() => { const e = events.slice(n).find(x => x.state); if (e) { clearInterval(t); r(e.state); } }, 50); });
const first = st.sessions.find(s => s.client === 'claude');
control(`select ${first.id}`);
console.log('Preview is open. Quit it with ⌘Q (or Ctrl-C here).');

// Runs for the given seconds, or until the app is quit; quitting cuts any waiting short.
let running = true;
const stopped = new Promise(r => { app.on('exit', r); process.on('SIGINT', r); }).then(() => { running = false; });
const seconds = +(process.argv[2] ?? 0);
if (seconds) setTimeout(() => { running = false; }, seconds * 1000);
while (running) {
  await Promise.race([a.tool('take_snapshot', { pageId: 3 }).catch(() => {}), stopped]);
  await Promise.race([sleep(3000), stopped]);
}
await Promise.race([Promise.all([a, b, c].map(x => x.close().catch(() => {}))), sleep(4000)]);
if (app.exitCode === null) { app.kill(); await new Promise(r => app.once('exit', r)); }
page.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(0);
