// Tab list: one card per active tab, with a thumbnail. Sessions keep a stable
// order (when they started), and the tabs of a session follow each other.
// Inactive tabs (not used for a while, see isActiveTab) sit at the bottom.
// Page titles and URLs come from websites: they are only ever set via
// textContent, never as HTML.
const api = window.habitab;
const list = document.getElementById('list');
const q = document.getElementById('q');
let state = { sessions: [], selected: null, now: Date.now(), sidebar: 'full' };
let inactiveOpen = false;
const thumbs = new Map(); // tab id -> <img>, reused so images do not flicker

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const icon = window.icon; // icons.js (Lucide)

const PHASE = {
  connected: 'Connected', tool: 'Tool running', idle: 'Idle',
  disconnected: 'Connection to the app lost', ended: 'Ended', kept: 'Ended · browser open',
};
const isEnded = s => s.phase === 'ended' || s.phase === 'kept';

function matches(s, t, term) {
  if (!term) return true;
  const hay = [s.project, s.projectPath, s.client, t.title, t.url];
  return hay.some(h => h && String(h).toLowerCase().includes(term));
}

// The card menu (tab and session) is a native menu, built by the app (x, y: where it opens).
const openMenu = (s, t, x, y) => api.action('sessionMenu', s.id, Math.round(x), Math.round(y), t?.id);

function thumbView(s, t) {
  const box = el('div', 'thumb');
  const img = thumbs.get(t.id);
  if (img) box.appendChild(img);
  // Thumbnails only: the mark of the user's own tab sits on the thumbnail.
  if (t.own && state.sidebar === 'compact') box.appendChild(el('span', 'own badge')).appendChild(icon('user'));
  return box;
}

function statusText(s) {
  if (s.waiting) return s.currentTool ? `Waiting · ${toolLabel(s.currentTool.tool)}` : 'Agent waiting for you';
  if (s.held) return 'You have control';
  if (s.currentTool) return `▶ ${toolText(s.currentTool.tool, s.currentTool.summary)}`;
  if (s.phase === 'disconnected' || isEnded(s)) return PHASE[s.phase];
  if (s.legacy) return 'Old launcher: restart the agent’s MCP server';
  return '';
}

// Like the session title (ui-state.ts), but for one tab.
const tabTitle = (s, t) => (!t.isBlank && (t.title || t.url)) || s.project || 'New Session';

function cardView(s, t) {
  const card = el('div', 'card' + (s.id === state.selected && t.active ? ' sel' : '') + (isEnded(s) ? ' ended' : ''));
  // The session's status shows on one card only: the tab the agent works with.
  const status = t.id === s.statusTab ? statusText(s) : '';
  card.title = state.sidebar === 'compact' ? [tabTitle(s, t), status, t.own && 'Your own tab', s.project].filter(Boolean).join('\n') : '';
  card.onclick = () => api.action('select', s.id, t.id);
  card.oncontextmenu = e => { e.preventDefault(); openMenu(s, t, e.clientX, e.clientY); };
  card.appendChild(thumbView(s, t));
  const info = el('div', 'info');
  const title = el('div', 'title ellipsis', tabTitle(s, t));
  title.title = t.url;
  info.appendChild(title);
  if (status) info.appendChild(el('div', 'status ellipsis' + (s.held ? ' held' : s.currentTool ? '' : ' quiet'), status));
  // Only what belongs to the tab; the session's things are in its header.
  const meta = el('div', 'meta');
  meta.appendChild(el('span', 'host ellipsis', t.isBlank ? '' : host(t.url)));
  if (t.own) meta.appendChild(titled(icon('user'), 'Your own tab: the agent goes on while you use it'));
  if (t.debuggerPaused) meta.appendChild(titled(icon('bug-off'), "Debugger paused: the agent's debugger is off in this tab until the agent works in it again"));
  info.appendChild(meta);
  card.appendChild(info);
  return card;
}

const host = url => { try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); } catch { return url; } };
function titled(svg, text) { const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = text; svg.appendChild(t); return svg; }

/**
 * A session: a quiet header (client, project, state, the session's options)
 * and its tabs below it. Thumbnails only: the header is a thin line.
 */
function sessionView(s, tabs) {
  const box = el('section', 'session' + (isEnded(s) ? ' ended' : '') + (s.id === state.selected ? ' current' : ''));
  const head = el('div', 'head');
  head.oncontextmenu = e => { e.preventDefault(); openMenu(s, null, e.clientX, e.clientY); };
  const client = el('span', 'client');
  // Static SVG strings from client-icons.js, never page content.
  client.innerHTML = window.CLIENT_ICONS[s.client] ?? '';
  client.title = window.CLIENT_NAMES[s.client] ?? 'Unknown client';
  const project = el('span', 'project ellipsis', s.project);
  project.title = s.projectPath;
  const dot = el('span', 'dot ' + (s.held ? 'held' : s.phase));
  dot.title = s.held ? 'You have control' : PHASE[s.phase];
  head.append(client, project, dot);
  const flags = el('span', 'flags');
  if (s.persistentProfile) flags.appendChild(titled(icon('database'), 'Persistent profile: cookies and storage of this project are kept on disk'));
  if (s.muted) flags.appendChild(titled(icon('volume-x'), 'Muted: all tabs of this session are silenced, also new ones'));
  if (s.pinned) flags.appendChild(titled(icon('pin'), 'Pinned: the browser stays after the session ends'));
  const more = el('button', 'more');
  more.appendChild(icon('ellipsis'));
  more.title = 'Session options';
  more.onclick = e => { e.stopPropagation(); const r = more.getBoundingClientRect(); openMenu(s, null, r.left, r.bottom + 2); };
  head.append(flags, more);
  box.appendChild(head);
  for (const t of tabs) box.appendChild(cardView(s, t));
  return box;
}

