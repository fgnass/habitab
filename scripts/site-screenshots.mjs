// Screenshots of the real app with the demo sessions, for the website in site/.
// Usage: npm run build && node scripts/site-screenshots.mjs [outDir]   (default: site/img)
// Starts a visible app with test control and captures its window by id, so the
// window never takes focus. Crops are in device pixels of a Retina window.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { demoSite } from '../tests/integration/demo-site.mjs';
import { bridgeEnv, fakeClient } from '../tests/integration/bridge-env.mjs';
import { McpClient, sleep } from '../tests/integration/mcp-client.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'site/img'));
fs.mkdirSync(outDir, { recursive: true });

const electronBin = createRequire(path.join(root, 'package.json'))('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-shot-'));
const env = bridgeEnv(tmp, { HABITAB_TEST_VISIBLE: '1' });
// The same dictation language on every Mac (the default follows the system's languages).
fs.mkdirSync(env.HABITAB_HOME, { recursive: true });
fs.writeFileSync(path.join(env.HABITAB_HOME, 'ui.json'), JSON.stringify({ dictationLanguage: 'en-US' }));
// A stand-in for Claude Code's inbox socket: the shop session has a channel for feedback.
const inboxPath = path.join(tmp, 'inbox.sock');
const inbox = net.createServer(sock => sock.resume());
await new Promise(r => inbox.listen(inboxPath, r));
const claudeEnv = { ...env, CLAUDE_CODE_MESSAGING_SOCKET: inboxPath, CLAUDE_CODE_MESSAGING_TOKEN: 'shot' };
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
// The server below a script named like the client; the bridge finds the client in the process tree.
const session = async (name, kind, url) => {
  const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  const c = new McpClient(fakeClient(env, kind), [], { env: kind === 'claude' ? claudeEnv : env, cwd: d });
  await c.initialize();
  await c.tool('navigate_page', { pageId: 1, url });
  return c;
};

// Claude Code works through the shop up to the broken checkout; Codex reads the API docs.
const a = await session('juice-shop', 'claude', `${base}/shop`);
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
const b = await session('relay-docs', 'codex', `${base}/docs/messages/send`);
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

// The count's context menu (see problemsMenu in main.ts), drawn like a macOS menu.
const MENU = `(() => {
  const m = document.createElement("div"); m.id = "hb-menu";
  m.style.cssText = "position:fixed;z-index:99999;left:" + (innerWidth - 249) + "px;top:2px;width:236px;padding:5px;border-radius:10px;background:rgba(242,242,242,.97);box-shadow:0 0 0 .5px rgba(0,0,0,.22),0 10px 30px rgba(0,0,0,.22);font:13px -apple-system,system-ui;color:#1d1d1f";
  const item = (t, on) => '<div style="padding:3px 10px;border-radius:5px;' + (on ? 'background:#0a7aff;color:#fff' : '') + '">' + t + '</div>';
  m.innerHTML = item("Send 3 Console Errors to Agent", true) + item("Open Console") + '<div style="height:1px;margin:5px 10px;background:rgba(0,0,0,.12)"></div>' + item("Clear");
  document.body.append(m); return "ok";
})()`.replace(/\n\s*/g, ' ');
// Page coordinates of the deposit line in the order box, and the note about it.
const DEPOSIT = { x: 827, y: 486 };
const NOTE = 'Show the deposit next to each bottle, not only here. People think it is a fee.';
// The hero on phones: the order box with the note, readable at a small width.
const HERO_MOBILE_CROP = [1230, 940, 470, 1940];

control('deselect');
await sleep(1500);
control('deselect');
control(`select ${shop.id} ${shop.tabs.at(-1).id}`);
crop(await tmpShot('main'), 'sidebar', [1000, 560, 150, 0]);
control(`action ${shop.id} timeline true`);
crop(await tmpShot('timeline'), 'timeline', [172, 2318, 92, 562]);
control(`action ${shop.id} timeline false`);
await sleep(600);
// Both shots below need the error count in the top bar: it hides while the
// DevTools are open, and opening the console marks the errors as seen.
// You have control: the count in the top bar, and the button for an own tab.
// A click in the page (synthetic, the real pointer stays) gives the user control of this tab.
control(`userclick ${shop.id}`);
crop(await tmpShot('control'), 'control', [150, 2318, 0, 562]);
control(`hold ${shop.id} off`);
await sleep(600);
// A native menu is a window of its own that `screencapture -l` does not see, and
// opening one would take the user's pointer. So the shot shows a copy of the count's
// context menu (same items), drawn into the page right below the count.
const content = await ask('bounds', 'bounds');
const topbar = await ask('bounds topbar', 'bounds');
const pageView = await ask('bounds page', 'bounds');
const count = await ask('ui topbar (() => { const r = document.getElementById("problems").getBoundingClientRect(); return { x: r.x, w: r.width }; })()', 'result');
const menuX = Math.round(topbar.x + count.x - pageView.x);
control(`ui page ${MENU.replace('(innerWidth - 249)', String(menuX))}`);
const PROBLEMS_W = 1037;
crop(await tmpShot('problems'), 'problems', [(pageView.y + 150) * 2, PROBLEMS_W, 0, content.width * 2 - PROBLEMS_W]);
control('ui page document.getElementById("hb-menu")?.remove()');
// Still a browser: the phone preset of responsive mode, DevTools docked beside it.
control(`devtools ${shop.id}`);
control(`action ${shop.id} responsive`);
await sleep(600);
control(`action ${shop.id} emulate {"preset":"responsive","width":390,"fillHeight":true}`);
await sleep(600);
// Opening the DevTools and responsive mode counts as input; this shot is not about control.
control(`hold ${shop.id} off`);
await shot('browser', 2500);
control(`devtools ${shop.id}`);
control(`action ${shop.id} responsive`);
await sleep(600);
// Marking: the element comes marked (like "Send Element to Agent…"), a note is written.
control(`sendelement ${shop.id} ${DEPOSIT.x} ${DEPOSIT.y}`);
await sleep(800);
control(`ui annotator document.getElementById("text").value = ${JSON.stringify(NOTE)}`);
// The whole window while marking is the hero: sessions on the left, the note on the page.
const hero = await shot('hero');
crop(hero, 'hero-mobile', HERO_MOBILE_CROP);

// KEEP_RAW=1 keeps the uncropped shots (to find new crop rectangles).
if (!process.env.KEEP_RAW) for (const f of fs.readdirSync(outDir)) if (f.startsWith('raw-')) fs.rmSync(path.join(outDir, f));
await Promise.race([Promise.all([a, b].map(x => x.close().catch(() => {}))), sleep(4000)]);
if (app.exitCode === null) { app.kill(); await new Promise(r => app.once('exit', r)); }
inbox.close();
page.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(0);
