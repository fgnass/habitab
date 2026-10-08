// Drag handle between page and DevTools. Reports screen x positions to the app.
const api = window.habitab;
let dragging = false, pending;

document.addEventListener('pointerdown', e => {
  dragging = true;
  document.body.classList.add('drag');
  document.documentElement.setPointerCapture(e.pointerId);
  api.action('split', 'start');
});
document.addEventListener('pointermove', e => {
  if (!dragging) return;
  if (pending === undefined) setTimeout(() => { api.action('split', 'move', pending); pending = undefined; }, 16);
  pending = e.screenX;
});
const end = () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('drag');
  api.action('split', 'end');
};
document.addEventListener('pointerup', end);
document.addEventListener('pointercancel', end);
