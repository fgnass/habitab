// Responsive mode bar above an emulated page.
const api = window.habitab;
const $ = id => document.getElementById(id);

// A phone (iPhone width), common breakpoints (min-width), and the whole free space.
// The two ends show an icon, the breakpoints their name.
const PRESETS = [[icon('smartphone'), 390, 'Phone: 390 px (iPhone)'], ...[['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]].map(([n, w]) => [n, w, `${n}: ${w} px`]), [icon('move-horizontal'), null, 'Fill the free space']];

for (const [label, width, title] of PRESETS) {
  const b = document.createElement('button');
  b.append(label);
  b.dataset.width = width ?? '';
  b.title = title;
  b.onclick = () => emulate(width ? { preset: 'responsive', width, fillHeight: current?.fillHeight ?? true } : { preset: 'responsive', fillWidth: true, fillHeight: true });
  $('bps').appendChild(b);
}

let current;
const emulate = patch => api.action('emulate', patch);

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  const e = s?.nav?.emulation;
  if (!e) return;
  current = e;
  for (const [id, v, fill] of [['w', e.width, e.fillWidth], ['h', e.height, e.fillHeight]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
    $(id).classList.toggle('auto', !!fill);
    $(id).title = fill ? `${id === 'w' ? 'Width' : 'Height'}: fills the free space (type a value or drag the handle to fix it)` : id === 'w' ? 'Width' : 'Height';
  }
  $('mouse').classList.toggle('on', !e.mobile);
  $('touch').classList.toggle('on', !!e.mobile);
  // A size set by the agent is none of the presets, even when it matches one: only the size fields show it.
  const own = e.by !== 'agent';
  for (const b of $('bps').children) b.classList.toggle('on', own && (b.dataset.width ? !e.fillWidth && e.width === Number(b.dataset.width) : !!(e.fillWidth && e.fillHeight)));
  // The page is shown smaller than its viewport: say by how much.
  const scale = e.zoom === 'fit' ? e.scale : e.zoom;
  const scaled = typeof scale === 'number' && Math.round(scale * 100) !== 100;
  $('zoom').textContent = scaled ? `· ${Math.round(scale * 100)} %` : '';
  $('zoom').title = 'The page is scaled to fit the free space';
  $('zoom').classList.toggle('hidden', !scaled);
  $('by').classList.toggle('hidden', e.by !== 'agent');
  $('by').textContent = e.cut ? '· set by the agent, cut off' : '· set by the agent';
  $('by').title = e.cut ? 'The page does not fit the free space, so a part of it is not visible. Change the size or make the window larger to see all of it.' : '';
  $('by').classList.toggle('cut', !!e.cut);
});

for (const id of ['w', 'h']) {
  const commit = () => {
    const v = parseInt($(id).value, 10);
    if (v > 0 && current && v !== current[id === 'w' ? 'width' : 'height']) emulate({ preset: 'responsive', [id === 'w' ? 'width' : 'height']: v });
  };
  $(id).addEventListener('change', commit);
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { commit(); $(id).blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      $(id).value = Math.max(50, (parseInt($(id).value, 10) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      commit();
    }
  });
}
$('mouse').onclick = () => emulate({ mobile: false });
$('touch').onclick = () => emulate({ mobile: true });
$('close').onclick = () => api.action('responsive');
