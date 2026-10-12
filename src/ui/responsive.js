// Responsive mode bar above an emulated page.
const api = window.habitab;
const $ = id => document.getElementById(id);

// Tailwind CSS default breakpoints (min-width), plus the full free width.
const BREAKPOINTS = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]];

for (const [name, width] of [...BREAKPOINTS, ['Full', null]]) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.width = width ?? '';
  b.title = width ? `${name}: ${width} px (Tailwind)` : 'Fill the free width';
  b.onclick = () => emulate(width ? { preset: 'responsive', width, fillHeight: current?.fillHeight ?? true } : { preset: 'responsive', fillWidth: true });
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
  for (const b of $('bps').children) b.classList.toggle('on', b.dataset.width ? !e.fillWidth && e.width === Number(b.dataset.width) : !!e.fillWidth);
  // The page is shown smaller than its viewport: say by how much.
  const scale = e.zoom === 'fit' ? e.scale : e.zoom;
  const scaled = typeof scale === 'number' && Math.round(scale * 100) !== 100;
  $('zoom').textContent = scaled ? `· ${Math.round(scale * 100)} %` : '';
  $('zoom').title = 'The page is scaled to fit the free space';
  $('zoom').classList.toggle('hidden', !scaled);
  $('by').classList.toggle('hidden', e.by !== 'agent');
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
$('close').onclick = () => api.action('responsive');
