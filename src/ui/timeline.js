// The screenshot of the timeline change the user opened (in the status bar),
// large over the page. Esc goes back to the live page.
const api = window.habitab;
const frame = document.getElementById('frame');
const large = new Map(); // "<session>/<shot>" -> data URL (the last few)
let token = 0;

function show(url, none) {
  if (!url) { const s = document.createElement('span'); s.className = 'none'; s.textContent = none; return frame.replaceChildren(s); }
  const img = frame.querySelector('img') ?? document.createElement('img');
  img.alt = '';
  if (img.src !== url) img.src = url;
  if (img.parentNode !== frame) frame.replaceChildren(img);
}

api.onState(async state => {
  if (!state.timelinePreview) return;
  const s = state.sessions.find(x => x.id === state.selected);
  const g = window.timelineGroups(s?.timeline ?? []).find(x => x.id === state.timelineStep);
  caption(g);
  if (!g?.shot) return show(null, g?.state === 'pending' ? 'Taking the screenshot…' : 'No screenshot: the agent had no tab');
  const key = `${s.id}/${g.shot}`;
  const mine = ++token;
  if (!large.has(key)) {
    const res = await api.action('timelineImages', s.id, [g.head.id], false);
    if (res?.[g.head.id]) large.set(key, res[g.head.id]);
    while (large.size > 12) large.delete(large.keys().next().value);
  }
  if (mine === token) show(large.get(key) ?? null, 'Loading…');
});

/** "Screenshot after New tab · 12:02:35 · 238 ms". */
function caption(g) {
  const c = document.getElementById('caption');
  if (!g) return c.replaceChildren();
  const b = document.createElement('b');
  b.textContent = `Screenshot after ${window.toolLabel(g.head.tool)}`;
  c.replaceChildren(b, document.createTextNode(` · ${[window.fmtTime(g.head.start), window.fmtDuration(g.head.durationMs)].filter(Boolean).join(' · ')}`));
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') api.action('timelinePreview', null); });
