// End-to-end test: Habitab app + unchanged chrome-devtools-mcp, which starts
// the browser bridge through the server's global config (bridge-env.mjs).
// Shell scripts named "claude" stand in for the clients; a fake Claude Code
// inbox socket receives the feedback notes.
//   npm run build && node tests/integration/app.mjs
// Uses its own HABITAB_HOME, socket and server config; a real installation is not touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { bridgeEnv, fakeClient } from './bridge-env.mjs';
import { McpClient, sleep, check } from './mcp-client.mjs';

const root = path.resolve(import.meta.dirname, '../..');
// The Electron binary itself: killing the .bin wrapper would leave the app running.
const electronBin = createRequire(import.meta.url)('electron');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-app-'));
const env = bridgeEnv(tmp, {
  ...(process.env.HABITAB_TEST_VISIBLE ? { HABITAB_TEST_VISIBLE: process.env.HABITAB_TEST_VISIBLE } : {}),
  HABITAB_AUTO_RESUME_MS: '2500',
});
// Fake Claude Code inbox socket (cross-session messaging): feedback notes arrive here.
const inboxPath = path.join(tmp, 'inbox.sock');
const inboxLines = [];
const inbox = net.createServer(sock => {
  let buf = '';
  sock.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { try { inboxLines.push(JSON.parse(buf.slice(0, i))); } catch {} buf = buf.slice(i + 1); } });
});
await new Promise(r => inbox.listen(inboxPath, r));
const claudeEnv = { ...env, CLAUDE_CODE_MESSAGING_SOCKET: inboxPath, CLAUDE_CODE_MESSAGING_TOKEN: 'test-token' };
/**
 * The next feedback note in the inbox, in the shape of the old tool result
 * (text, and the image file as an image content). Call it before the action.
 */
const nextNote = () => {
  const n = inboxLines.filter(l => l.type === 'user').length;
  return (async () => {
    for (let i = 0; i < 100; i++) {
      const notes = inboxLines.filter(l => l.type === 'user');
      if (notes.length > n) {
        const text = notes[n].message.content;
        const png = text.match(/(\/\S+\.png)/)?.[1];
        const content = [{ type: 'text', text }];
        if (png && fs.existsSync(png)) content.push({ type: 'image', data: fs.readFileSync(png).toString('base64') });
        return { text, raw: { result: { content } }, isError: false };
      }
      await sleep(100);
    }
    return { text: 'NO NOTE', raw: { result: { content: [] } }, isError: true };
  })();
};
// Real agents think between tool calls; steps come from the CDP commands, and calls without a pause join into one.
const pause = () => sleep(900);
// Chrome processes (a Chrome that chrome-devtools-mcp would start); pgrep fails when there is none.
const chromePids = () => {
  // Linux: the executable only (Habitab's own profiles live in a "chromium" folder).
  const pattern = process.platform === 'darwin' ? 'Google Chrome.app/Contents/MacOS/Google Chrome' : '^[^ ]*(google-chrome|/chrome/chrome|chromium)( |$)';
  try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
};
const chromesBefore = new Set(chromePids());

