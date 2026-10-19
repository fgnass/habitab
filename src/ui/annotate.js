// Marking mode over the page: the user drags a rectangle and writes a
// comment. It goes to the agent as a note (sessions with a channel), otherwise
// to the clipboard. The overlay covers
// the page area; the page is `frame` in it (in responsive mode smaller, so the
// form can extend beside it). Marks stay in the frame and go out in page coordinates.
// How marking works shows in the status line, not over the page.
const api = window.habitab;
const $ = id => document.getElementById(id);
let start = null, rect = null;
let frame = null;
api.onAnnotateFrame(f => { frame = f; });
const page = () => frame ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
/** A point of the overlay, kept inside the page. */
const inPage = (x, y) => { const f = page(); return { x: clamp(x, f.x, f.x + f.width), y: clamp(y, f.y, f.y + f.height) }; };

let open = false;
api.onState(state => {
  // Leaving marking mode clears the overlay, so the next time starts fresh
  // (also without window focus, e.g. while the user is in another app).
  if (open && !state.annotating) reset();
  open = !!state.annotating;
  const s = state.sessions.find(x => x.id === state.selected);
  const channel = s?.push && s.phase !== 'ended' && s.phase !== 'kept';
  // Only say where it goes when it does not go straight to the agent.
  $('target').textContent = channel ? '' : 'Copied to the clipboard (this agent has no channel)';
  $('target').hidden = !!channel;
  $('sendText').textContent = channel ? 'Send' : 'Copy';
});

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
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
  endDictation(true);
  dictated = false;
  draw();
}

document.addEventListener('pointerdown', e => {
  if (e.target.closest?.('#form')) return;
  reset();
  start = inPage(e.clientX, e.clientY);
  draw();
  try { document.documentElement.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', e => {
  if (!start) return;
  const { x, y } = inPage(e.clientX, e.clientY);
  rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  draw();
});
document.addEventListener('pointerup', () => {
  if (!start) return;
  start = null;
  // A click without a drag marks the visible page.
  if (!rect || rect.width < 6 || rect.height < 6) rect = { ...page() };
  showForm();
});

// Context menu "Send Element to Agent…": the element comes already marked.
api.onAnnotateRect(r => { start = null; rect = { ...r, x: r.x + page().x, y: r.y + page().y }; showForm(); });

/** The mark in page coordinates (the page is `frame` in the overlay). */
const pageRect = () => { const f = page(); return { x: Math.round(rect.x - f.x), y: Math.round(rect.y - f.y), width: Math.round(rect.width), height: Math.round(rect.height) }; };

function showForm() {
  draw();
  // The picture is taken now: what the user sees goes out, also if the page changes while the comment is written.
  api.action('annotateMark', pageRect());
  const form = $('form');
  form.style.display = 'block';
  const w = form.offsetWidth, h = form.offsetHeight;
  const below = rect.y + rect.height + 8;
  form.style.left = clamp(rect.x, 8, innerWidth - w - 8) + 'px';
  form.style.top = (below + h < innerHeight ? below : Math.max(8, rect.y - h - 8)) + 'px';
  $('text').focus();
}

function submit() {
  if (!rect) return;
  endDictation(true);
  api.action('annotateSubmit', { rect: pageRect(), text: $('text').value.trim(), dictated });
  reset();
}
$('send').onclick = submit;
$('cancel').onclick = () => api.action('annotate', false);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if ($('form').style.display === 'block') reset(); else api.action('annotate', false); }
  // Enter sends, Shift+Enter makes a new line (not while an IME composes).
  if (e.key === 'Enter' && e.target === $('text') && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); submit(); }
});
// Opening the overlay starts fresh.
window.addEventListener('focus', () => { if (!rect) reset(); });

// MARK: Dictation (macOS: on-device speech recognition, see speech.ts)

// Hold the microphone button, or Space in the comment field, and talk; let go
// and the words stand in the field (the agent learns that they were dictated).
// With Space: the first press types its space, the repeats of the held key
// type nothing, and after a short while the space goes away and the
// recognition starts. A tap types a space as always.
const HOLD_MS = 250;
const text = $('text');
let spaceDown = null, dictation = null, dictated = false, stateTimer = null, ready = false;
const langName = code => { try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) ?? code; } catch { return code; } };

