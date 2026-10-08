const api = window.habitab;
const $ = id => document.getElementById(id);
const url = $('url');
let editing = false;
let resumeAt = 0, resumeTotal = 0, countdown;

const PHASE = {
  connected: 'Connected', tool: 'Tool running', idle: 'Idle',
  disconnected: 'Connection lost', ended: 'Connection ended', kept: 'Ended · browser open',
};

api.onState(state => {
  document.body.classList.toggle('no-sidebar', state.sidebar === 'hidden');
  $('sidebar').classList.toggle('on', state.sidebar !== 'full');
  const s = state.sessions.find(x => x.id === state.selected);
  const nav = s?.nav;
  $('back').disabled = !nav?.canGoBack;
  $('forward').disabled = !nav?.canGoForward;
  $('reload').disabled = !nav;
  url.disabled = !nav;
  if (!editing) url.value = nav && nav.url !== 'about:blank' ? nav.url : '';
  $('reload').title = nav?.loading ? 'Stop loading' : 'Reload (⌘R)';
  $('reload').dataset.loading = nav?.loading ? '1' : '';
  const size = nav?.fixedSize;
  $('size').classList.toggle('hidden', !size);
  if (size) $('sizeText').textContent = `${size.width}×${size.height}`;
  $('dot').className = 'dot ' + (s?.phase ?? 'idle');
  const tool = s?.currentTool;
  $('chip').className = 'chip' + (tool ? ' tool' : '');
  $('status').textContent = state.notice ? state.notice : !s ? '' : s.feedback ? 'Waiting for your feedback' : tool ? `${s.held ? 'Waiting · ' : ''}${tool.tool}${tool.summary ? ' · ' + tool.summary : ''}` : s.protectedBy ?? PHASE[s.phase];
  $('chip').title = $('status').textContent;
  const live = s && s.phase !== 'ended' && s.phase !== 'kept';
  $('hold').classList.toggle('hidden', !live);
  $('hold').classList.toggle('held', !!s?.held);
  const auto = s?.autoResumeIn != null;
  $('hold').classList.toggle('auto', auto);
  if (auto) { resumeAt = Date.now() + s.autoResumeIn; resumeTotal = Math.max(resumeTotal, s.autoResumeIn); }
  clearInterval(countdown);
  countdown = auto ? setInterval(holdLabel, 200) : undefined;
  $('hold').title = auto ? 'You clicked in the page, so the agent waits. Click to keep control until you resume (⇧⌘P).'
    : s?.held ? 'Let the agent go on (⇧⌘P)' : "Hold the agent's new tool calls (⇧⌘P)";
  holdLabel(s);
  $('devtools').disabled = !nav;
  $('responsive').disabled = !nav;
  $('annotate').disabled = !nav;
  $('annotate').classList.toggle('on', !!state.annotating);
  $('annotate').classList.toggle('waiting', !!s?.feedback && !state.annotating);
  $('annotate').title = s?.feedback ? `The agent asks: ${s.feedback.question || 'mark an area'} (⇧⌘A)` : 'Mark an area for the agent (⇧⌘A)';
  $('responsive').classList.toggle('on', !!nav?.emulation);
  $('devtools').classList.toggle('on', !!s?.devtools);
});

function holdLabel(s) {
  const hold = $('hold');
  if (!hold.classList.contains('auto')) {
    if (s !== undefined) $('holdText').textContent = s?.held ? 'Resume Agent' : 'Take Control';
    return;
  }
  const left = Math.max(0, resumeAt - Date.now());
  $('holdText').textContent = `You have control · ${Math.ceil(left / 1000)} s`;
  hold.style.setProperty('--left', `${resumeTotal ? (left / resumeTotal) * 100 : 0}%`);
}

url.addEventListener('focus', () => { editing = true; setTimeout(() => url.select()); });
url.addEventListener('blur', () => { editing = false; });
url.addEventListener('keydown', e => {
  if (e.key === 'Enter' && url.value.trim()) { editing = false; api.action('navigate', url.value); url.blur(); }
  if (e.key === 'Escape') { editing = false; url.blur(); }
});
api.onFocusUrl(() => url.focus());
$('back').onclick = () => api.action('back');
$('forward').onclick = () => api.action('forward');
$('reload').onclick = () => api.action($('reload').dataset.loading ? 'stop' : 'reload');
$('devtools').onclick = () => api.action('devtools');
$('sidebar').onclick = () => api.action('sidebar');
$('responsive').onclick = () => api.action('responsive');
$('annotate').onclick = () => api.action('annotate');
$('hold').onclick = () => api.action('hold');
$('sizeReset').onclick = () => api.action('resetSize');
