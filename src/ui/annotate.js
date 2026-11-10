// Marking mode over the page: the user drags a rectangle and writes a
// comment. It goes to the agent as a note (sessions with a channel), otherwise
// to the clipboard. With Add (or a new drag after a comment) the note stays on
// the page with its number, and the next area can be marked: all notes go out
// together, as one message. The overlay covers
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
/** The kept notes ({ id, rect, text, dictated }), in their order; `current` is the one in the form (a new one, or a kept one opened again). */
let notes = [], current = null, nextId = 1;
let channel = false;

let open = false;
api.onState(state => {
  // Leaving marking mode clears the overlay, so the next time starts fresh
  // (also without window focus, e.g. while the user is in another app).
  if (open && !state.annotating) reset();
  open = !!state.annotating;
  const s = state.sessions.find(x => x.id === state.selected);
  channel = !!(s?.push && s.phase !== 'ended' && s.phase !== 'kept');
  // Only say where it goes when it does not go straight to the agent.
  $('target').textContent = channel ? '' : 'No channel: goes to the clipboard';
  $('target').title = channel ? '' : 'This agent has no channel for feedback: the notes are copied to the clipboard';
  buttons();
});

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
function draw() {
  const r = $('rect');
  r.style.display = rect ? 'block' : 'none';
  document.body.classList.toggle('has-rect', !!rect);
  if (rect) Object.assign(r.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  // The kept notes with their numbers (a click on the number opens the note); the one in the form is the rectangle above.
  $('notes').replaceChildren(...notes.flatMap((n, i) => {
    if (n === current) return [];
    const box = document.createElement('div');
    box.className = 'note';
    Object.assign(box.style, { left: n.rect.x + 'px', top: n.rect.y + 'px', width: n.rect.width + 'px', height: n.rect.height + 'px' });
    const num = document.createElement('button');
    num.className = 'num';
    num.textContent = i + 1;
    num.dataset.i = i;
    num.title = n.text || 'No comment';
    box.append(num);
    return [box];
  }));
}

/** Labels that follow the number of notes: Send 3, and Remove in place of Cancel when other notes stay. */
function buttons() {
  const n = notes.length + (current && !notes.includes(current) ? 1 : 0);
  $('sendText').textContent = (channel ? 'Send' : 'Copy') + (n > 1 ? ` ${n}` : '');
  const others = notes.filter(x => x !== current).length;
  $('cancel').textContent = others ? 'Remove' : 'Cancel';
  $('cancel').title = others ? 'Remove this note (the others stay)' : 'Stop marking (Esc)';
}

/** The main process knows how many notes are kept (the status line offers to send them). */
let reported = 0;
function report() {
  if (notes.length === reported) return;
  reported = notes.length;
  api.action('annotateKept', reported);
}

/** Closes the form; the note in it is kept or dropped before. */
function closeForm() {
  current = rect = null;
  $('form').style.display = 'none';
  $('text').value = '';
  endDictation(true);
  dictated = false;
  draw();
  buttons();
  report();
}

/** Back to the start: no notes, no form. */
function reset() {
  start = null;
  notes = [];
  closeForm();
}

/** The note in the form stays on the page (with its comment). */
function keep() {
  if (!current) return;
  endDictation(true);
  current.text = $('text').value.trim();
  current.dictated = dictated;
  if (!notes.includes(current)) notes.push(current);
  closeForm();
}

/** The note in the form goes away (a kept one too). */
function drop() {
  if (!current) return;
  notes = notes.filter(n => n !== current);
  api.action('annotateDrop', current.id);
  closeForm();
}

/** Before the next mark: a comment (or a note kept before) stays, an empty new mark goes. */
function settle() {
  if (current && ($('text').value.trim() || notes.includes(current))) keep();
  else drop();
}

document.addEventListener('pointerdown', e => {
  if (e.target.closest?.('#form')) return;
  const num = e.target.closest?.('.note .num');
  if (num) { e.preventDefault(); edit(notes[+num.dataset.i]); return; }
  settle();
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
  showForm(true);
});

// Context menu "Send Element to Agent…": the element comes already marked.
api.onAnnotateRect(r => { settle(); start = null; rect = { ...r, x: r.x + page().x, y: r.y + page().y }; showForm(true); });
// The status line's Send.
api.onAnnotateSend(() => submit());

/** A rectangle of the overlay in page coordinates (the page is `frame` in the overlay). */
const pageRect = r => { const f = page(); return { x: Math.round(r.x - f.x), y: Math.round(r.y - f.y), width: Math.round(r.width), height: Math.round(r.height) }; };

/** A kept note into the form again: its comment can change, or it can go. */
function edit(n) {
  if (!n || n === current) return;
  settle();
  current = n;
  rect = n.rect;
  $('text').value = n.text;
  dictated = n.dictated;
  showForm(false);
}

function showForm(isNew) {
  if (isNew) {
    current = { id: nextId++, rect, text: '', dictated: false };
    // The picture is taken now: what the user sees goes out, also if the page changes while the comment is written.
    api.action('annotateMark', { id: current.id, rect: pageRect(rect) });
  }
  draw();
  buttons();
  const form = $('form');
  form.style.display = 'block';
  const w = form.offsetWidth, h = form.offsetHeight;
  const below = rect.y + rect.height + 8;
  form.style.left = clamp(rect.x, 8, innerWidth - w - 8) + 'px';
  form.style.top = (below + h < innerHeight ? below : Math.max(8, rect.y - h - 8)) + 'px';
  $('text').focus();
}

/** All notes, the one in the form too, go out as one message. */
function submit() {
  if (current) keep();
  if (!notes.length) return;
  api.action('annotateSubmit', { notes: notes.map(n => ({ id: n.id, rect: pageRect(n.rect), text: n.text, dictated: n.dictated })) });
  reset();
}
$('send').onclick = submit;
$('add').onclick = keep;
$('cancel').onclick = () => { if (notes.some(n => n !== current)) drop(); else api.action('annotate', false); };
document.addEventListener('keydown', e => {
  const formOpen = $('form').style.display === 'block';
  if (e.key === 'Escape') {
    // A kept note stays as it was; a new one goes. Without the form: marking ends (the notes too).
    if (!formOpen) api.action('annotate', false);
    else if (notes.includes(current)) closeForm();
    else drop();
  }
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
  // In the field: Enter sends all, ⌘Enter keeps the note for more (Shift+Enter makes a new line).
  // Without the form, Enter sends the kept notes.
  if (formOpen && e.target !== $('text')) return;
  e.preventDefault();
  if (formOpen && (e.metaKey || e.ctrlKey)) keep();
  else submit();
});
// Opening the overlay starts fresh.
window.addEventListener('focus', () => { if (!rect && !notes.length) reset(); });

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
// A lost capture is a lost release too (e.g. a dialog of macOS took the pointer).
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) mic.addEventListener(type, () => { if (dictation) endDictation(false); });
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

/**
 * Ends the recognition: the words so far become final. `discard` (the form
 * closes): it ends now, also while a stop still waits for the last words.
 */
function endDictation(discard) {
  const d = dictation;
  if (!d) return;
  if (discard) {
    api.speech.abort(d.id);
    dictation = null;
    document.body.classList.remove('listening');
    $('meter').firstElementChild.style.width = '0';
    setState('');
    return;
  }
  if (d.stopping) return;
  d.stopping = true;
  api.speech.stop(d.id);
  setState('Finishing…');
}

const DICTATION_ERRORS = {
  'not-allowed': 'macOS does not let Habitab use the microphone',
  'audio-capture': 'No microphone found',
  'no-speech': 'Nothing heard',
  'language-not-supported': 'No speech model for this language',
};
