const api = window.habitab;
const $ = id => document.getElementById(id);

const SOURCES = {
  env: 'CLAUDE_CODE_SESSION_ID',
  'claude-sessions-file': 'Claude Code process file (unofficial)',
  'mcp-meta-threadId': '_meta.threadId of tool calls',
  'mcp-meta-sessionId': '_meta.sessionId of tool calls',
};

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  document.body.classList.toggle('framed', !!s?.nav?.emulation);
  const meta = $('meta');
  meta.replaceChildren();
  $('b').style.display = 'none';
  const withTabs = state.sessions.filter(x => x.tabs.length);
  document.body.classList.toggle('sessions', !s && withTabs.length > 0);
  if (!s) {
    $('h').textContent = 'Habitab';
    $('b').style.display = '';
    $('b').onclick = () => api.action('setup');
    if (!withTabs.length) {
      $('p').textContent = 'The browsers of your agent sessions show up here. First, take over the Chrome DevTools MCP entries of Claude Code and Codex.';
      $('b').textContent = 'Open Setup';
      $('b').className = 'primary';
      return;
    }
    // Sessions are there: a summary and the shortcuts; the setup as a quiet link.
    const tabs = withTabs.reduce((n, x) => n + x.tabs.length, 0);
    const problems = withTabs.reduce((n, x) => n + x.tabs.reduce((m, t) => m + (t.problems ?? 0), 0), 0);
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    $('p').textContent = `${count(withTabs.length, 'session')} · ${count(tabs, 'tab')}${problems ? ` · ${count(problems, 'problem')}` : ''}. Pick a tab on the left.`;
    $('b').textContent = 'Setup…';
    $('b').className = 'quiet';
    return;
  }
  $('b').className = 'primary';
  const ended = s.phase === 'ended' || s.phase === 'kept';
  $('h').textContent = s.title;
  $('p').textContent = ended
    ? 'This session has ended. Its browser was closed and its data deleted.'
    : 'The browser opens as soon as the agent first needs it.';
  const rows = [
    ['Project', s.projectPath],
    ['Client', (window.CLIENT_NAMES ?? {})[s.client] ?? s.client ?? 'not reported'],
    ['Agent-Session', s.agentSessionId ? `${s.agentSessionId} (${SOURCES[s.agentSessionSource] ?? s.agentSessionSource})` : 'not reported'],
    ['Habitab-Session', s.id],
  ];
  if (s.endReason) rows.push(['End', s.endReason]);
  for (const [k, v] of rows) {
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('span'); b.textContent = v;
    meta.append(a, b);
  }
});

// Resize handles of responsive mode: right edge, bottom edge, corner. The page
// is centered, so the right edge moves by half of a width change.
let emu = null, frame = null, drag = null, pending = null;
api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  const f = s?.nav?.frame;
  $('edge').classList.toggle('on', !!f);
  if (f) Object.assign($('edge').style, { left: f.x + 'px', top: f.y + 'px', width: f.width + 'px', height: f.height + 'px' });
  emu = s?.nav?.emulation?.by === 'user' ? s.nav.emulation : null;
  frame = emu ? s.nav.frame : null;
  document.body.classList.toggle('resizable', !!frame);
  if (!frame) return;
  const place = (id, x, y) => Object.assign($(id).style, { left: x + 'px', top: y + 'px' });
  place('hRight', frame.x + frame.width + 6, frame.y + frame.height / 2 - 22);
  place('hBottom', frame.x + frame.width / 2 - 22, frame.y + frame.height + 6);
  place('hCorner', frame.x + frame.width + 4, frame.y + frame.height + 4);
});

for (const [id, dims] of [['hRight', 'w'], ['hBottom', 'h'], ['hCorner', 'wh']]) {
  const el = $(id);
  el.addEventListener('pointerdown', e => {
    if (!emu || !frame) return;
    drag = { el, dims, x: e.clientX, y: e.clientY, width: emu.width, height: emu.height, scale: frame.scale };
    el.classList.add('drag');
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  el.addEventListener('dblclick', () => api.action('emulate', { preset: 'responsive', ...(dims.includes('w') ? { fillWidth: true } : {}), ...(dims.includes('h') ? { fillHeight: true } : {}) }));
}
// On the document: the handle moves with the page while it is dragged.
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const patch = { preset: 'responsive' };
  if (drag.dims.includes('w')) patch.width = drag.width + (2 * (e.clientX - drag.x)) / drag.scale;
  if (drag.dims.includes('h')) patch.height = drag.height + (e.clientY - drag.y) / drag.scale;
  // At most one change per frame time; a timer also runs while the window does not paint.
  if (!pending) setTimeout(() => { api.action('emulate', pending); pending = null; }, 16);
  pending = patch;
});
const endDrag = () => { drag?.el.classList.remove('drag'); drag = null; };
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
