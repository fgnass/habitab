// Problem list of the front tab: console errors and failed requests. Each one,
// or all, can go to the agent like a marked area. Texts come from the page:
// they are only ever set via textContent.
const api = window.habitab;
const $ = id => document.getElementById(id);
let shown = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ago(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** Shorter sources: a script URL of the page's own origin without it. */
function shortSource(p, pageUrl) {
  if (!p.source) return '';
  try { const origin = new URL(pageUrl).origin; return p.source.startsWith(origin) ? p.source.slice(origin.length) : p.source; } catch { return p.source; }
}

function row(p, pageUrl, now) {
  const r = el('div', 'row');
  r.appendChild(window.icon(p.kind === 'console' ? 'terminal' : 'globe'));
  const body = el('div', 'body');
  body.appendChild(el('div', 'text', p.text));
  const sub = el('div', 'sub');
  if (p.count > 1) sub.appendChild(el('span', 'times', `${p.count}×`));
  const src = el('span', 'src ellipsis', [p.kind === 'console' ? 'Console' : 'Network', shortSource(p, pageUrl)].filter(Boolean).join(' · '));
  src.title = p.source ?? '';
  sub.append(src, el('span', '', '· ' + ago(p.at, now)));
  body.appendChild(sub);
  r.appendChild(body);
  const send = el('button', 'send');
  send.appendChild(window.icon('send', 'small'));
  send.title = 'Send this one to the agent';
  send.onclick = () => api.action('problemsSend', [p.id]);
  r.appendChild(send);
  return r;
}

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  const list = s?.nav?.problems ?? [];
  // Render only on change: the user may be selecting text in the list.
  const key = JSON.stringify([list.map(p => [p.id, p.count]), s?.feedback ? 1 : 0, s?.push, s?.phase]);
  if (key === shown) return;
  shown = key;
  $('count').textContent = list.length ? String(list.length) : '';
  $('sendAll').disabled = !list.length;
  $('clear').disabled = !list.length;
  $('list').replaceChildren(...(list.length ? [...list].reverse().map(p => row(p, s.nav.url, state.now)) : [el('div', 'empty', 'No console errors or failed requests on this page.')]));
  const live = s && s.phase !== 'ended' && s.phase !== 'kept';
  $('target').textContent = s?.feedback ? 'Goes to the waiting agent.' : live && s.push ? 'Goes to the agent now.' : 'Kept for the agent’s next feedback call.';
  report();
});

// The app sizes the view to the list (it is capped to the free space).
function report() {
  const panel = $('panel');
  const natural = panel.offsetHeight - $('list').clientHeight + $('list').scrollHeight;
  api.action('problemsHeight', natural + 22);
}
new ResizeObserver(report).observe($('panel'));

$('sendAll').onclick = () => api.action('problemsSend');
$('clear').onclick = () => api.action('problemsClear');
document.addEventListener('keydown', e => { if (e.key === 'Escape') api.action('problems', null, null, false); });
