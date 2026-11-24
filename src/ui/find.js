const api = window.habitab;
const $ = id => document.getElementById(id);
const q = $('q');

// The field has the keyboard focus; the search runs in the page (main process).
q.addEventListener('input', () => api.action('findInput', q.value));
q.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Enter') { e.preventDefault(); if (q.value) api.action('findStep', !e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); api.action('findClose'); }
});
// ⌘F: focus the field and select its text; `text` (the page's selection) replaces it first.
api.onFocusFind(text => {
  if (typeof text === 'string') q.value = text;
  q.focus();
  q.select();
});

// A click on a button or on the bar keeps the focus in the field.
$('bar').addEventListener('mousedown', e => { if (e.target !== q) { e.preventDefault(); q.focus(); } });
$('prev').onclick = () => api.action('findStep', false);
$('next').onclick = () => api.action('findStep', true);
$('close').onclick = () => api.action('findClose');

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  // Closed: the next search starts empty.
  if (state.findText === null) { q.value = ''; return; }
  const text = q.value;
  const r = s?.nav?.find ?? null;
  const count = $('count');
  count.textContent = !text ? '' : r ? `${r.active}/${r.matches}` : '0/0';
  count.classList.toggle('none', !!text && (!r || !r.matches));
  const none = !text || !r?.matches;
  $('prev').disabled = none;
  $('next').disabled = none;
});
