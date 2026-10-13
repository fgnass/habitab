const api = window.habitab;
const $ = id => document.getElementById(id);

// Display-only: the page keeps keyboard focus (Chromium only searches a focused
// page), so the query is typed into the page and shown here. Buttons act via the
// main process, which returns focus to the page.
$('prev').onclick = () => api.action('findStep', false);
$('next').onclick = () => api.action('findStep', true);
$('close').onclick = () => api.action('findClose');

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  const q = state.findText ?? '';
  const r = s?.nav?.find ?? null;
  $('q').textContent = q;
  $('q').classList.toggle('empty', !q);
  if (!q) $('q').textContent = 'Find in page';
  const count = $('count');
  count.textContent = !q ? '' : r ? `${r.active}/${r.matches}` : '0/0';
  count.classList.toggle('none', !!q && (!r || !r.matches));
  const none = !q || !r?.matches;
  $('prev').disabled = none;
  $('next').disabled = none;
});
