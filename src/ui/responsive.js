// Responsive mode bar above an emulated page.
const api = window.habitab;
const $ = id => document.getElementById(id);

const PRESETS = [
  { id: 'responsive', name: 'Responsive' },
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, dpr: 2, mobile: true },
  { id: 'iphone-15-pro', name: 'iPhone 15 Pro', width: 393, height: 852, dpr: 3, mobile: true },
  { id: 'pixel-8', name: 'Pixel 8', width: 412, height: 915, dpr: 2.625, mobile: true },
  { id: 'ipad-mini', name: 'iPad Mini', width: 768, height: 1024, dpr: 2, mobile: true },
  { id: 'ipad-pro', name: 'iPad Pro 12.9″', width: 1024, height: 1366, dpr: 2, mobile: true },
  { id: 'laptop', name: 'Laptop', width: 1280, height: 800, dpr: 2, mobile: false },
  { id: 'desktop', name: 'Desktop HD', width: 1920, height: 1080, dpr: 1, mobile: false },
];
const DPRS = [1, 2, 2.625, 3];
// Tailwind CSS default breakpoints (min-width), plus the full free width.
const BREAKPOINTS = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]];
const ZOOMS = [['fit', 'Fit'], [0.5, '50 %'], [0.75, '75 %'], [1, '100 %']];

const option = (value, text) => { const o = document.createElement('option'); o.value = String(value); o.textContent = text; return o; };
$('preset').append(...PRESETS.map(p => option(p.id, p.name)));
for (const [name, width] of [...BREAKPOINTS, ['Full', null]]) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.width = width ?? '';
  b.title = width ? `${name}: ${width} px (Tailwind)` : 'Fill the free width';
  b.onclick = () => emulate(width ? { preset: 'responsive', width, fillHeight: current?.fillHeight ?? true } : { preset: 'responsive', fillWidth: true });
  $('bps').appendChild(b);
}
$('zoom').append(...ZOOMS.map(([v, t]) => option(v, t)));

let current;
const emulate = patch => api.action('emulate', patch);

api.onState(state => {
  const s = state.sessions.find(x => x.id === state.selected);
  const e = s?.nav?.emulation;
  if (!e) return;
  current = e;
  $('preset').value = PRESETS.some(p => p.id === e.preset) ? e.preset : 'responsive';
  for (const [id, v, fill] of [['w', e.width, e.fillWidth], ['h', e.height, e.fillHeight]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
    $(id).classList.toggle('auto', !!fill);
    $(id).title = fill ? `${id === 'w' ? 'Width' : 'Height'}: fills the free space (type a value or drag the handle to fix it)` : id === 'w' ? 'Width' : 'Height';
  }
  for (const b of $('bps').children) b.classList.toggle('on', b.dataset.width ? !e.fillWidth && e.width === Number(b.dataset.width) : !!e.fillWidth);
  const dprs = [...new Set([...DPRS, e.dpr])].filter(Boolean).sort((a, b) => a - b);
  $('dpr').replaceChildren(...dprs.map(d => option(d, `DPR ${d}`)));
  $('dpr').value = String(e.dpr);
  const zooms = ZOOMS.some(([v]) => String(v) === String(e.zoom)) ? ZOOMS : [...ZOOMS, [e.zoom, `${Math.round(e.zoom * 100)} %`]];
  $('zoom').replaceChildren(...zooms.map(([v, t]) => option(v, e.zoom === 'fit' && v === 'fit' && e.scale < 1 ? `Fit (${Math.round(e.scale * 100)} %)` : t)));
  $('zoom').value = String(e.zoom);
  $('by').classList.toggle('hidden', e.by !== 'agent');
});

$('preset').onchange = () => {
  const p = PRESETS.find(x => x.id === $('preset').value);
  emulate(p.width ? { preset: p.id, width: p.width, height: p.height, dpr: p.dpr, mobile: p.mobile } : { preset: 'responsive', fillWidth: true, fillHeight: true, mobile: false });
};
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
$('rotate').onclick = () => emulate({ rotate: true });
$('dpr').onchange = () => emulate({ dpr: Number($('dpr').value) });
$('zoom').onchange = () => emulate({ zoom: $('zoom').value === 'fit' ? 'fit' : Number($('zoom').value) });
$('close').onclick = () => api.action('responsive');
