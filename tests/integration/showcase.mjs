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
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { demoSite } from './demo-site.mjs';
import { McpClient, sleep } from './mcp-client.mjs';

const root = path.resolve(import.meta.dirname, '../..');
// The Electron binary itself: killing the .bin wrapper would leave the app running.
const electronBin = createRequire(import.meta.url)('electron');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-show-'));
const env = { HABITAB_HOME: path.join(tmp, 'home'), HABITAB_SOCKET: process.env.HABITAB_SOCKET ?? path.join(os.tmpdir(), `hb-show-${process.pid}.sock`), HABITAB_NO_APP_LAUNCH: '1', HABITAB_TEST_CONTROL: '1', HABITAB_TEST_VISIBLE: process.env.HABITAB_TEST_VISIBLE ?? '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
  // The preview may run inside a Claude Code session: its inbox must never get demo feedback.
  CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '', HABITAB_CODEX_COMMAND: '' };
const app = spawn(electronBin, [root], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
const events = [];
readline.createInterface({ input: app.stdout }).on('line', l => { try { events.push(JSON.parse(l)); } catch {} });
while (!events.some(e => e.ready)) await sleep(100);
const control = line => app.stdin.write(line + '\n');

// Demo projects that look real (see demo-site.mjs): a coffee shop, its admin, API docs.
const page = http.createServer(demoSite);
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
// A short, realistic run per agent, so the sidebar and the timeline show real work.
// Real agents think between tool calls; the pauses also give each step its own screenshot.
const think = () => sleep(900);
const a = await mk('ember-oak-shop', 'claude-code', `${base}/shop`, undefined);
for (const [tool, args] of [
  ['evaluate_script', { pageId: 1, function: '() => { window.scrollTo({ top: 520 }); return scrollY; }' }],
  ['new_page', { url: `${base}/shop/coffee/ethiopia-guji` }],
  ['take_snapshot', { pageId: 2 }],
  ['new_page', { url: `${base}/shop/cart` }],
  ['new_page', { url: `${base}/shop/checkout` }],
  ['list_console_messages', { pageId: 4 }],
]) { await think(); await a.tool(tool, args); }
const b = await mk('relay-docs', 'codex-mcp-client', `${base}/docs/messages/send`, { threadId: '019e1c2a-77aa-7c10-b0f3-1d2e3f4a5b6c' });
const c = await mk('ember-oak-shop', 'codex-mcp-client', `${base}/admin`, { threadId: '019e1c2b-1234-7c10-b0f3-aaaaaaaaaaaa' });
await sleep(800);
const st = await new Promise(r => { const n = events.length; control('state'); const t = setInterval(() => { const e = events.slice(n).find(x => x.state); if (e) { clearInterval(t); r(e.state); } }, 50); });
const first = st.sessions.find(s => s.client === 'claude');
control(`select ${first.id} ${first.tabs[0].id}`);
console.log('Preview is open. Quit it with ⌘Q (or Ctrl-C here).');

// Runs for the given seconds, or until the app is quit; quitting cuts any waiting short.
let running = true;
const stopped = new Promise(r => { app.on('exit', r); process.on('SIGINT', r); process.on('SIGTERM', r); }).then(() => { running = false; });
const seconds = +(process.argv[2] ?? 0);
if (seconds) setTimeout(() => { running = false; }, seconds * 1000);
while (running) await Promise.race([sleep(1000), stopped]);
await Promise.race([Promise.all([a, b, c].map(x => x.close().catch(() => {}))), sleep(4000)]);
if (app.exitCode === null) { app.kill(); await new Promise(r => app.once('exit', r)); }
page.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(0);