// --- app with test control channel
let app, events = [];
function startApp() {
  events = [];
  app = spawn(electronBin, [root], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  // About 80 % of a core, like a busy audio app.
  if (req.url === '/busy') return res.end('<title>Busy</title><script>setInterval(() => { const end = performance.now() + 80; while (performance.now() < end); }, 100)</script>');
  if (req.url === '/api/fail') { res.statusCode = 500; return res.end('fail'); }
  // A page with problems: a console error (twice), an uncaught exception and a failed request.
  if (req.url === '/broken') return res.end(`<title>Broken</title><h1 id=h>Broken</h1><script>
    console.error('Oops ' + 'twice'); console.error('Oops ' + 'twice'); fetch('/api/fail');
    setTimeout(() => { throw new Error('Boom'); });</script>`);
  // Web Speech: go() starts a recognition and logs its events (results as index:transcripts, final ones with "!").
  if (req.url === '/speech') return res.end(`<title>Speech</title><script>window.early = typeof webkitSpeechRecognition; window.log = [];
    window.go = opts => { const r = new SpeechRecognition(); Object.assign(r, opts); window.rec = r; log.length = 0;
      for (const t of ['start', 'audiostart', 'soundstart', 'speechstart', 'result', 'nomatch', 'speechend', 'soundend', 'audioend', 'error', 'end'])
        r.addEventListener(t, e => log.push(t + (t === 'result' ? ':' + e.resultIndex + ':' + [...e.results].map(x => (x.isFinal ? '!' : '') + x[0].transcript).join('/') : t === 'error' ? ':' + e.error : '')));
      r.onend = () => log.push('onend'); r.start(); };</script>`);
  // Web Share: a full-page button shares title, text, a relative URL and a file; the result lands in window.r.
  if (req.url === '/share') return res.end(`<title>Share</title><script>window.early = typeof navigator.share</script>
    <button style="position:fixed;inset:0" onclick="navigator.share({ title: 'T', text: 'Hello', url: '/x', files: [new File(['hi'], 'a.txt', { type: 'text/plain' })] }).then(() => window.r = 'resolved', e => window.r = e.name)">Share</button>`);
  // A full-page link that opens a new tab.
  if (req.url === '/blank-link') return res.end('<title>Blank link</title><a target=_blank href="/opened" style="position:fixed;inset:0">Open</a>');
  if (req.url === '/headers') return res.end(`sent-ua=${req.headers['user-agent']} | sent-ch=${req.headers['sec-ch-ua']}`);
  res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>
    <button id=p onclick="window.open('/popup','_blank')">Popup</button>
    <a href="/linked">Link</a>
    <script>if (location.pathname === '/popup') document.title = 'Popup opener=' + (window.opener ? 'yes' : 'no');</script>`);
});
await new Promise(r => page.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${page.address().port}`;

const project = name => { const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
// A session: the server below a script named like the client, in its own process group.
const client = (name, kind = 'claude') => {
  const c = new McpClient(fakeClient(env, kind), [], { env: kind === 'claude' ? claudeEnv : env, cwd: project(name), detached: true });
  c.project = name;
  return c;
};
const pageId = async c => +((await c.tool('list_pages')).text.match(/^(\d+):.*\[selected\]/m)?.[1] ?? 1);

startApp();
const ready = await waitFor(e => e.ready);
check(!!ready, 'app starts', `Chromium ${ready?.chrome}`);
const a = client('alpha-shop'), b = client('beta-api');
const [initA] = await Promise.all([a.initialize(), b.initialize()]);
check(initA.result?.serverInfo?.name, 'the servers start unchanged, without a launcher', `${initA.result?.serverInfo?.name} ${initA.result?.serverInfo?.version}`);
// The server starts its browser (and with it the bridge, which registers the session) with the first tool call.
check((await state()).sessions.length === 0, 'lazy: no session before the first tool call');
await Promise.all([a.tool('navigate_page', { pageId: await pageId(a), url: `${base}/alpha` }), b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/beta` })]);
let sa = await sessionOf(a), sb = await sessionOf(b);
check(sa && sb && sa.id !== sb.id, 'two sessions registered');
check(sa.client === 'claude' && sb.client === 'claude', 'client from the process tree', `${sa.client}/${sb.client}`);
check(sa.browser && sa.tabs.some(t => t.url.endsWith('/alpha')), 'session A shows its page in the app');
const la = (await a.tool('list_pages')).text, lb = (await b.tool('list_pages')).text;
check(!la.includes('/beta') && !lb.includes('/alpha'), 'each agent sees only its own tabs');
const pa = await pageId(a), pb = await pageId(b);
const agentStart = Date.now();
await a.tool('evaluate_script', { pageId: pa, function: '() => { document.cookie = "who=a"; localStorage.setItem("who","a"); return 1 }' });
const iso = await b.tool('evaluate_script', { pageId: pb, function: '() => JSON.stringify({c: document.cookie, l: localStorage.getItem("who")})' });
check(iso.text.includes('\\"c\\":\\"\\"') && iso.text.includes('\\"l\\":null'), 'cookies and storage separated');
// Pages see a Chrome, not an Electron: reduced UA version, client hints with "Google Chrome"
{ const t = (await a.tool('evaluate_script', { pageId: pa, function: `async () => 'ua=' + navigator.userAgent + ' | brands=' + (navigator.userAgentData?.brands ?? []).map(b => b.brand).join(',') + ' | ' + await fetch('/headers').then(r => r.text())` })).text;
  check(/ua=[^|]*Chrome\/\d+\.0\.0\.0 Safari[^|]* \| brands=[^|]*Google Chrome/.test(t) && !/Electron|habitab/i.test(t), 'pages see a Chrome user agent and matching client hints', t.slice(0, 300));
  check(/sent-ua=[^|]*Chrome\/\d+\.0\.0\.0 Safari[^|]* \| sent-ch=[^|]*Google Chrome/.test(t), 'requests carry Chrome client hint headers', t.slice(0, 300)); }
// Muting a session silences its tabs (the flag shows in the sidebar; new tabs follow it)
await control(`action ${sa.id} mute true`);
check((await state()).sessions.find(s => s.id === sa.id).muted === true, 'session muted');
await control(`action ${sa.id} mute false`);
check((await state()).sessions.find(s => s.id === sa.id).muted === false, 'session unmuted');

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

// Status bubble: the hovered link's URL (of that tab; the user sees it on the active tab)
const alphaTab = async () => (await state()).sessions.find(s => s.id === sa.id).tabs.find(t => t.url.endsWith('/alpha'));
await a.tool('hover', { pageId: pa2, uid: (await a.tool('take_snapshot', { pageId: pa2 })).text.match(/uid=(\S+) link "Link"/)?.[1] });
for (let i = 0; i < 30 && (await alphaTab()).targetUrl !== `${base}/linked`; i++) await sleep(100);
check((await alphaTab()).targetUrl === `${base}/linked`, 'hovered link shows in the status bubble', (await alphaTab()).targetUrl);
await a.tool('hover', { pageId: pa2, uid: (await a.tool('take_snapshot', { pageId: pa2 })).text.match(/uid=(\S+) heading/)?.[1] });
await sleep(300);
check(!(await alphaTab()).targetUrl, 'status bubble clears when the pointer leaves the link');

// Responsive mode: the user's emulation reaches the page; the agent's own shows in the bar
// DevTools docked while the agent works
await control(`devtools ${sa.id}`);
await sleep(1200);
const dt = await Promise.all([a.tool('take_snapshot', { pageId: pa2 }), a.tool('evaluate_script', { pageId: pa2, function: '() => 1' })]);
check(dt.every(r => !r.isError) && !(await a.tool('list_pages')).text.includes('devtools://'), 'agent works with DevTools docked; DevTools hidden from agent');
check((await state()).sessions.find(s => s.id === sa.id).devtools, 'DevTools shown in the app');

// The user closes the tab (Cmd+W) that has DevTools docked (regression: crashed the app in layout)
await control(`devtools ${sa.id}`);
await a.tool('new_page', { url: `${base}/third` });
const third = +((await a.tool('list_pages')).text.match(/^(\d+):.*\/third/m)?.[1]);
await a.tool('select_page', { pageId: third });
await control(`devtools ${sa.id}`);
await sleep(800);
const before = await state();
check(before.selected === sa.id && before.sessions.find(s => s.id === sa.id).devtools, 'DevTools docked on the new tab of the selected session', before.selected);
await control(`closetab ${sa.id}`);
await sleep(800);
const afterCloseState = await state();
const afterClose = afterCloseState.sessions.find(s => s.id === sa.id);
check(afterClose && !afterClose.devtools && !afterClose.tabs.some(t => t.url.endsWith('/third')) && !afterCloseState.errors.length, 'DevTools closed with the tab, no error reported', afterCloseState.errors.join('; '));
check((await a.tool('evaluate_script', { pageId: pa2, function: '() => 2' })).text.includes('2'), 'agent continues on the remaining tab');
await a.tool('select_page', { pageId: pa2 });

// Human control: tool calls wait
await control(`hold ${sb.id} on`);
await sleep(300);
// The MCP server's own answers to page events (here a navigation by the user) are not the agent waiting
await control(`select ${sb.id}`);
await control(`ui page location.reload()`);
await sleep(1500);
check(!(await state()).sessions.find(s => s.id === sb.id).waiting, "the MCP server's own commands after a user's navigation do not count as waiting");
let done = false;
const held = b.tool('evaluate_script', { pageId: pb, function: '() => 42' }).then(r => { done = true; return r; });
await sleep(2000);
check(!done, 'tool call waits while the human has control');
check((await state()).sessions.find(s => s.id === sb.id).waiting, 'the app knows that the agent waits for the user');
await control(`hold ${sb.id} off`);
check((await held).text.includes('42') && done, 'tool call continues after release');
await sleep(200);
check(!(await state()).sessions.find(s => s.id === sb.id).waiting, 'after release the agent no longer waits');

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

// Coming back with Cmd+Tab sends keys to the page: only a click before them gives control
await control('blur');
await control(`userkey ${sb.id}`);
await sleep(300);
check(!(await state()).sessions.find(s => s.id === sb.id).held, 'a key press without a click after app switch does not take control');
await control(`userclick ${sb.id}`);
await sleep(300);
await control(`hold ${sb.id} off`);
await sleep(600);
await control(`userkey ${sb.id}`);
await sleep(300);
check((await state()).sessions.find(s => s.id === sb.id).held, 'a key press after a click takes control');
await control(`hold ${sb.id} off`);

// A user's click on a target=_blank link: the new tab loads although the agent waits
await b.tool('navigate_page', { pageId: pb, url: `${base}/blank-link` });
await control(`userclick ${sb.id} 20 20`);
await sleep(1000);
const opened = (await state()).sessions.find(s => s.id === sb.id);
check(opened.held && opened.tabs.find(t => t.active)?.url.endsWith('/opened'), 'a link the user opens in a new tab loads while the agent waits', JSON.stringify({ held: opened.held, tabs: opened.tabs.map(t => t.url) }));
await control(`closetab ${sb.id}`);
await control(`hold ${sb.id} off`);
await b.tool('navigate_page', { pageId: pb, url: `${base}/beta` });

// Own tab: the user goes on in a copy of the page, the agent in its tab
const agentPage = await pageId(b);
await control(`userclick ${sb.id}`);
await sleep(300);
const agentUrl = (await state()).sessions.find(s => s.id === sb.id).nav.url;
await control(`action ${sb.id} fork`);
await sleep(800);
const forked = (await state()).sessions.find(s => s.id === sb.id);
const ownTab = forked.tabs.find(t => t.active);
check(!forked.held && ownTab?.own && ownTab.url === agentUrl && forked.tabs.length >= 2, 'own tab opens the same page in front and lets the agent go on', JSON.stringify({ held: forked.held, own: ownTab?.own, url: ownTab?.url }));
await control(`userclick ${sb.id}`);
await sleep(300);
check(!(await state()).sessions.find(s => s.id === sb.id).held, 'a click in the own tab does not hold the agent');
let ownDone = false;
const ownCall = b.tool('evaluate_script', { pageId: agentPage, function: '() => 44' }).then(r => { ownDone = true; return r; });
await sleep(1000);
check(ownDone && (await ownCall).text.includes('44') && await pageId(b) === agentPage, 'agent works on in its own page, its selection stays');
await control(`closetab ${sb.id}`);
await sleep(500);

// Feedback: the agent gets a note with the details and the image file (Claude Code inbox); also while held
check((await state()).sessions.find(s => s.id === sb.id).push === true, 'feedback can be pushed to the session (inbox socket from the environment)');
await control(`hold ${sb.id} on`);
const asked = nextNote();
await control(`action ${sb.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 300, "height": 120}, "text": "This heading please"}`);
const answer = await asked;
check(answer.text.includes('This heading please') && /Marked: h1 "\/beta"/.test(answer.text) && answer.raw.result.content.some(c => c.type === 'image' && c.data.length > 100),
  'the note has the comment, the elements and the area as an image file', answer.text.replace(/\n/g, ' | ').slice(0, 200));
check(inboxLines[0]?.type === 'auth' && inboxLines[0].token === 'test-token', 'inbox: the message authenticates with the session token');
await control(`hold ${sb.id} off`);
check(!(await state()).clipboard?.includes('This heading'), 'nothing is copied to the clipboard when the note was delivered');

// Problems: console errors per tab (failed requests as the console reports them), sent to the agent like feedback
await b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/broken` });
let tb;
for (let i = 0; i < 30; i++) { await sleep(100); tb = (await state()).sessions.find(s => s.id === sb.id); if (tb.nav?.problems?.length >= 3) break; }
const probs = tb.nav?.problems ?? [];
check(probs.length === 3 && probs.find(p => p.text.includes('Oops twice'))?.count === 2 && probs.some(p => p.text.includes('Boom')) && probs.some(p => /500/.test(p.text) && p.source?.includes('/api/fail')),
  'problems: console errors (repeats counted), uncaught exceptions and failed requests as the console reports them', JSON.stringify(probs.map(p => [p.text.slice(0, 40), p.source, p.count])));
check(tb.nav?.newProblems === 3, 'problems: the front tab has an error count for the bar');
const askedP = nextNote();
await control(`action ${sb.id} problemsSend [${probs.find(p => p.text.includes('Boom')).id}]`);
const answerP = await askedP;
check(answerP.text.includes('Console error') && answerP.text.includes('Boom') && answerP.text.includes('not from the user') && !answerP.text.includes('Oops'),
  'problems: a single error goes to the agent', answerP.text.replace(/\n/g, ' | ').slice(0, 200));
const allP = nextNote();
await control(`action ${sb.id} problemsSend`);
const queuedP = await allP;
check(queuedP.text.includes('3 console errors') && queuedP.text.includes('(2×)') && queuedP.text.includes('Boom'), 'problems: "Send All" goes to the agent as one note', queuedP.text.replace(/\n/g, ' | ').slice(0, 200));

// Find in page: the query shows in the bar; matches are counted on a focused page
await control(`select ${sb.id}`);
await control(`action ${sb.id} findText {"text": "Broken", "forward": true}`);
let found;
for (let i = 0; i < 30 && !found; i++) { await sleep(100); found = (await state()).sessions.find(s => s.id === sb.id).nav?.find; }
check((await state()).findText === 'Broken', 'find in page: the query shows in the find bar');
// The count only comes back when the window is frontmost (findInPage needs a focused page); assert it only then.
if (process.env.HABITAB_TEST_VISIBLE === '1' && found) check(found.matches === 1 && found.active === 1, 'find in page: matches are counted', JSON.stringify(found));
await control(`action ${sb.id} findClose`);
await sleep(200);
check((await state()).findText === null && !(await state()).sessions.find(s => s.id === sb.id).nav?.find, 'find in page: closing clears the search');

// The error badge opens the DevTools console; "Send to Agent…" in the DevTools context menu sends the selection
const uiEval = async (view, js) => { const n = events.length; app.stdin.write(`ui ${view} ${js}\n`); for (let i = 0; i < 50; i++) { await sleep(100); const e = events.slice(n).find(x => x.ui === view); if (e) return e; } };
await control(`select ${sb.id}`);
await control(`action ${sb.id} problems`);
let hooked;
for (let i = 0; i < 50 && hooked !== 'hooked'; i++) { await sleep(200); hooked = (await uiEval('devtools', 'globalThis.__habitab ? "hooked" : "no"'))?.result; }
let consoleShown;
for (let i = 0; i < 30 && consoleShown !== true; i++) { consoleShown = (await uiEval('devtools', '!!document.querySelector(".console-view")'))?.result; if (consoleShown !== true) await sleep(100); }
check((await state()).sessions.find(s => s.id === sb.id).devtools && hooked === 'hooked' && consoleShown === true,
  'error badge opens the DevTools on the Console panel, with the Send-to-Agent hook installed', JSON.stringify({ hooked, consoleShown }));
const askedD = nextNote();
// The frontend reports the chosen item as a console line (the native menu itself cannot be clicked here).
await uiEval('devtools', 'console.log("HABITAB_SEND " + JSON.stringify({ text: "Uncaught Error: Boom (from the console)" }))');
const answerD = await askedD;
check(answerD.text.includes('from the DevTools') && answerD.text.includes('Boom (from the console)') && answerD.text.includes('/broken'),
  'a DevTools selection goes to the agent with the page URL', answerD.text.replace(/\n/g, ' | ').slice(0, 200));
// Without a selection, the item sends the console message under the pointer (the native menu is not shown in tests)
const askedM = nextNote();
const rightClicked = (await uiEval('devtools', `(() => {
  const all = (root, out = []) => { for (const e of root.querySelectorAll('*')) { if (e.classList.contains('console-message-wrapper')) out.push(e); if (e.shadowRoot) all(e.shadowRoot, out); } return out; };
  const m = all(document).find(e => e.classList.contains('console-error-level'));
  if (!m) return null;
  getSelection().removeAllRanges();
  const stop = e => e.stopPropagation();
  addEventListener('contextmenu', stop, true);
  m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
  removeEventListener('contextmenu', stop, true);
  DevToolsAPI.contextMenuItemSelected(990);
  return m.querySelector('.console-message-text').innerText;
})()`.replace(/\n\s*/g, ' ')))?.result;
const answerM = await askedM;
check(rightClicked && answerM.text.includes('from the DevTools') && answerM.text.includes(rightClicked) && answerM.text.includes('/broken'),
  'without a selection, the right-clicked console message goes to the agent', answerM.text.replace(/\n/g, ' | ').slice(0, 200));
// Camera/microphone: without a stored answer the user is asked; tests show no sheet, so the request is denied at once
const gum = await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", e => e.name)' });
// A machine without a camera (e.g. a VM) gets NotFoundError before anything asks.
check(gum.text.includes('NotAllowedError') || gum.text.includes('NotFoundError'), 'camera: a request without an answer is denied in tests (no sheet, no hang)', gum.text.replace(/\n/g, ' | ').slice(0, 160));

// Reading the clipboard asks the user like camera access; tests show no sheet, so it is denied at once
const clip = await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => navigator.permissions.query({ name: "clipboard-read" }).then(s => s.state)' });
check(clip.text.includes('"prompt"') || clip.text.includes('"denied"'), 'clipboard: reading is not granted without an answer', clip.text.replace(/\n/g, ' | ').slice(0, 160));

// Clearing the console (here the page calls console.clear()) drops the error badge too
// (The DevTools are open here, so the badge itself shows nothing: see below.)
check((await state()).sessions.find(s => s.id === sb.id).nav.problems.length === 3, 'problems: 3 errors before the console is cleared');
await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => { console.clear(); return 1; }' });
let cleared = false;
for (let i = 0; i < 40 && !cleared; i++) { await sleep(100); cleared = (await state()).sessions.find(s => s.id === sb.id).nav.problems.length === 0; }
check(cleared, 'problems: clearing the console drops the errors');
await control(`devtools ${sb.id}`);
// Web Speech API: Electron has the interface, but no recognizer (start() fails with "network"); Habitab recognizes
// speech on this computer (macOS). Tests use a fake recognizer: the results come from the test control.
if (process.platform === 'darwin') {
  await b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/speech` });
  const pid = await pageId(b);
  const logOf = async () => { const t = (await b.tool('evaluate_script', { pageId: pid, function: '() => log.join(" ")' })).text; try { return JSON.parse(t.match(/```json\s*([\s\S]*?)```/)?.[1] ?? t); } catch { return t; } };
  const until = async (what, ms = 5000) => { const end = Date.now() + ms; let l = ''; while (Date.now() < end) { l = await logOf(); if (l.includes(what)) return l; await sleep(100); } return l; };
  const detect = await b.tool('evaluate_script', { pageId: pid, function: '() => SpeechRecognition.available({ langs: ["en-US"], processLocally: true }).then(a => [window.early, SpeechRecognition === webkitSpeechRecognition, a].join(","))' });
  check(detect.text.includes('function,true,available'), 'web speech: SpeechRecognition exists before page scripts; recognition is available on this computer', detect.text.replace(/\n/g, ' | ').slice(0, 120));
  // Without microphone access for the origin the page gets "not-allowed" (tests show no sheet).
  await b.tool('evaluate_script', { pageId: pid, function: '() => go({})' });
  let l = await until('end');
  check(l === 'start error:not-allowed end onend', 'web speech: without microphone access the recognition ends with "not-allowed"', l);
  await control(`access ${sb.id} media ${base} allow`);
  // Interim results, one final result ends a non-continuous recognition.
  await b.tool('evaluate_script', { pageId: pid, function: '() => go({ interimResults: true })' });
  await until('audiostart');
  await control('speech interim hello');
  await control('speech final hello world');
  l = await until('onend');
  check(l === 'start audiostart soundstart speechstart result:0:hello result:0:!hello world speechend soundend audioend end onend',
    'web speech: events of the spec in order, interim then final result; the recognition ends after a final result', l);
  // Continuous: final results add up, interim ones stay out without interimResults; abort() reports "aborted".
  await b.tool('evaluate_script', { pageId: pid, function: '() => go({ continuous: true })' });
  await until('audiostart');
  await control('speech final one');
  await control('speech interim tw');
  await control('speech final two');
  await until('result:1');
  await b.tool('evaluate_script', { pageId: pid, function: '() => rec.abort()' });
  l = await until('onend');
  check(l === 'start audiostart soundstart speechstart result:0:!one result:1:!one/!two error:aborted speechend soundend audioend end onend',
    'web speech: continuous results add up; abort() ends with "aborted"', l);
  // A second start() throws like Chrome; a second recognition ends the first one (one microphone).
  const twice = await b.tool('evaluate_script', { pageId: pid, function: '() => { go({ continuous: true }); try { rec.start(); return "no error"; } catch (e) { return e.name; } }' });
  check(twice.text.includes('InvalidStateError'), 'web speech: start() twice throws InvalidStateError', twice.text.slice(0, 80));
  await until('audiostart');
  const first = await b.tool('evaluate_script', { pageId: pid, function: '() => { window.r1 = rec; window.r1log = []; r1.onerror = e => r1log.push(e.error); r1.onend = () => r1log.push("end"); go({}); return "ok"; }' });
  await until('audiostart');
  const r1log = await b.tool('evaluate_script', { pageId: pid, function: '() => r1log.join(" ")' });
  check(first.text.includes('ok') && r1log.text.includes('aborted end'), 'web speech: a new recognition ends the running one with "aborted"', r1log.text.slice(0, 80));
  await b.tool('evaluate_script', { pageId: pid, function: '() => rec.abort()' });
  await until('onend');

  // Dictation in the marking overlay: holding Space talks, the words go to the cursor, the agent learns they were dictated.
  const askedV = nextNote();
  await control(`sendelement ${sb.id} 20 20`);
  await sleep(500);
  const key = (type, extra = '') => `t.dispatchEvent(new KeyboardEvent('${type}', { key: ' ', bubbles: true${extra} }))`;
  const held = await uiEval('annotator', `(() => { const t = document.getElementById('text'); t.focus(); t.value = 'Make'; t.setSelectionRange(4, 4); ${key('keydown')}; t.value += ' '; t.setSelectionRange(5, 5); return new Promise(r => setTimeout(() => { ${key('keydown', ', repeat: true')}; r(document.body.className + '|' + t.value) }, 400)); })()`);
  check(held?.result?.includes('listening') && held.result.endsWith('|Make'), 'dictation: holding Space starts listening and takes the typed space away', JSON.stringify(held?.result ?? held?.error));
  await control('speech interim it');
  await control('speech final it green');
  const released = await uiEval('annotator', `(() => { const t = document.getElementById('text'); ${key('keyup')}; return new Promise(r => setTimeout(() => r(document.body.className + '|' + t.value + '|' + t.selectionStart), 300)); })()`);
  check(!released?.result?.includes('listening') && released?.result?.endsWith('|Make it green|13'), 'dictation: releasing Space ends it; the words follow the typed text, the cursor stays after them', JSON.stringify(released?.result ?? released?.error));
  // The microphone button: press and hold; the signal level shows while listening.
  const pressed = await uiEval('annotator', `(() => { const m = document.getElementById('mic'); m.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true })); return new Promise(r => setTimeout(() => r(document.body.className), 200)); })()`);
  check(pressed?.result?.includes('listening'), 'dictation: pressing the microphone button starts listening', JSON.stringify(pressed?.result ?? pressed?.error));
  await control('speech level 0.6');
  const meter = await uiEval('annotator', `document.querySelector('#meter i').style.width`);
  check(meter?.result === '60%', 'dictation: the meter follows the microphone level', JSON.stringify(meter?.result));
  await control('speech final please');
  const releasedM = await uiEval('annotator', `(() => { const m = document.getElementById('mic'); m.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true })); return new Promise(r => setTimeout(() => r(document.body.className + '|' + document.getElementById('text').value + '|' + document.getElementById('lang').value), 300)); })()`);
  check(!releasedM?.result?.includes('listening') && /\|Make it green please\|[a-z]{2}-[A-Z]{2}$/.test(releasedM?.result ?? ''), 'dictation: releasing the button ends it; the words follow; a language is chosen', JSON.stringify(releasedM?.result ?? releasedM?.error));
  // Released while macOS still asks for the microphone: the dictation ends at once
  // (no "Finishing…" forever), and the late answer starts nothing.
  await control('speech permission wait');
  const mic = type => `document.getElementById('mic').dispatchEvent(new PointerEvent('${type}', { button: 0, pointerId: 1, bubbles: true }))`;
  await uiEval('annotator', `(() => { ${mic('pointerdown')}; return 1; })()`);
  await sleep(200);
  const early = await uiEval('annotator', `(() => { ${mic('pointerup')}; return new Promise(r => setTimeout(() => r(document.body.className + '|' + document.getElementById('dictText').textContent), 300)); })()`);
  check(!early?.result?.includes('listening') && !early?.result?.includes('Finishing'), 'dictation: released before the microphone is allowed, it ends at once', JSON.stringify(early?.result ?? early?.error));
  await control('speech permission answer');
  await sleep(300);
  const late = await uiEval('annotator', `document.body.className + '|' + document.getElementById('text').value`);
  check(!late?.result?.includes('listening') && late?.result?.endsWith('|Make it green please'), 'dictation: the late answer of macOS starts no recognition', JSON.stringify(late?.result ?? late?.error));
  await uiEval('annotator', `document.getElementById('send').click()`);
  const answerV = await askedV;
  check(answerV.text.includes('The user says (dictated: a word may be misheard): "Make it green please"'), 'dictation: the agent learns that the comment was dictated', answerV.text.replace(/\n/g, ' | ').slice(0, 120));
}
await b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/beta` });
check(!(await state()).sessions.find(s => s.id === sb.id).nav.problems.length, 'problems: a new page starts without problems');
// Errors count as seen while the tab's DevTools are open; after closing them only new ones count
{
  const badge = async () => { await sleep(400); return (await state()).sessions.find(s => s.id === sb.id).nav?.newProblems; };
  const devtoolsOpen = async () => (await state()).sessions.find(s => s.id === sb.id).devtools;
  const wasOpen = await devtoolsOpen();
  if (!wasOpen) await control(`devtools ${sb.id}`);
  await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => { console.error("seen in DevTools"); return 1; }' });
  check(await badge() === 0, 'problems: no badge while the DevTools of the tab are open');
  await control(`devtools ${sb.id}`);
  check(!(await devtoolsOpen()) && await badge() === 0, 'problems: errors seen in the DevTools do not come back when they close');
  await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => { console.error("after closing"); return 1; }' });
  check(await badge() === 1, 'problems: a new error after closing the DevTools counts');
  if (wasOpen) await control(`devtools ${sb.id}`);
}

