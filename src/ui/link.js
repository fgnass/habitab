const api = window.habitab;
const bubble = document.getElementById('bubble');

/** Like Chrome: readable (decoded) URL, without a plain https:// prefix. */
function pretty(url) {
  let text = url;
  try { text = decodeURI(url); } catch {}
  return text.replace(/^https:\/\//, '');
}

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  const target = s?.nav?.targetUrl ?? '';
  bubble.textContent = target ? pretty(target) : '';
  bubble.title = target;
  document.body.classList.toggle('right', !!state.linkRight);
});
