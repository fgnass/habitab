// Session list: one card per session with a thumbnail of its active tab, in
// a stable order (when the session started). Older tabs sit at the bottom.
// Page titles and URLs come from websites: they are only ever set via
// textContent, never as HTML.
const api = window.habitab;
const list = document.getElementById('list');
const q = document.getElementById('q');
let state = { sessions: [], selected: null, now: Date.now(), sidebar: 'full' };
let olderOpen = false;
const thumbs = new Map(); // session id -> <img>, reused so images do not flicker

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

function matches(s, term) {
  if (!term) return true;
  const hay = [s.title, s.project, s.projectPath, s.client, ...s.tabs.flatMap(t => [t.title, t.url])];
  return hay.some(h => h && String(h).toLowerCase().includes(term));
}

// The session menu is a native menu, built by the app (x, y: where it opens).
const openMenu = (s, x, y) => api.action('sessionMenu', s.id, Math.round(x), Math.round(y));

function thumbView(s) {
  const box = el('div', 'thumb');
  const img = thumbs.get(s.id);
  if (img) box.appendChild(img);
  return box;
}

function statusText(s) {
  if (s.feedback) return 'Waiting for your feedback';
  if (s.feedbackQueued) return `${s.feedbackQueued} feedback${s.feedbackQueued > 1 ? 's' : ''} for the agent’s next call`;
  if (s.held) return s.currentTool ? `Waiting · ${s.currentTool.tool}` : 'You have control';
  if (s.currentTool) return `▶ ${s.currentTool.tool}`;
  if (s.phase === 'disconnected' || isEnded(s)) return PHASE[s.phase];
  return '';
}

function cardView(s) {
  const card = el('div', 'card' + (s.id === state.selected ? ' sel' : '') + (isEnded(s) ? ' ended' : ''));
  card.title = state.sidebar === 'compact' ? [s.title, statusText(s), s.project].filter(Boolean).join('\n') : '';
  card.onclick = () => api.action('select', s.id);
  card.oncontextmenu = e => { e.preventDefault(); openMenu(s, e.clientX, e.clientY); };
  card.appendChild(thumbView(s));
  const info = el('div', 'info');
  const title = el('div', 'title ellipsis', s.title);
  title.title = s.tabs.find(t => t.active)?.url ?? '';
  info.appendChild(title);
  const status = statusText(s);
  if (status) info.appendChild(el('div', 'status ellipsis' + (s.held ? ' held' : s.currentTool ? '' : ' quiet'), status));
  const meta = el('div', 'meta');
  const client = el('span', 'client');
  // Static SVG strings from client-icons.js, never page content.
  client.innerHTML = window.CLIENT_ICONS[s.client] ?? '';
  client.title = [window.CLIENT_NAMES[s.client] ?? s.clientName ?? 'Unknown client', s.clientVersion].filter(Boolean).join(' ');
  meta.appendChild(client);
  const project = el('span', 'project ellipsis', s.project);
  project.title = s.projectPath;
  meta.appendChild(project);
  if (s.persistentProfile) { const k = icon('database'); k.innerHTML += '<title>Persistent profile: cookies and storage of this project are kept on disk</title>'; meta.appendChild(k); }
  if (s.pinned) { const p = icon('pin'); p.innerHTML += '<title>Pinned: the browser stays after the session ends</title>'; meta.appendChild(p); }
  const more = el('button', 'more');
  more.appendChild(icon('ellipsis'));
  more.title = 'More';
  more.onclick = e => { e.stopPropagation(); const r = more.getBoundingClientRect(); openMenu(s, r.left, r.bottom + 2); };
  meta.appendChild(more);
  info.appendChild(meta);
  card.appendChild(info);
  return card;
}

function olderView(sessions) {
  const rows = sessions.flatMap(s => s.tabs.filter(t => !t.active).map(t => ({ s, t })));
  if (!rows.length) return null;
  const box = el('div', 'older' + (olderOpen ? ' open' : ''));
  const head = el('button');
  head.append(icon('chevron-right'), el('span', '', 'Older Tabs'), el('span', 'count', String(rows.length)));
  head.onclick = () => { olderOpen = !olderOpen; box.classList.toggle('open', olderOpen); };
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

function render() {
  document.body.classList.toggle('compact', state.sidebar === 'compact');
  const term = q.value.trim().toLowerCase();
  // Sessions without tabs have nothing to show.
  const withTabs = state.sessions.filter(s => s.tabs.length);
  const visible = withTabs.filter(s => matches(s, term));
  list.replaceChildren();
  if (!withTabs.length) {
    list.appendChild(el('div', 'empty', 'No open browsers. When Claude Code or Codex uses Chrome DevTools MCP through Habitab, its browser shows up here.'));
    return;
  }
  // Sessions keep the order in which they started.
  for (const s of visible) list.appendChild(cardView(s));
  const older = olderView(visible);
  if (older) list.appendChild(older);
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

api.onState(s => { state = s; renderErrors(); render(); });
api.onThumb((id, url) => {
  if (!url) thumbs.delete(id);
  else {
    const img = thumbs.get(id) ?? el('img');
    img.alt = '';
    img.src = url;
    thumbs.set(id, img);
  }
  render();
});
api.onFocusSearch(() => { q.focus(); q.select(); });
q.oninput = render;
document.getElementById('setup').onclick = () => api.action('setup');
