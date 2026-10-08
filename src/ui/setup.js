const api = window.habitab;
const $ = id => document.getElementById(id);
const main = $('main');
let data = { findings: [], legacyServers: [], legacyBrowsers: [] };
let results = [];
const selected = new Set();
const open = new Set();

const STATE = {
  migrate: ['To take over', 'todo'], updatePath: ['Path update', 'todo'], migrated: ['Runs through Habitab', 'ok'],
  external: ['External browser', ''], persistentProfile: ['Persistent profile', 'warn'], unsupported: ['Not supported', 'warn'],
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Lucide icons (icons.js) under the names used here. */
const ICON_NAMES = { check: 'check', dash: 'minus', alert: 'triangle-alert', chevron: 'chevron-right' };
const icon = (name, cls = '') => window.icon(ICON_NAMES[name], cls);

const tilde = p => p?.replace(/^\/(Users|home)\/[^/]+/, '~');
const base = p => p?.split(/[\\/]/).filter(Boolean).pop();

function where(f) {
  switch (f.scope) {
    case 'user': return tilde(f.file);
    case 'local': return `local · ${base(f.project)}`;
    case 'project': return `project · ${base(f.project ?? f.file)}`;
    case 'profile': return `profile · ${base(f.file)}`;
    default: return f.scope;
  }
}

function busy(text) {
  $('busy').textContent = text ?? '';
  for (const b of ['apply', 'rescan', 'uninstall']) $(b).disabled = !!text;
}

/** One row of a grouped list, with optional details behind a disclosure button. */
function item({ id, lead, name, badge, whereText, whereTitle, state, dim, action, details }) {
  const it = el('div', 'item' + (dim ? ' dim' : '') + (id && open.has(id) ? ' open' : ''));
  const line = el('div', 'line');
  const l = el('span', 'lead');
  if (lead) l.appendChild(lead);
  const what = el('span', 'what');
  what.appendChild(el('span', 'name', name));
  if (badge) {
    // Static SVG strings from client-icons.js.
    const c = el('span', 'client');
    c.innerHTML = window.CLIENT_ICONS[badge] ?? '';
    what.appendChild(c);
    what.appendChild(el('span', 'client-name', window.CLIENT_NAMES[badge] ?? badge));
  }
  if (whereText) { const w = el('span', 'where ellipsis', whereText); if (whereTitle) w.title = whereTitle; what.appendChild(w); }
  line.append(l, what);
  if (state) line.appendChild(el('span', `state ${state[1]}`, state[0]));
  if (action) line.appendChild(action);
  if (details) {
    const more = el('button', 'more');
    more.title = 'Details';
    more.appendChild(icon('chevron'));
    more.onclick = () => { it.classList.toggle('open'); it.classList.contains('open') ? open.add(id) : open.delete(id); };
    line.appendChild(more);
    const body = el('div', 'more-body');
    body.append(...details);
    it.append(line, body);
  } else {
    line.appendChild(el('span', 'more-space'));
    it.appendChild(line);
  }
  return it;
}

function findingItem(f) {
  let lead;
  if (f.actionable) {
    lead = el('input');
    lead.type = 'checkbox';
    lead.checked = selected.has(f.id);
    lead.onchange = () => { lead.checked ? selected.add(f.id) : selected.delete(f.id); update(); };
  } else if (f.status === 'migrated') lead = icon('check', 'ok');
  else if (f.status === 'external') lead = icon('dash', 'off');
  else lead = icon('alert', 'warn');
  const details = [];
  if (f.status !== 'migrated') details.push(el('p', '', f.detail));
  details.push(el('div', 'label', f.proposedLine ? 'Now' : 'Command'), el('code', '', f.line));
  if (f.proposedLine) details.push(el('div', 'label', 'After taking over'), el('code', '', f.proposedLine));
  const [text, cls] = STATE[f.status] ?? [f.status, ''];
  return item({
    id: f.id, lead, name: f.name, badge: f.client, whereText: where(f), whereTitle: f.location,
    state: [f.shadow && f.actionable ? 'To take over (local override)' : text, cls],
    dim: !f.actionable && f.status !== 'migrated', details,
  });
}

function summary() {
  const todo = data.findings.filter(f => f.actionable).length;
  const done = data.findings.filter(f => f.status === 'migrated').length;
  const restart = data.legacyServers.filter(l => !l.replaced).length;
  if (!data.findings.length) return 'No chrome-devtools-mcp entries found in Claude Code or Codex.';
  if (todo) return `Habitab can take over ${todo} chrome-devtools-mcp ${todo === 1 ? 'entry' : 'entries'}. Agents then open their browsers here. The server and its arguments stay the same, and Habitab backs up each file first.`;
  if (!done) return 'None of the chrome-devtools-mcp entries can run through Habitab.';
  if (restart) return `Set up. ${restart} running ${restart === 1 ? 'session still uses' : 'sessions still use'} the old configuration.`;
  return 'All set. Agents open their browsers in Habitab.';
}

function render() {
  main.replaceChildren();
  $('summary').textContent = summary();

  if (results.length) {
    const bad = results.filter(r => !r.ok);
    const b = el('div', 'banner ' + (bad.length ? 'bad' : 'ok'));
    if (bad.length) for (const r of bad) b.appendChild(el('div', '', `${r.finding.name} (${where(r.finding)}): ${r.message}`));
    else b.textContent = `Done: ${results.length} ${results.length === 1 ? 'entry' : 'entries'} changed.`;
    main.appendChild(b);
  }

  if (data.findings.length) {
    main.appendChild(el('h2', '', 'Configurations'));
    const card = el('div', 'card');
    const order = f => (f.actionable ? 0 : f.status === 'migrated' ? 1 : 2);
    for (const f of [...data.findings].sort((a, b) => order(a) - order(b))) card.appendChild(findingItem(f));
    main.appendChild(card);
  }

  const restart = data.legacyServers.filter(l => !l.replaced);
  const leftover = data.legacyServers.filter(l => l.replaced);
  if (restart.length || leftover.length) {
    main.appendChild(el('h2', '', 'Running Sessions'));
    const card = el('div', 'card');
    for (const l of restart) card.appendChild(item({ lead: icon('alert', 'warn'), name: 'Session', badge: l.client, whereText: `pid ${l.clientPid ?? '?'}`, state: ['Restart needed', 'warn'] }));
    for (const l of leftover) card.appendChild(item({
      id: `srv${l.pid}`, lead: icon('check', 'ok'), name: 'Session', badge: l.client, whereText: `pid ${l.clientPid ?? '?'}`, state: ['Old server still running', ''],
      details: [el('p', '', `The session already runs through Habitab, but the client did not end its old server (pid ${l.pid}). It ends with the session.`)],
    }));
    main.appendChild(card);
    if (restart.length) {
      const hint = el('p', 'hint');
      if (restart.some(l => l.client !== 'codex')) {
        hint.append('In Claude Code, open ', el('kbd', '', '/mcp'), ' and reconnect chrome-devtools, or restart the session. ');
      }
      if (restart.some(l => l.client === 'codex')) hint.append('Restart Codex sessions.');
      main.appendChild(hint);
    }
  }

  if (data.legacyBrowsers.length) {
    main.appendChild(el('h2', '', 'Chrome Windows from chrome-devtools-mcp'));
    const card = el('div', 'card');
    for (const b of data.legacyBrowsers) {
      const quit = el('button', 'quit', 'Quit');
      quit.onclick = async () => {
        if (!confirm(`Quit this Chrome (pid ${b.pid})? Unsaved data in it will be lost.`)) return;
        await api.setup('endLegacy', [String(b.pid)]);
        await scan();
      };
      card.appendChild(item({
        lead: icon(b.orphaned ? 'alert' : 'dash', b.orphaned ? 'warn' : 'off'), name: 'Chrome', whereText: `pid ${b.pid}`, whereTitle: b.profile,
        state: b.orphaned ? ['Orphaned', 'warn'] : ['In use', ''], action: quit,
      }));
    }
    main.appendChild(card);
    main.appendChild(el('p', 'hint', 'Habitab does not quit these on its own. An orphaned window no longer has an MCP server.'));
  }
  update();
}

function update() {
  $('apply').textContent = selected.size ? `Take Over ${selected.size}` : 'Done';
  $('uninstall').disabled = !data.findings.some(f => f.status === 'migrated' || f.status === 'updatePath');
}

async function scan() {
  busy('Checking…');
  data = await api.setup('scan');
  selected.clear();
  // Personal configurations are preselected; shared project files only on request.
  for (const f of data.findings) if (f.actionable && (f.scope !== 'project' || f.shadow)) selected.add(f.id);
  busy();
  render();
}

$('rescan').onclick = () => { results = []; scan(); };
$('apply').onclick = async () => {
  if (!selected.size) return window.close();
  busy('Applying…');
  results = (await api.setup('apply', [...selected])).results ?? [];
  await scan();
};
$('uninstall').onclick = async () => {
  if (!confirm('Remove Habitab from all configurations?\n\nEach entry gets its original command back. Other settings, also ones you changed later, stay as they are. Running sessions use Habitab until they restart.')) return;
  busy('Removing…');
  results = (await api.setup('uninstall')).results ?? [];
  await scan();
};
scan();