function inactiveView(rows) {
  if (!rows.length) return null;
  const box = el('div', 'inactive' + (inactiveOpen ? ' open' : ''));
  const head = el('button');
  head.append(icon('chevron-right'), el('span', '', 'Inactive Tabs'), el('span', 'count', String(rows.length)));
  head.onclick = () => { inactiveOpen = !inactiveOpen; box.classList.toggle('open', inactiveOpen); rendered = renderKey(); };
  box.appendChild(head);
  const list = el('div', 'rows');
  for (const { s, t } of rows) {
    const row = el('div', 'tab');
    row.title = t.url;
    row.append(el('span', 't ellipsis', t.title || (t.isBlank ? 'Blank page' : t.url)), el('span', 'p ellipsis', s.project));
    const x = el('button', 'x');
    x.appendChild(icon('x', 'small'));
    x.title = 'Close tab';
    x.onclick = e => { e.stopPropagation(); api.action('closeTab', s.id, t.id); };
    row.appendChild(x);
    row.onclick = () => api.action('select', s.id, t.id);
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

/** What the list shows: the same input builds the same list, so it is left alone (open tooltips stay). */
let rendered = '';
function renderKey() {
  const fields = ['id', 'project', 'projectPath', 'client', 'persistentProfile', 'muted', 'pinned', 'phase', 'held', 'waiting', 'currentTool', 'statusTab', 'tabs'];
  return JSON.stringify([state.selected, state.sidebar, q.value, inactiveOpen, [...thumbs.keys()], state.sessions.map(s => fields.map(f => s[f]))]);
}

function render() {
  const k = renderKey();
  if (k === rendered) return;
  rendered = k;
  document.body.classList.toggle('compact', state.sidebar === 'compact');
  const term = q.value.trim().toLowerCase();
  // Sessions without tabs have nothing to show.
  const withTabs = state.sessions.filter(s => s.tabs.length);
  const rows = withTabs.flatMap(s => s.tabs.filter(t => matches(s, t, term)).map(t => ({ s, t })));
  list.replaceChildren();
  if (!withTabs.length) {
    list.appendChild(el('div', 'empty', 'No open browsers. When Claude Code or Codex uses Chrome DevTools MCP through Habitab, its browser shows up here.'));
    return;
  }
  // Sessions keep the order in which they started; their active tabs follow their header.
  for (const s of withTabs) {
    const tabs = rows.filter(r => r.s === s && !r.t.inactive).map(r => r.t);
    if (tabs.length) list.appendChild(sessionView(s, tabs));
  }
  const inactive = inactiveView(rows.filter(r => r.t.inactive));
  if (inactive) list.appendChild(inactive);
}

function renderErrors() {
  const box = document.getElementById('errors');
  const errs = state.errors ?? [];
  box.classList.toggle('show', errs.length > 0);
  box.replaceChildren();
  if (!errs.length) return;
  const row = el('div', 'row');
  row.appendChild(el('span', 'ellipsis', `Internal error: ${errs[errs.length - 1].message}`));
  row.lastChild.style.flex = '1';
  const log = el('button', '', 'Log');
  log.onclick = () => api.action('openLog');
  const x = el('button');
  x.appendChild(icon('x', 'small'));
  x.title = 'Dismiss';
  x.onclick = () => api.action('dismissErrors');
  row.append(log, x);
  box.appendChild(row);
}

api.onState(s => {
  state = s;
  // Forget the thumbnails of closed tabs.
  const ids = new Set(s.sessions.flatMap(x => x.tabs.map(t => t.id)));
  for (const id of thumbs.keys()) if (!ids.has(id)) thumbs.delete(id);
  renderErrors();
  render();
});
api.onThumb((id, url) => {
  const known = thumbs.get(id);
  if (!url) thumbs.delete(id);
  else {
    const img = known ?? el('img');
    img.alt = '';
    img.src = url;
    thumbs.set(id, img);
  }
  // A new image of a shown thumbnail needs no new list (that would also hide an open tooltip).
  if (!known || !url) render();
});
api.onFocusSearch(() => { q.focus(); q.select(); });
q.oninput = render;
document.getElementById('setup').onclick = () => api.action('setup');
