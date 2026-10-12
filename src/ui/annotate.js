// Marking mode over the page: the user drags a rectangle and writes a
// comment. It goes to an agent waiting in wait_for_user_feedback, otherwise
// it is kept for the next call (and copied to the clipboard). Coordinates are the page view's (the overlay covers it exactly).
const api = window.habitab;
const $ = id => document.getElementById(id);
let start = null, rect = null, waiting = null;

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  waiting = s?.feedback ?? null;
  $('hintText').replaceChildren();
  if (waiting) {
    const b = document.createElement('b');
    b.textContent = 'The agent asks: ';
    $('hintText').append(b, waiting.question || 'Mark an area and say what you mean.');
  } else {
    $('hintText').textContent = state.timelinePreview ? 'Mark an area of this earlier screenshot.' : 'Mark an area of the page.';
  }
  const channel = s?.push && s.phase !== 'ended' && s.phase !== 'kept';
  $('target').textContent = waiting ? 'Goes to the waiting agent' : channel ? 'Goes to the agent now' : 'Kept for the agent’s next feedback call, and copied';
  $('sendText').textContent = waiting || channel ? 'Send' : 'Save';
});

const clamp = (v, max) => Math.max(0, Math.min(max, v));
function draw() {
  const r = $('rect');
  r.style.display = rect ? 'block' : 'none';
  document.body.classList.toggle('has-rect', !!rect);
  if (!rect) return;
  Object.assign(r.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
}

function reset() {
  start = rect = null;
  $('form').style.display = 'none';
  $('text').value = '';
  draw();
}

document.addEventListener('pointerdown', e => {
  if (e.target.closest?.('#form, #hint')) return;
  reset();
  start = { x: e.clientX, y: e.clientY };
  try { document.documentElement.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', e => {
  if (!start) return;
  const x = clamp(e.clientX, innerWidth), y = clamp(e.clientY, innerHeight);
  rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  draw();
});
document.addEventListener('pointerup', () => {
  if (!start) return;
  start = null;
  // A click without a drag marks the visible page.
  if (!rect || rect.width < 6 || rect.height < 6) rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  showForm();
});

// Context menu "Send Element to Agent…": the element comes already marked.
api.onAnnotateRect(r => { start = null; rect = r; showForm(); });

function showForm() {
  draw();
  const form = $('form');
  form.style.display = 'block';
  const w = form.offsetWidth, h = form.offsetHeight;
  const below = rect.y + rect.height + 8;
  form.style.left = clamp(rect.x, innerWidth - w - 8) + 'px';
  form.style.top = (below + h < innerHeight ? below : Math.max(8, rect.y - h - 8)) + 'px';
  $('text').focus();
}

function submit() {
  if (!rect) return;
  api.action('annotateSubmit', { rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, text: $('text').value.trim() });
  reset();
}
$('send').onclick = submit;
$('cancel').onclick = () => api.action('annotate', false);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if ($('form').style.display === 'block') reset(); else api.action('annotate', false); }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
});
// Opening the overlay starts fresh.
window.addEventListener('focus', () => { if (!rect) reset(); });
