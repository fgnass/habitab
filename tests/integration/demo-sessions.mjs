// Starts sessions through the browser bridge and keeps them alive, for manual
// UI checks. Needs a global config that names the browser script (see
// bridgeEnv in bridge-env.mjs). Writes the client pids to stdout.
//
//   HABITAB_HOME=... HABITAB_SOCKET=... node tests/integration/demo-sessions.mjs [seconds]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bridgeEnv, fakeClient } from './bridge-env.mjs';
import { McpClient, sleep } from './mcp-client.mjs';

const seconds = +(process.argv[2] ?? 600);
const env = bridgeEnv(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-demo'));

const page = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Habitab Demo ${req.url}</title>
  <style>body{font:16px system-ui;margin:40px} input,textarea{font-size:16px;padding:6px;width:320px}</style>
  <h1>Demo ${req.url}</h1><p id=c></p>
  <input id=q placeholder="Type…"><br><br><textarea id=t rows=3>Selectable text</textarea>
  <p><button id=b onclick="document.getElementById('c').textContent='Click '+(++window.n||(window.n=1))">Click me</button></p>
  <div style="height:2000px;background:linear-gradient(#fff,#cde)">Scroll area</div>
  <script>document.getElementById('c').textContent='cookie: '+document.cookie</script>`);
});
await new Promise(r => page.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${page.address().port}`;

const projects = ['alpha-shop', 'beta-api'].map(n => {
  const dir = path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-demo', n);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
});

const sessions = [
  { name: 'claude', cwd: projects[0], url: `${base}/shop` },
  { name: 'codex', cwd: projects[1], url: `${base}/api-docs` },
];
const clients = [];
for (const s of sessions) {
  const c = new McpClient(fakeClient(env, s.name), [], { cwd: s.cwd, env });
  await c.initialize();
  const r = await c.tool('navigate_page', { pageId: 1, url: s.url });
  await c.tool('evaluate_script', { pageId: 1, function: `() => { document.cookie = "who=${s.name}"; return 1 }` });
  console.log(JSON.stringify({ client: c.proc.pid, kind: s.name, ok: !r.isError }));
  clients.push({ c, s });
}
// Keep some agent activity going.
const end = Date.now() + seconds * 1000;
let i = 0;
while (Date.now() < end) {
  await sleep(4000);
  const { c, s } = clients[i++ % clients.length];
  await c.tool('take_snapshot', { pageId: 1 }).catch(() => {});
}
for (const { c } of clients) await c.close();
page.close();