// Web Share API: Electron lacks it; Habitab adds navigator.share before page scripts and receives the data (no menu in tests). macOS only: there is no share menu elsewhere
if (process.platform === 'darwin') {
  await b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/share` });
  await control(`select ${sb.id}`);
  const shareDetect = await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => [window.early, typeof navigator.canShare, navigator.canShare({ url: "/y" }), navigator.canShare({})].join(",")' });
  check(shareDetect.text.includes('function,function,true,false'), 'web share: navigator.share exists before page scripts, canShare validates', shareDetect.text.replace(/\n/g, ' | ').slice(0, 160));
  await control(`userclick ${sb.id}`);
  let shared;
  for (let i = 0; i < 30 && !shared; i++) { await sleep(100); shared = (await state()).lastShare; }
  const shareResult = await b.tool('evaluate_script', { pageId: await pageId(b), function: '() => window.r' });
  check(shared?.title === 'T' && shared.text === 'Hello' && shared.url === `${base}/x` && shared.files?.[0] === 'a.txt' && shareResult.text.includes('AbortError'),
    'web share: a click shares title, text, absolute URL and files; the page gets the result', JSON.stringify(shared) + ' ' + shareResult.text.replace(/\n/g, ' ').slice(-40));
}
await b.tool('navigate_page', { pageId: await pageId(b), url: `${base}/beta` });

// Timeline: each tool call with a screenshot of the agent's tab; unchanged pages share one
await control(`select ${sb.id}`);
await sleep(1200);
const tl = (await state()).sessions.find(s => s.id === sb.id).timeline ?? [];
const navBroken = tl.find(x => x.tool === 'Navigate' && x.url?.endsWith('/broken'));
const tlDir = path.join(env.HABITAB_HOME, 'timeline', sb.id);
check(tl.length >= 5 && navBroken?.shot && fs.existsSync(path.join(tlDir, `${navBroken.shot}.jpg`)) && fs.existsSync(path.join(tlDir, `${navBroken.shot}-t.jpg`)),
  'timeline: tool calls are recorded with URL and screenshot files', JSON.stringify(tl.slice(-4).map(x => [x.tool, x.url?.slice(-8), x.shot])));
await pause();
await b.tool('take_snapshot', { pageId: await pageId(b) });
await pause();
await b.tool('take_snapshot', { pageId: await pageId(b) });
await sleep(1500);
const tl2 = (await state()).sessions.find(s => s.id === sb.id).timeline;
const [s1, s2] = tl2.slice(-2);
check(s1?.shot && s1.shot === s2?.shot && fs.readdirSync(tlDir).filter(f => f.startsWith(`${s2.id}.`)).length === 0, 'timeline: an unchanged page shares the screenshot of the step before', JSON.stringify([s1?.shot, s2?.shot]));
// The open timeline does not cover docked DevTools: they start below its thumbnails
await control(`devtools ${sb.id}`);
let dtHeight;
for (let i = 0; i < 50 && !dtHeight; i++) { await sleep(200); dtHeight = (await uiEval('devtools', 'innerHeight'))?.result; }
await control(`action ${sb.id} timeline true`);
await sleep(300);
const dtHeightOpen = (await uiEval('devtools', 'innerHeight'))?.result;
await control(`action ${sb.id} timeline false`);
await control(`devtools ${sb.id}`);
check(dtHeight - dtHeightOpen === 59, 'timeline: open, it leaves docked DevTools free (they start below the thumbnails)', JSON.stringify([dtHeight, dtHeightOpen]));
// Feedback on an earlier screenshot: the area is cut out of it, and the agent learns it is an earlier state
const earlier = tl2.find(x => x.tool === 'Navigate' && x.url?.endsWith('/broken') && x.shot);
await control(`action ${sb.id} timeline true`);
await control(`action ${sb.id} timelinePreview ${earlier.id}`);
await sleep(800);
const askedE = nextNote();
await control(`action ${sb.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 4000, "height": 4000}, "text": "This was wrong"}`);
const answerE = await askedE;
check(answerE.text.includes('This was wrong') && answerE.text.includes('earlier state') && answerE.text.includes('/broken') && !answerE.text.includes('Marked: ') && answerE.raw.result.content.some(c => c.type === 'image' && c.data.length > 100),
  'feedback on an earlier screenshot: its part and the hint that it is an earlier state', answerE.text.replace(/\n/g, ' | ').slice(0, 220));
await control(`action ${sb.id} timeline false`);
// The timeline belongs to a tab: another tab has its own, and a closed tab takes its steps (and the close call) with it
await control(`select ${sb.id}`);
const tlBefore = (await state()).sessions.find(s => s.id === sb.id).timeline.map(x => x.id);
await pause();
await b.tool('new_page', { url: `${base}/other` });
await pause();
await b.tool('take_snapshot', { pageId: await pageId(b) });
await sleep(1200);
const tlOther = (await state()).sessions.find(s => s.id === sb.id).timeline;
check(tlOther.some(x => x.tool === 'New page') && tlOther.some(x => x.tool === 'Snapshot') && tlOther.every(x => !tlBefore.includes(x.id)),
  'timeline: a new tab has its own timeline, starting with the step that opened it', JSON.stringify(tlOther.map(x => x.tool)));
const otherId = +((await b.tool('list_pages')).text.match(/^(\d+):.*\/other/m)?.[1]);
await pause();
await b.tool('close_page', { pageId: otherId });
await sleep(1200);
const tlAfter = (await state()).sessions.find(s => s.id === sb.id).timeline;
check(tlBefore.length && tlAfter.map(x => x.id).join() === tlBefore.join(),
  'timeline: closing a tab removes its steps; the close call does not show in the remaining tab', JSON.stringify(tlAfter.slice(-3).map(x => x.tool)));

// Context menu "Send Element to Agent…": the overlay opens on the element.
await control(`select ${sb.id}`);
await control(`sendelement ${sb.id} 20 20`);
await sleep(500);
check((await state()).annotating === true, 'send element: the marking overlay opens');
check((await state()).sessions.find(s => s.id === sb.id).held === true, 'marking: the agent waits while the overlay is open');
await control(`action ${sb.id} annotate false`);
await sleep(200);
check((await state()).sessions.find(s => s.id === sb.id).held === false, 'marking: the agent goes on when the overlay closes');

// Without an inbox socket there is no channel: feedback is kept for the clipboard
{ const g = client('gamma-plain', 'gemini');
  await g.initialize();
  await g.tool('navigate_page', { pageId: await pageId(g), url: `${base}/gamma-plain` });
  const sg = await sessionOf(g);
  check(sg?.client === 'gemini' && sg.push === false, 'a client without inbox or daemon: no push', JSON.stringify({ client: sg?.client, push: sg?.push }));
  await control(`select ${sg.id}`);
  await sleep(300);
  await control(`action ${sg.id} annotateSubmit {"rect": {"x": 0, "y": 0, "width": 100, "height": 50}, "text": "Copy me"}`);
  await sleep(600);
  check((await state()).clipboard?.includes('Copy me'), 'without a channel the feedback goes to the clipboard');
  await g.close();
}

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
// Width preset: width fixed, height still fills
await control(`action ${sb.id} emulate {"preset": "responsive", "width": 768}`);
await sleep(400);
nav = (await state()).sessions.find(s => s.id === sb.id).nav;
check((await viewport())?.[0] === 768 && !nav.emulation.fillWidth && nav.emulation.fillHeight, 'breakpoint sets the width, the height keeps filling');
// Dragging the right handle by 50 px widens the centered viewport by 100 px
await control(`draghandle ${sb.id} 50`);
await sleep(500);
check((await viewport())?.[0] === 868, 'dragging the right handle changes the width', JSON.stringify(await viewport()));
// Mouse or touch: touch makes a mobile device whose pointer is coarse and cannot hover; the mouse sends touch events
{
  const input = async () => JSON.parse((await b.tool('evaluate_script', { pageId: pb, function: `() => JSON.stringify({ coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches, points: navigator.maxTouchPoints, ontouch: 'ontouchstart' in window, events: window.inputLog ?? [] })` })).text.match(/"(\{.*\})"/)?.[1].replace(/\\"/g, '"') ?? '{}');
  const listen = () => b.tool('evaluate_script', { pageId: pb, function: `() => { window.inputLog = []; for (const t of ['touchstart', 'mousedown']) addEventListener(t, e => inputLog.push(e.type)); return 1; }` });
  await control(`ui responsive document.getElementById('touch').click()`);
  await sleep(500);
  await listen();
  await control(`hold ${sb.id} off`);
  await control(`userclick ${sb.id} 30 30`);
  await sleep(300);
  await control(`hold ${sb.id} off`);
  const touch = await input();
  const on = (await uiEval('responsive', `document.getElementById('touch').className`))?.result;
  check(touch.coarse && !touch.hover && touch.points > 0 && touch.events[0] === 'touchstart' && on === 'on', 'touch: coarse pointer without hover, the mouse sends touch events', JSON.stringify({ touch, on }));
  await control(`ui responsive document.getElementById('mouse').click()`);
  await sleep(500);
  await listen();
  await control(`userclick ${sb.id} 30 30`);
  await sleep(300);
  await control(`hold ${sb.id} off`);
  const mouse = await input();
  check(!mouse.coarse && mouse.hover && mouse.points === 0 && !mouse.events.includes('touchstart') && (await state()).sessions.find(s => s.id === sb.id).nav.emulation.width === 868, 'mouse: fine pointer with hover again, the size stays', JSON.stringify(mouse));
}
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
// The agent's size is not scaled (its screenshots would shrink): too tall, the bar says it is cut off.
await b.tool('emulate', { pageId: pb, viewport: '500x3000x1' });
await sleep(400);
emu = (await state()).sessions.find(s => s.id === sb.id).nav.emulation;
check(emu?.by === 'agent' && emu.cut && emu.scale === 1, "an agent's size that does not fit is marked as cut off", JSON.stringify(emu));
// The user changes it: from now on it is scaled to fit
await control(`action ${sb.id} emulate {"preset": "responsive", "width": 390}`);
await sleep(400);
emu = (await state()).sessions.find(s => s.id === sb.id).nav.emulation;
check(emu?.by === 'user' && emu.zoom === 'fit' && emu.scale < 1 && !emu.cut, "the user's change of the agent's size scales it to fit", JSON.stringify(emu));
await b.tool('emulate', { pageId: pb, viewport: '500x400x1' });
await sleep(400);
// Marking in responsive mode: the overlay also covers the room beside the
// viewport (for the form); a mark stays in the page and arrives in page coordinates.
{
  const boundsOf = async v => { const n = events.length; await control(`bounds ${v}`); return events.slice(n).find(e => e.bounds)?.bounds; };
  await b.tool('evaluate_script', { pageId: pb, function: `() => { document.body.insertAdjacentHTML('beforeend', '<div id="mark-me" style="position:fixed;left:20px;top:20px;width:100px;height:60px;background:#fc0">Mark me</div>'); return 1; }` });
  await control(`action ${sb.id} annotate true`);
  await sleep(500);
  const ov = await boundsOf('annotator'), pg = await boundsOf('page');
  check(ov && pg && ov.width > pg.width && pg.x > ov.x, 'responsive mode: the marking overlay is wider than the viewport', JSON.stringify({ ov, pg }));
  const at = (x, y) => `${pg.x - ov.x + x} ${pg.y - ov.y + y}`;
  await control(`usermouse annotator down ${at(10, 10)}`);
  for (const k of [0.5, 1]) await control(`usermouse annotator move ${at(10 + 120 * k, 10 + 80 * k)}`);
  await control(`usermouse annotator up ${at(130, 90)}`);
  await sleep(300);
  // The mark is taken when the drag ends: the element may go before the comment is sent.
  await control(`ui page (() => { document.getElementById('mark-me').remove(); return 1; })()`);
  await sleep(100);
  const markNote = nextNote();
  await control(`ui annotator (() => { document.getElementById('text').value = 'Responsive mark'; document.getElementById('send').click(); return 1; })()`);
  const marked = await markNote;
  check(marked.text.includes('Responsive mark') && marked.text.includes('120 × 80 px at 10, 10') && marked.text.includes('mark-me'), 'responsive mode: the mark arrives in page coordinates, with the elements as they were when marked', marked.text.replace(/\n/g, ' | ').slice(0, 300));
  // Several notes at once: Add keeps a note, a new drag keeps one with a comment; Send sends all as one message, one image each.
  const drag = async (x1, y1, x2, y2) => {
    await control(`usermouse annotator down ${at(x1, y1)}`);
    await control(`usermouse annotator move ${at(x2, y2)}`);
    await control(`usermouse annotator up ${at(x2, y2)}`);
    await sleep(200);
  };
  await control(`action ${sb.id} annotate true`);
  await sleep(300);
  await drag(10, 10, 60, 40);
  await control(`ui annotator (() => { document.getElementById('text').value = 'First'; document.getElementById('add').click(); return 1; })()`);
  await drag(70, 10, 120, 40);
  await control(`ui annotator (() => { document.getElementById('text').value = 'Second'; return 1; })()`);
  await drag(10, 50, 60, 80);
  const shown = await uiEval('annotator', `document.querySelectorAll('.note').length + '|' + document.getElementById('sendText').textContent`);
  check((await state()).annotateKept === 2 && shown?.result === '2|Send 3', 'several notes: kept notes show with their numbers, Send counts them all', `${(await state()).annotateKept} ${shown?.result}`);
  const multi = nextNote();
  await control(`ui annotator (() => { document.getElementById('text').value = 'Third'; document.getElementById('send').click(); return 1; })()`);
  const many = await multi;
  const pngs = many.text.match(/\/\S+feedback-\d+-\d\.png/g) ?? [];
  check(/marked 3 areas/.test(many.text) && /1\. The user says: "First"\n.*Marked: .*50 × 30 px at 10, 10/.test(many.text) && /2\. The user says: "Second"/.test(many.text) && /3\. The user says: "Third"/.test(many.text)
    && pngs.length === 3 && pngs.every(f => fs.existsSync(f)) && (await state()).annotating === false,
    'several notes go out as one message, numbered, with one image each', many.text.replace(/\n/g, ' | ').slice(0, 400));
  // The status line's Send: the kept notes go out without the form.
  await control(`action ${sb.id} annotate true`);
  await sleep(300);
  await drag(10, 10, 60, 40);
  await control(`ui annotator (() => { document.getElementById('text').value = 'Only one'; document.getElementById('add').click(); return 1; })()`);
  await sleep(200);
  const viaStatus = nextNote();
  await control(`action ${sb.id} annotateSend`);
  const one = await viaStatus;
  check(one.text.includes('"Only one"') && !/areas/.test(one.text), 'the status line sends the kept notes', one.text.replace(/\n/g, ' | ').slice(0, 200));
  await control(`action ${sb.id} annotate false`);
}
await control(`action ${sb.id} responsive`);
await sleep(400);
vpa = await viewport();
check(!(await state()).sessions.find(s => s.id === sb.id).nav.emulation && vpa?.[0] > 600 && vpa?.[2] === vp0?.[2], 'leaving responsive mode restores the page size', JSON.stringify(vpa));

// Active tabs: each tab the agent or the user used during the session's last 25 tool calls
{ const z = client('tab-rule');
  await z.initialize();
  await z.tool('navigate_page', { pageId: await pageId(z), url: `${base}/z1` });
  await z.tool('new_page', { url: `${base}/z2` });
  await z.tool('new_page', { url: `${base}/z3` });
  const pages = (await z.tool('list_pages')).text;
  const zid = re => +(pages.match(new RegExp(`^(\\d+):.*${re}`, 'm'))?.[1]);
  const zs = async () => (await state()).sessions.find(s => s.projectPath.endsWith('tab-rule'));
  const tab = async re => (await zs()).tabs.find(t => t.url.endsWith(re));
  check(!(await tab('/z1')).inactive && !(await tab('/z2')).inactive && !(await tab('/z3')).inactive, 'new tabs are active');
  // The agent works with z1 in the background; z3 stays the front tab.
  await z.tool('take_snapshot', { pageId: zid('/z1') });
  check((await zs()).statusTab === (await tab('/z1')).id, 'the session status shows on the tab the agent works with');
  // 26 steps in z1 (a step needs a pause after it). Page lists touch every tab, but they are no step and no use of a tab.
  for (let i = 0; i < 26; i++) { await z.tool('take_screenshot', { pageId: zid('/z1') }); await z.tool('list_pages'); await pause(); }
  let t1 = await tab('/z1'), t2 = await tab('/z2'), t3 = await tab('/z3');
  check(!t1.inactive && t2.inactive && !t3.inactive && t3.active, 'tabs not used for 25 tool calls become inactive (the front tab stays)', JSON.stringify([t1.inactive, t2.inactive, t3.inactive]));
  // The user picks the inactive tab and works in it: it stays active after the user moves on.
  await control(`select ${(await zs()).id} ${t2.id}`);
  check(!(await tab('/z2')).inactive, 'a selected inactive tab shows as active');
  await control(`userclick ${(await zs()).id}`);
  await control(`select ${(await zs()).id} ${t3.id}`);
  check(!(await tab('/z2')).inactive, 'a tab the user worked in is active again');
  await z.close();
}

// Debugger pause: high CPU shows a hint; the user's input pauses the agent's
// debugger (project option), the agent's next work in the tab turns it on again.
{ const d = client('dbg-rule');
  await d.initialize();
  await d.tool('navigate_page', { pageId: await pageId(d), url: `${base}/busy` });
  const ds = async () => (await state()).sessions.find(s => s.projectPath.endsWith('dbg-rule'));
  const front = async () => (await ds()).tabs.find(t => t.active);
  let busy = false;
  for (let i = 0; i < 40 && !busy; i++) { await sleep(500); busy = (await front()).busy; }
  check(busy, 'a tab with high CPU use shows as busy');
  await control(`action ${(await ds()).id} debugger`);
  await sleep(300);
  check((await ds()).pausesDebugger && (await front()).debuggerPaused, 'the hint pauses the debugger and turns the project option on');
  check(!(await d.tool('take_snapshot', { pageId: await pageId(d) })).isError && !(await front()).debuggerPaused, 'the agent works in the tab: its debugger is on again');
  await control(`userclick ${(await ds()).id}`);
  await sleep(300);
  check((await front()).debuggerPaused, "the user's input pauses the debugger again");
  const ev = await d.tool('evaluate_script', { pageId: await pageId(d), function: '() => 6 * 7' });
  check(ev.text.includes('42') && !(await front()).debuggerPaused, 'the agent continues after the pause', ev.text.slice(0, 80));
  await d.close();
}

// Agents work in the background: the window never took focus by itself
// (Ignores the app start and the test's own select commands, which focus the page like a user click.)
{ const f = events.filter(e => e.focus && e.at > agentStart && !e.afterSelect); check(f.length === 0, 'window never takes focus during agent work', f.map(e => e.stack).join(' || ')); }

// No Chrome started, one app in the Dock
const chromesAfter = chromePids().filter(p => !chromesBefore.has(p));
check(chromesAfter.length === 0, 'no Chrome process started', chromesAfter.join(','));
// The test app has no Dock icon unless it runs visibly (HABITAB_TEST_VISIBLE=1).
if (process.env.HABITAB_TEST_VISIBLE === '1' && process.platform === 'darwin') {
  const dock = execFileSync('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'], { encoding: 'utf8' });
  check((dock.match(/Electron|Habitab/g) ?? []).length === 1, 'exactly one Habitab/Electron app in the Dock');
}

// Regular end closes the session browser
await a.close();
await sleep(800);
sa = (await state()).sessions.find(s => s.id === sa.id);
check(sa.phase === 'ended' && sa.tabs.length === 0, 'regular end closes all tabs of the session', sa.phase);

// Pinned session keeps its browser after a hard crash of the client with its server and bridge
await control(`pin ${sb.id} on`);
process.kill(-b.proc.pid, 'SIGKILL');
await sleep(1500);
sb = (await state()).sessions.find(s => s.id === sb.id);
check(sb.phase === 'kept' && sb.tabs.length > 0, 'SIGKILL of client, server and bridge: pinned session keeps its browser', sb.phase);
await control(`remove ${sb.id}`);
check(!(await state()).sessions.find(s => s.id === sb.id), 'removing the session closes it');
await sleep(300);
check(!fs.existsSync(path.join(env.HABITAB_HOME, 'timeline', sb.id)), 'removing the session deletes its timeline screenshots');

// App restart: the server lives on; its next call starts a new bridge that rejoins the session
const c = client('gamma');
await c.initialize();
await c.tool('navigate_page', { pageId: await pageId(c), url: `${base}/gamma` });
const cookie = async () => (await c.tool('evaluate_script', { pageId: await pageId(c), function: '() => document.cookie' })).text;
await c.tool('evaluate_script', { pageId: await pageId(c), function: '() => { document.cookie = "login=yes; max-age=3600"; return 1 }' });
// Persistent profile: the running browser moves to the project profile and keeps the cookie
const sc = (await state()).sessions.find(s => s.project === 'gamma');
await control(`action ${sc.id} persistentProfile "${sc.id}"`);
await sleep(2500);
check((await state()).sessions.find(s => s.id === sc.id)?.persistentProfile && (await cookie()).includes('login=yes'), 'persistent profile: the session moves to it with its cookies', (await cookie()).slice(0, 120));
// A session without persistent profile: tabs and cookies are restored, too
const dr = client('epsilon');
await dr.initialize();
await dr.tool('navigate_page', { pageId: await pageId(dr), url: `${base}/delta` });
await dr.tool('evaluate_script', { pageId: await pageId(dr), function: '() => { document.cookie = "token=abc"; return 1 }' });
await dr.tool('new_page', { url: `${base}/delta-2` });
// The page id the agent knows for /delta (the server gives new ids after the restart).
const deltaIdBefore = +((await dr.tool('list_pages')).text.match(/^(\d+):.*\/delta\b(?!-)/m)?.[1] ?? 0);
const sdBefore = (await state()).sessions.find(s => s.project === 'epsilon');
await control(`select ${sdBefore.id}`);
await sleep(1200);
const tlFront = (await state()).sessions.find(s => s.id === sdBefore.id).timeline.map(x => x.id);
await control('quit');
await sleep(2500);
startApp();
await waitFor(e => e.ready);
let sdAfter;
for (let i = 0; i < 30 && !sdAfter?.tabs.every(t => t.url); i++) { await sleep(100); sdAfter = (await state()).sessions.find(s => s.id === sdBefore.id); }
check(sdAfter && sdAfter.tabs.map(t => t.url.replace(base, '')).join(',') === '/delta,/delta-2' && sdAfter.tabs[1].active,
  'app restart: the session comes back with its tabs at once', JSON.stringify(sdAfter?.tabs.map(t => [t.url, t.active])));
await control(`select ${sdBefore.id}`);
const tlFrontAfter = (await state()).sessions.find(s => s.id === sdBefore.id).timeline.map(x => x.id);
check(tlFront.length && tlFrontAfter.join() === tlFront.join(), 'app restart: the front tab keeps its own timeline', JSON.stringify([tlFront, tlFrontAfter]));
await sleep(2500);
// The server lost its browser with the app and starts a new bridge with the next call; the restored tabs have new page ids.
const deltaOld = await dr.tool('evaluate_script', { pageId: deltaIdBefore, function: '() => location.pathname' });
check(deltaIdBefore && (deltaOld.isError || deltaOld.text.includes('"/delta"')), 'app restart: the agent goes on (an old page id may be gone)', deltaOld.text.replace(/\n/g, ' | ').slice(0, 120));
const dPages = await dr.tool('list_pages');
check(dPages.text.includes('/delta-2') && dPages.text.includes('/delta'), 'app restart: the agent sees its restored tabs', dPages.text.replace(/\n/g, ' | ').slice(0, 200));
const dCookie = (await dr.tool('evaluate_script', { pageId: +(dPages.text.match(/^(\d+):.*\/delta\b/m)?.[1] ?? 1), function: '() => document.cookie' })).text;
check(dCookie.includes('token=abc'), 'app restart: session cookies (in memory) are restored', dCookie.slice(0, 120));
await dr.close();
const afterRestart = await c.tool('list_pages');
check(afterRestart.text.includes('/gamma'), 'app restart: the gamma tab is restored', afterRestart.text.replace(/\n/g, ' | ').slice(0, 200));
const pc = +(afterRestart.text.match(/^(\d+):/m)?.[1] ?? 1);
const nav2 = await c.tool('navigate_page', { pageId: pc, url: `${base}/gamma-2` });
check(!nav2.isError, 'after the app restart the agent continues in its restored session', nav2.text.slice(0, 80));
check((await cookie()).includes('login=yes'), 'persistent profile survives an app restart', (await cookie()).slice(0, 120));
// A second, parallel session of the same project gets a copy, not the profile itself
const c2 = client('gamma');
await c2.initialize();
await c2.tool('navigate_page', { pageId: await pageId(c2), url: `${base}/gamma-3` });
const c2cookie = (await c2.tool('evaluate_script', { pageId: await pageId(c2), function: '() => document.cookie' })).text;
const c2pages = (await c2.tool('list_pages')).text;
check(c2cookie.includes('login=yes') && !c2pages.includes('gamma-2'), 'parallel session of the project: copied cookies, own tabs', c2pages.replace(/\n/g, ' ').slice(0, 160));
await c2.close();
await c.close();

const finalErrors = (await state()).errors;
check(!finalErrors.length, 'no errors reported during the test', finalErrors.join('; '));
app.kill();
inbox.close();
page.close();
// The app may still write its profile while it exits.
await new Promise(r => (app.exitCode !== null ? r() : app.once('exit', r)));
if (process.env.HABITAB_KEEP_TMP) console.log(`kept ${tmp}`); else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