/** The language, its model (a missing one is downloaded now, not when the user talks) and the choices. */
async function prepare() {
  ready = false;
  document.body.classList.add('busy');
  let info;
  try { info = JSON.parse(await api.speech.prepare()); } catch { info = { status: 'unavailable', lang: '', languages: [] }; }
  document.body.classList.toggle('dictation', info.status !== 'unavailable' || info.languages.length > 0);
  const sel = $('lang');
  sel.replaceChildren(...info.languages.map(code => new Option(langName(code), code)));
  if (info.lang && !info.languages.includes(info.lang)) sel.append(new Option(langName(info.lang), info.lang));
  sel.value = info.lang;
  document.body.classList.remove('busy');
  ready = info.status === 'available';
  setState(ready ? '' : info.status === 'unavailable' ? `No speech model for ${langName(info.lang)}` : 'Speech model not ready');
}
$('lang').addEventListener('change', async () => {
  setState(`Getting the ${langName($('lang').value)} model…`);
  await api.speech.setLanguage($('lang').value);
  await prepare();
});
// A model may need a download: it runs when the overlay loads, so the first dictation does not wait.
prepare();

function setState(msg) {
  $('dictText').textContent = msg;
  clearTimeout(stateTimer);
}
/** A message for a few seconds, then back to the resting state. */
function notice(msg) {
  setState(msg);
  stateTimer = setTimeout(() => setState(''), 4000);
}

// The button: press and hold.
const mic = $('mic');
mic.addEventListener('pointerdown', e => {
  if (e.button !== 0 || dictation) return;
  e.preventDefault();
  try { mic.setPointerCapture(e.pointerId); } catch {}
  startDictation();
});
for (const type of ['pointerup', 'pointercancel']) mic.addEventListener(type, () => { if (dictation) endDictation(false); });
mic.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });

// Space in the field.
text.addEventListener('keydown', e => {
  if (e.key !== ' ' || e.isComposing || !document.body.classList.contains('dictation')) return;
  if (!e.repeat) { spaceDown = Date.now(); return; }
  e.preventDefault();
  if (!dictation && spaceDown !== null && Date.now() - spaceDown >= HOLD_MS) startDictation(true);
});
text.addEventListener('keyup', e => {
  if (e.key !== ' ') return;
  spaceDown = null;
  if (dictation) endDictation(false);
});
// A key or button release can get lost (the window loses focus): then the recognition ends too.
window.addEventListener('blur', () => { spaceDown = null; if (dictation) endDictation(false); });

function startDictation(bySpace = false) {
  if (!ready) { notice($('dictText').textContent || 'Speech model not ready'); return; }
  let v = text.value, pos = text.selectionStart;
  // The first press of Space typed its space; the words bring their own.
  if (bySpace && pos > 0 && v[pos - 1] === ' ') { v = v.slice(0, pos - 1) + v.slice(pos); pos--; }
  const d = dictation = { before: v.slice(0, pos), after: v.slice(pos), finals: [], interim: '', id: 0, stopping: false, heard: false };
  render(d);
  setState('Starting…');
  d.id = api.speech.start({ lang: '', interim: true }, ev => {
    if (dictation !== d) return;
    if (ev.type === 'started') setState('Listening… let go to stop');
    else if (ev.type === 'downloading') setState('Getting the speech model… talk when it listens');
    else if (ev.type === 'level') $('meter').firstElementChild.style.width = Math.round(ev.level * 100) + '%';
    else if (ev.type === 'result') {
      const t = ev.text.trim();
      if (t) d.heard = true;
      if (ev.final) { if (t) d.finals.push(t); d.interim = ''; } else d.interim = t;
      render(d);
    } else if (ev.type === 'error' && ev.error !== 'aborted') notice(DICTATION_ERRORS[ev.error] ?? `Dictation failed (${ev.error})`);
    else if (ev.type === 'end') {
      render(d);
      if (d.finals.length) dictated = true;
      dictation = null;
      document.body.classList.remove('listening');
      $('meter').firstElementChild.style.width = '0';
      if (d.heard) setState(''); else if (d.stopping) notice('Nothing heard');
      text.focus();
    }
  });
  document.body.classList.add('listening');
}

/** The words so far go where the cursor was; the cursor stays after them. */
function render(d) {
  const spoken = [...d.finals, d.interim].filter(Boolean).join(' ');
  const sep1 = spoken && d.before && !/\s$/.test(d.before) ? ' ' : '';
  const sep2 = spoken && d.after && !/^\s/.test(d.after) ? ' ' : '';
  text.value = d.before + sep1 + spoken + sep2 + d.after;
  const cursor = (d.before + sep1 + spoken).length;
  text.setSelectionRange(cursor, cursor);
}

/** Ends the recognition: the words so far become final (`discard`: nothing more arrives). */
function endDictation(discard) {
  if (!dictation || dictation.stopping) return;
  dictation.stopping = true;
  if (discard) { api.speech.abort(dictation.id); dictation = null; document.body.classList.remove('listening'); setState(''); }
  else { api.speech.stop(dictation.id); setState('Finishing…'); }
}

const DICTATION_ERRORS = {
  'not-allowed': 'macOS does not let Habitab use the microphone',
  'audio-capture': 'No microphone found',
  'no-speech': 'Nothing heard',
  'language-not-supported': 'No speech model for this language',
};
