// Status line under the top bar: always one line at the same place (a notice,
// the agent's current tool call, the session's state, its last call, or the
// first call of the chosen change). The button (⇧⌘Y) shows the thumbnails of
// the changes below it; an older change shows its screenshot over the page.
// Scripts, errors and further calls float in a panel the chip opens; nothing
// else moves. Agent summaries, page titles, URLs and errors are only ever set
// via textContent.
const api = window.habitab;
const $ = id => document.getElementById(id);
const { fmtTime: time, fmtDuration: duration, toolCalls: calls, timelineGroups } = window;
let last = null, shown = '', session = null;
const thumbs = new Map(); // "<session>/<shot>" -> data URL
const pending = new Set();
const cards = new Map(); // group id -> element

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A tool call as grid cells: time | name and short summary | duration (or its state while it runs). */
function callCells(x, state) {
  const n = el('div', 'n' + (x.isError ? ' failed' : ''));
  n.appendChild(el('b', '', toolLabel(x.tool)));
  const sum = toolSummary(x.tool, x.summary);
  if (sum) {
    n.appendChild(el('span', 's', ' · '));
    // A URL the agent opened: a link that opens it in the tab.
    const url = /^(https?|file):/i.test(x.summary ?? '') ? x.summary : null;
    const s = el('span', 's' + (url ? ' link' : ''), sum);
    if (url) { s.title = `Open ${url} in the tab`; s.onclick = () => api.action('timelineOpenUrl', url); }
    n.appendChild(s);
  }
  n.title = x.isError ? `${x.tool} (failed)` : x.tool;
  const d = state ? el('div', 'd ' + state, state === 'held' ? 'waiting' : 'running') : el('div', 'd', duration(x.durationMs));
  return [el('div', 't', time(x.start)), n, d];
}

/** A call in the line: time | name and summary (and "running" while it runs). */
function lineCells(x, state) {
  const [t, n] = callCells(x);
  return state ? [t, n, el('span', 'state ' + state, state === 'held' ? 'waiting' : 'running')] : [t, n];
}

/** What only the details show: the script, the error. */
function details(x) {
  const out = [];
  if (x.tool === 'evaluate_script' && x.summary) out.push(el('pre', '', x.summary));
  if (x.isError && x.detail) out.push(el('pre', 'err', x.detail));
  return out;
}

const wide = (text, cls = '') => el('div', `wide ${cls}`, text);

function stateText(s) {
  if (!s) return '';
  if (s.feedback) return `The agent waits for your feedback${s.feedback.question ? `: ${s.feedback.question}` : ''}`;
  if (s.held && !s.currentTool) return 'You have control: the agent’s next tool calls wait';
  return s.protectedBy ?? '';
}

api.onState(state => { last = state; render(); });

// The button keeps its place at the left end of the line; the chip follows the name.
const chip = el('button');
chip.id = 'chip';
chip.append(el('span'), window.icon('chevron-right'));
chip.onclick = () => { pop = !pop; render(); };
const toggle = el('button');
toggle.id = 'toggle';
toggle.title = 'Timeline: what the agent did, with screenshots (⇧⌘Y)';
toggle.appendChild(window.icon('history'));
toggle.onclick = () => api.action('timeline');
/** The floating details are open. */
let pop = false;

function render() {
  const state = last;
  if (!state) return;
  const s = state.sessions.find(x => x.id === state.selected);
  if ((s?.id ?? null) !== session) { session = s?.id ?? null; cards.clear(); pop = false; }
  const steps = s?.timeline ?? [];
  const groups = timelineGroups(steps);
  const open = !!state.timelineOpen;
  // The chosen change (its screenshot lies over the page), else live.
  const chosen = (state.timelinePreview && groups.find(g => g.id === state.timelineStep)) || null;
  const current = s?.currentTool;
  const latest = steps[steps.length - 1];
  // The change whose calls the details show: the chosen one, or the one of the last call.
  const group = chosen ?? (!current && latest ? groups.find(g => g.steps.includes(latest)) ?? null : null);
  const more = group ? group.steps.length - 1 : 0;
  const hasDetails = !!group && (more > 0 || group.steps.some(x => details(x).length));
  if (!hasDetails) pop = false;
  const key = JSON.stringify([open, pop, state.notice, chosen?.id, groups.map(g => [g.id, g.state, g.steps.length]), current, latest?.durationMs, stateText(s), s?.id, s?.held]);
  if (key === shown) return;
  shown = key;
  document.body.classList.toggle('open', open);
  document.body.classList.toggle('pop', pop);
  toggle.classList.toggle('on', open);

  // One line, always: the chosen change's first call, else what happens now.
  // No durations here: they are for looking back (details, screenshot).
  let cells;
  if (chosen) cells = lineCells(chosen.head);
  else if (state.notice) cells = [wide(state.notice, 'notice')];
  else if (current) cells = lineCells(current, s.held ? 'held' : 'running');
  else if (stateText(s)) cells = [wide(stateText(s))];
  else if (latest) cells = lineCells(latest);
  else cells = [wide(s ? 'No tool calls yet' : '', 'quiet')];
  chip.classList.toggle('show', hasDetails);
  chip.classList.toggle('on', pop);
  chip.firstChild.textContent = more ? `+${more}` : 'Details';
  chip.title = more ? `All ${calls(more + 1)} of this change, with scripts and errors` : 'Script and error of this call';
  $('line').replaceChildren(toggle, ...cells, chip);

  // The floating details: every call of the change, with its script and error.
  $('pop').replaceChildren(...(pop && group ? group.steps.flatMap(x => [...callCells(x), ...details(x)]) : []));
  if (open) renderStrip(groups, chosen, chosen ?? groups[groups.length - 1]);
  report();
}

