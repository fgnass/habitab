// A short video of the real app for the website and social posts: the agent
// tests the juice shop on a phone (responsive mode, timeline open), the user
// marks text that runs off the screen and writes a note, the agent fixes it.
// Usage: npm run build && node scripts/site-video.mjs [out.mp4]   (default: site/img/feedback.mp4)
//   KEEP_FRAMES=1 keeps the recording; VIDEO_FROM=<its folder> renders it again without a new one.
// Starts a visible app with test control and captures its window by id, so the
// window never takes focus and the real pointer stays where it is. The user's
// input is synthetic; the pointer, the captions and the frame around the window
// are drawn afterwards by ffmpeg.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { demoSite, fixes } from '../tests/integration/demo-site.mjs';
import { bridgeEnv, fakeClient } from '../tests/integration/bridge-env.mjs';
import { McpClient, sleep } from '../tests/integration/mcp-client.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.resolve(process.argv[2] ?? path.join(root, 'site/img/feedback.mp4'));
// Window size in points; 16:9 for social media.
const W = 1440, H = 810;
const NOTE = 'The headline runs off the screen on a phone.';

const log = m => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const electronBin = createRequire(path.join(root, 'package.json'))('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-video-'));
const env = bridgeEnv(tmp, { HABITAB_TEST_VISIBLE: '1' });
// The same dictation language on every Mac (the default follows the system's languages).
fs.mkdirSync(env.HABITAB_HOME, { recursive: true });
fs.writeFileSync(path.join(env.HABITAB_HOME, 'ui.json'), JSON.stringify({ dictationLanguage: 'en-US' }));
const appEnv = { ...process.env, ...env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
const app = spawn(electronBin, [root], { env: appEnv, stdio: ['pipe', 'pipe', 'ignore'] });
// Never hangs: a stuck step ends the run.
setTimeout(() => { console.error('timeout'); app.kill(); process.exit(1); }, 180_000).unref();
const events = [];
readline.createInterface({ input: app.stdout }).on('line', l => { try { events.push(JSON.parse(l)); } catch {} });
while (!events.some(e => e.ready)) await sleep(100);
const control = line => app.stdin.write(line + '\n');
const ask = (line, key) => new Promise(r => {
  const n = events.length; control(line);
  const t = setInterval(() => { const e = events.slice(n).find(x => x[key] !== undefined || x.error); if (e) { clearInterval(t); if (e.error) log(`${line.slice(0, 40)}…: ${e.error}`); r(e[key]); } }, 30);
});
const state = () => ask('state', 'state');
/** Runs a script in a view of the app (`page`, `topbar`, `annotator`, …) and returns its result. */
const inView = (view, js) => ask(`ui ${view} ${js.replace(/\n\s*/g, ' ')}`, 'result');

/** Runs the scene and records the window: frames, pointer, clicks and captions over time. */
async function record() {
  const site = http.createServer(demoSite);
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  // The server below a script named like the client; the bridge finds the client in the process tree.
  const session = async (name, kind, url, extraEnv = {}) => {
    const d = path.join(tmp, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    const c = new McpClient(fakeClient(env, kind), [], { env: { ...env, ...extraEnv }, cwd: d });
    await c.initialize();
    await c.tool('navigate_page', { pageId: 1, url });
    return c;
  };

  // Claude Code's inbox: the user's note reaches the agent there, with all
  // details, like in a real session (the line format is internal to Claude Code,
  // see the README).
  let noted = '';
  const inboxPath = path.join(tmp, 'inbox.sock');
  const inbox = net.createServer(sock => {
    let buf = '';
    sock.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { const m = JSON.parse(buf.slice(0, i)); if (m.type === 'user') noted = m.message.content; }
    });
  });
  await new Promise(r => inbox.listen(inboxPath, r));

  // Codex reads the API docs in another project; Claude Code tests the shop on a
  // phone. The shop session starts blank, so the timeline starts with the shop.
  control(`resize ${W} ${H}`);
  const codex = await session('relay-docs', 'codex', `${base}/docs/messages/send`);
  const agent = await session('juice-shop', 'claude', 'about:blank', { CLAUDE_CODE_MESSAGING_SOCKET: inboxPath, CLAUDE_CODE_MESSAGING_TOKEN: 'video' });
  const shop = (await state()).sessions.find(s => s.client === 'claude');
  control(`select ${shop.id}`);
  control(`action ${shop.id} responsive`);
  await sleep(500);
  control(`action ${shop.id} emulate {"preset":"responsive","width":390,"fillHeight":true}`);
  control(`action ${shop.id} timeline true`);
  const windowId = String(await ask('windowid', 'windowId')).split(':')[1];
  await sleep(1500);
  // The setup counts as the user's input: the agent must not wait for it.
  control(`hold ${shop.id} off`);
  await sleep(300);

  // MARK: Recording

  // Frames of the window, as fast as screencapture goes (a few in parallel), each
  // with the time it was taken. ffmpeg later turns them into a steady frame rate.
  const framesDir = path.join(tmp, 'frames');
  fs.mkdirSync(framesDir);
  const frames = [];
  let recording = true, t0 = 0;
  const now = () => (Date.now() - t0) / 1000;
  const recorder = async () => {
    for (let i = 0; recording; i++) {
      const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}-${i}.jpg`);
      const start = now();
      await new Promise(r => spawn('screencapture', ['-l', windowId, '-x', '-o', '-t', 'jpg', file]).on('exit', r));
      if (fs.existsSync(file)) frames.push({ file, t: (start + now()) / 2 });
    }
  };
  t0 = Date.now();
  const recorders = [0, 1, 2].map(i => sleep(i * 30).then(recorder));

  // MARK: Pointer and captions

  // Pointer positions in window points over time (seconds since the start), its clicks, and the captions.
  const track = [];
  const clicks = [];
  const captions = [];
  let pos = { x: W + 40, y: H - 160 };
  let pointerFrom = Infinity;
  /** Moves the pointer to (x, y) in `ms` (eased in ffmpeg). */
  const move = async (x, y, ms = 700) => {
    pointerFrom = Math.min(pointerFrom, now());
    track.push({ t: now(), ...pos });
    pos = { x, y };
    track.push({ t: now() + ms / 1000, ...pos });
    await sleep(ms);
  };
  const click = async () => { await sleep(120); clicks.push({ t: now(), ...pos }); await sleep(200); };
  const bounds = view => ask(`bounds ${view}`, 'bounds');
  /** An element's box in window points: `view` is where it is, page coordinates are its view's. */
  const box = async (view, selector) => {
    const b = await bounds(view);
    const r = await inView(view, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    return { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height, view: b };
  };
  /** Who acts (`agent` or `you`) and what: shown from now until the next caption. */
  const caption = (who, text) => { captions.push({ t: now(), who, text }); log(`${who}: ${text}`); };

  // MARK: The scene

  let atHome = false;
  const agentRun = (async () => {
    caption('agent', 'Tests the shop on a phone.');
    for (const [tool, args, wait] of [
      ['navigate_page', { pageId: 1, url: `${base}/shop` }, 600],
      ['navigate_page', { pageId: 1, url: `${base}/shop/juice/blood-orange` }, 1300],
      ['take_snapshot', { pageId: 1 }, 600],
      ['navigate_page', { pageId: 1, url: `${base}/shop/cart` }, 900],
      ['navigate_page', { pageId: 1, url: `${base}/shop` }, 900],
      ['take_screenshot', { pageId: 1 }, 600],
    ]) { await sleep(wait); await agent.tool(tool, args); }
    atHome = true;
    // The user's note arrives in the inbox, with the details and the image file.
    while (!noted) await sleep(50);
    await sleep(400);
    log(`feedback: ${noted.slice(0, 80).replace(/\n/g, ' ')}`);
    caption('agent', 'Gets your note, the marked elements and a screenshot …');
    await sleep(2200);
    // The fix: the dev server serves the home page with the new CSS now.
    fixes.add('hero-overflow');
    await agent.tool('navigate_page', { pageId: 1, type: 'reload' });
    caption('agent', '… and fixes it.');
    await sleep(700);
    await agent.tool('take_screenshot', { pageId: 1 });
  })();

  // The user: marks the headline that runs off the screen and writes a note.
  while (!atHome) await sleep(50);
  await sleep(900);
  caption('you', 'Point at what is wrong.');
  const mark = await box('topbar', '#annotate');
  await move(mark.x + mark.width / 2, mark.y + mark.height / 2, 1000);
  await click();
  control(`action ${shop.id} annotate true`);
  await sleep(500);
  const headline = await box('page', '.hero h1');
  const page = headline.view;
  const from = { x: headline.x - 10, y: headline.y - 10 };
  const to = { x: page.x + page.width - 4, y: headline.y + headline.height + 10 };
  // The overlay covers the page area; mouse coordinates are its own.
  const overlay = await bounds('annotator');
  const local = p => `${Math.round(p.x - overlay.x)} ${Math.round(p.y - overlay.y)}`;
  await move(from.x, from.y, 800);
  await sleep(150);
  clicks.push({ t: now(), ...pos });
  control(`usermouse annotator down ${local(from)}`);
  // The drag, in small steps like a hand.
  const dragMs = 900, steps = 18;
  track.push({ t: now(), ...pos });
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = k * k * (3 - 2 * k);
    pos = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    track.push({ t: now(), ...pos });
    control(`usermouse annotator move ${local(pos)}`);
    await sleep(dragMs / steps);
  }
  control(`usermouse annotator up ${local(to)}`);
  await sleep(500);
  // Typing: a few letters at a time, at a fast typist's pace.
  for (let i = 2; i <= NOTE.length + 1; i += 2) {
    await inView('annotator', `(() => { const t = document.getElementById('text'); t.value = ${JSON.stringify(NOTE)}.slice(0, ${i}); t.dispatchEvent(new Event('input')); return 1; })()`);
    await sleep(45);
  }
  await sleep(500);
  const send = await box('annotator', '#send');
  await move(send.x + send.width / 2, send.y + send.height / 2, 600);
  await click();
  await inView('annotator', `(() => { document.getElementById('send').click(); return 1; })()`);
  await sleep(300);
  // Out of the way, beside the phone.
  await move(page.x + page.width + 60, page.y + page.height * 0.85, 900);
  await agentRun;
  await sleep(2600);
  recording = false;
  await Promise.all(recorders);
  const end = now();
  log(`${frames.length} frames in ${end.toFixed(1)} s`);
  await Promise.race([Promise.all([agent, codex].map(x => x.close().catch(() => {}))), sleep(4000)]);
  site.close();
  inbox.close();
  return { frames, track, clicks, captions, pointerFrom, end };
}

// VIDEO_FROM=<folder of a KEEP_FRAMES run> renders that recording again, without a new one.
const from = process.env.VIDEO_FROM && path.resolve(process.env.VIDEO_FROM);
const scene = from ? JSON.parse(fs.readFileSync(path.join(from, 'scene.json'), 'utf8')) : await record();
const work = from ?? tmp;
if (!from) fs.writeFileSync(path.join(work, 'scene.json'), JSON.stringify(scene));
const { frames, track, clicks, captions, pointerFrom, end } = scene;

// MARK: Images for the overlays

// The video: the window, smaller, on the website's green, with rounded corners
// and a shadow. Captions float over its right edge, so they do not look like
// part of the app.
const OUT = { width: 1920, height: 1080 };
const WIN = { x: 120, y: 68, width: 1680, height: 945, radius: 15 };
// Captions: at most `width` wide, their right edge at `right`.
const CARD = { right: 1880, y: 230, width: 470, pad: 60 };
const INK = '#15231A', GREEN = '#2F6B3A', BG = '#EDF0E4';

frames.sort((a, b) => a.t - b.t);
// The pointer like macOS draws it (tip at 0, 0), a ring for clicks, the
// background, the window's shape and the captions. ffmpeg has no SVG decoder
// everywhere, so a canvas of the app draws them as PNG.
const scale = Number(execFileSync('sips', ['-g', 'pixelWidth', frames[0].file]).toString().match(/pixelWidth: (\d+)/)[1]) / W;
const savePng = (name, url) => fs.writeFileSync(path.join(work, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
const svgPng = async (name, size, svg) => savePng(name, await inView('sidebar', `new Promise(r => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size}; c.getContext('2d').drawImage(i, 0, 0, ${size}, ${size}); r(c.toDataURL('image/png')); }; i.src = 'data:image/svg+xml,' + encodeURIComponent(${JSON.stringify(svg)}); })`));
const canvasPng = async (name, width, height, draw) => {
  const url = await inView('sidebar', `(async () => {
    try {
      const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height};
      const g = c.getContext('2d');
      await (${draw})(g);
      return c.toDataURL('image/png');
    } catch (e) { return 'error: ' + e.message; }
  })()`);
  if (!url?.startsWith('data:')) throw new Error(`${name}: ${url}`);
  savePng(name, url);
};
const P = 28 * scale, R = 44 * scale;
await svgPng('pointer', P, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><path d="M2 1.5 V21 L6.8 16.6 L9.9 23.6 L13.2 22.2 L10.2 15.4 H16.6 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`);
await svgPng('ring', R, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="rgba(242,140,40,.25)" stroke="rgba(242,140,40,.9)" stroke-width="3"/></svg>`);
await canvasPng('background', OUT.width, OUT.height, `g => {
  g.fillStyle = '${BG}'; g.fillRect(0, 0, ${OUT.width}, ${OUT.height});
  g.shadowColor = 'rgba(21, 35, 26, .32)'; g.shadowBlur = 60; g.shadowOffsetY = 18;
  g.beginPath(); g.roundRect(${WIN.x}, ${WIN.y}, ${WIN.width}, ${WIN.height}, ${WIN.radius}); g.fill();
}`);
await canvasPng('mask', WIN.width, WIN.height, `g => {
  g.fillStyle = '#000'; g.fillRect(0, 0, ${WIN.width}, ${WIN.height});
  g.fillStyle = '#fff'; g.beginPath(); g.roundRect(0, 0, ${WIN.width}, ${WIN.height}, ${WIN.radius}); g.fill();
}`);
// The website's fonts (site/fonts), for the captions.
const font = (family, file) => `(async () => { const b = Uint8Array.from(atob('${fs.readFileSync(path.join(root, 'site/fonts', file)).toString('base64')}'), c => c.charCodeAt(0)); const f = new FontFace('${family}', b, { weight: '100 900' }); await f.load(); document.fonts.add(f); return 1; })()`;
await inView('sidebar', font('VideoSerif', 'fraunces-normal-300-latin.woff2'));
await inView('sidebar', font('VideoMono', 'courier-prime-normal-700-latin.woff2'));
// Captions: a light card with a shadow, a label for who acts and the text, wrapped;
// as wide as the text needs, at the right edge of the image. (No // comments in
// view scripts: they become one line.)
for (const [i, c] of captions.entries()) {
  const label = c.who === 'you' ? 'You' : 'Your agent';
  await canvasPng(`caption${i}`, CARD.width + 2 * CARD.pad, 400, `g => {
    const pad = ${CARD.pad}, w = ${CARD.width}, inner = 30;
    g.font = '560 33px VideoSerif';
    const lines = [];
    for (const word of ${JSON.stringify(c.text)}.split(' ')) {
      const last = lines.at(-1);
      if (last && g.measureText(last + ' ' + word).width <= w - 2 * inner) lines[lines.length - 1] = last + ' ' + word; else lines.push(word);
    }
    const h = 74 + lines.length * 40 + 8;
    const cw = Math.min(w, Math.max(...lines.map(l => g.measureText(l).width)) + 2 * inner + 4), x = pad + w - cw;
    g.save();
    g.shadowColor = 'rgba(21, 35, 26, .30)'; g.shadowBlur = 44; g.shadowOffsetY = 16;
    g.fillStyle = '#F6F7F0'; g.beginPath(); g.roundRect(x, pad, cw, h, 16); g.fill();
    g.restore();
    g.strokeStyle = '#C9D0BC'; g.lineWidth = 1; g.beginPath(); g.roundRect(x + .5, pad + .5, cw - 1, h - 1, 16); g.stroke();
    g.font = '700 15px VideoMono'; g.letterSpacing = '2px'; g.fillStyle = ${JSON.stringify(c.who === 'you' ? '#B4532A' : GREEN)};
    g.beginPath(); g.arc(x + inner + 5, pad + 38, 5, 0, 7); g.fill();
    g.fillText(${JSON.stringify(label.toUpperCase())}, x + inner + 18, pad + 43);
    g.letterSpacing = '0px'; g.font = '560 33px VideoSerif'; g.fillStyle = '${INK}';
    lines.forEach((l, k) => g.fillText(l, x + inner, pad + 92 + k * 40));
  }`);
}
log('overlays drawn');

if (app.exitCode === null) { app.kill(); await new Promise(r => app.once('exit', r)); }

// MARK: Video

const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? end) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
fs.writeFileSync(path.join(work, 'frames.txt'), `ffconcat version 1.0\n${list}`);

// Piecewise expressions over t; the latest segment is the outermost test.
const ease = (a, b, t1, t2) => `(${a}+(${b - a})*(3*pow((t-${t1})/${t2 - t1},2)-2*pow((t-${t1})/${t2 - t1},3)))`;
const axis = k => {
  let e = String(track[0][k] * scale);
  for (let i = 0; i < track.length; i++) {
    const p = track[i], q = track[i + 1];
    const v = p[k] * scale, t1 = p.t.toFixed(3);
    const seg = !q ? v : `if(lt(t,${q.t.toFixed(3)}),${q.t === p.t ? v : ease(v, q[k] * scale, t1, q.t.toFixed(3))},${q[k] * scale})`;
    e = `if(gte(t,${t1}),${seg},${e})`;
  }
  return e;
};
const ringOn = clicks.map(c => `between(t,${c.t.toFixed(3)},${(c.t + 0.35).toFixed(3)})`).join('+');
const ringAt = k => clicks.reduce((e, c) => `if(gte(t,${c.t.toFixed(3)}),${c[k] * scale - R / 2},${e})`, '0');
// Captions fade in while they rise a little; each one stays until the next.
const FADE = 0.35, RISE = 14;
const IMAGES = 5; // inputs before the captions: frames, pointer, ring, background, mask
const capFilters = captions.map((c, i) => {
  const a = c.t, b = captions[i + 1]?.t ?? end + 1;
  return `[${IMAGES + i}:v]format=rgba,fade=in:st=${a.toFixed(3)}:d=${FADE}:alpha=1,fade=out:st=${(b - FADE).toFixed(3)}:d=${FADE}:alpha=1[c${i}]`;
});
const capOverlays = captions.map((c, i) => `[${i ? `v${i}` : 'comp'}][c${i}]overlay=x=${CARD.right - CARD.width - CARD.pad}:y='${CARD.y - CARD.pad}+${RISE}*(1-min(1,max(0,(t-${c.t.toFixed(3)})/${FADE})))':shortest=1[v${i + 1}]`);
const filter = [
  `[0:v]fps=30,setsar=1[base]`,
  `[base][2:v]overlay=x='${ringAt('x')}':y='${ringAt('y')}':enable='${ringOn}':shortest=1[ringed]`,
  `[ringed][1:v]overlay=x='${axis('x')}-${2 * scale}':y='${axis('y')}-${1.5 * scale}':enable='gte(t,${pointerFrom.toFixed(3)})':shortest=1[pointed]`,
  `[pointed]scale=${WIN.width}:${WIN.height}:flags=lanczos,format=rgba[win0]`,
  `[4:v]format=gray[mask]`,
  `[win0][mask]alphamerge[win]`,
  `[3:v]format=rgba[bg]`,
  `[bg][win]overlay=${WIN.x}:${WIN.y}:shortest=1[comp]`,
  ...capFilters, ...capOverlays,
  `[v${captions.length}]format=yuv420p[out]`,
].join(';');
fs.writeFileSync(path.join(work, 'filter.txt'), filter);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
// Still images: as long as the recording, so no input runs on forever.
const still = file => ['-framerate', '30', '-loop', '1', '-t', (end + 0.5).toFixed(2), '-i', path.join(work, file)];
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'),
  ...still('pointer.png'), ...still('ring.png'), ...still('background.png'), ...still('mask.png'),
  ...captions.flatMap((_, i) => still(`caption${i}.png`)),
  '-/filter_complex', path.join(work, 'filter.txt'), '-map', '[out]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', outFile], { stdio: 'inherit' });
console.log('video', outFile);

// KEEP_FRAMES=1 keeps the frames, overlays and the filter (to render again with VIDEO_FROM).
if (process.env.KEEP_FRAMES && !from) console.log('frames', work);
else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(0);