/** Thumbnails of the changes; the chosen one (or, live, the newest) is marked. */
function renderStrip(groups, chosen, marked) {
  const strip = $('strip');
  const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 30;
  if (!groups.length) { strip.replaceChildren(el('div', 'strip-empty', 'No changes yet')); return; }
  const ids = new Set(groups.map(g => g.id));
  for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);
  const newest = groups[groups.length - 1];
  strip.replaceChildren(...groups.map(g => card(g, g === marked, g === newest, chosen)));
  if (atEnd && !chosen) strip.scrollLeft = strip.scrollWidth;
  loadThumbs(groups);
}

function card(g, sel, newest, chosen) {
  let c = cards.get(g.id);
  if (!c) {
    c = el('div', 'step');
    c.appendChild(el('div', 'thumb'));
    cards.set(g.id, c);
  }
  // The newest change is the live page; an older one opens its screenshot (again: back to live).
  c.onclick = () => api.action('timelinePreview', newest || chosen?.id === g.id ? null : g.id);
  c.className = 'step' + (sel ? ' sel' : '') + (g.errors.length ? ' error' : '');
  c.title = [
    `${toolText(g.head.tool, g.head.summary)} · ${time(g.head.start)}${g.errors.length ? ` · ${g.errors.length} failed` : ''}`, g.title, g.url,
    g.steps.length > 1 ? `Then ${calls(g.steps.length - 1)} without a further change` : '',
    newest ? 'The live page' : 'Click to see this screenshot',
  ].filter(Boolean).join('\n');
  const t = c.firstChild;
  const url = g.shot && thumbs.get(`${session}/${g.shot}`);
  const img = t.querySelector('img');
  if (url) {
    if (img?.src !== url) { const i = el('img'); i.alt = ''; i.src = url; t.replaceChildren(i); }
  } else if (!img || !g.shot) {
    t.replaceChildren();
  }
  return c;
}

/** Loads the small screenshots that are not cached yet, in one request. */
async function loadThumbs(groups) {
  const sid = session;
  const want = groups.filter(g => g.shot && !thumbs.has(`${sid}/${g.shot}`) && !pending.has(`${sid}/${g.shot}`));
  if (!want.length || !sid) return;
  for (const g of want) pending.add(`${sid}/${g.shot}`);
  const res = await api.action('timelineImages', sid, want.map(g => g.head.id), true);
  for (const g of want) {
    pending.delete(`${sid}/${g.shot}`);
    if (res?.[g.head.id]) thumbs.set(`${sid}/${g.shot}`, res[g.head.id]);
  }
  if (sid === session) { shown = ''; render(); }
}

// The app sizes the view to the panel (closed: one line; open: thumbnails and at most a few calls).
function report() { api.action('statusHeight', $('panel').offsetHeight + (pop ? $('pop').offsetHeight + 12 : 0)); }
new ResizeObserver(report).observe($('panel'));

document.addEventListener('keydown', e => {
  const state = last;
  if (e.key === 'Escape' && pop) { pop = false; render(); return; }
  if (!state?.timelineOpen) return;
  if (e.key === 'Escape') api.action(state.timelinePreview ? 'timelinePreview' : 'timeline', state.timelinePreview ? null : false);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const s = state.sessions.find(x => x.id === state.selected);
    const groups = timelineGroups(s?.timeline ?? []);
    const i = state.timelinePreview ? groups.findIndex(g => g.id === state.timelineStep) : groups.length - 1;
    const n = groups[i + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (n) api.action('timelinePreview', n === groups[groups.length - 1] ? null : n.id);
  }
});
// Vertical wheel scrolls the thumbnails sideways.
$('strip').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('strip').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
// A click next to the floating details closes them.
document.addEventListener('mousedown', e => { if (pop && !e.target.closest('#pop, #chip')) { pop = false; render(); } });
