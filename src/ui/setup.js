const api = window.habitab;
const $ = id => document.getElementById(id);
const main = $('main');
let data = { cd4a: null, findings: [], legacyServers: [], legacyBrowsers: [] };
let results = [];
let cd4aResult = null;
const selected = new Set();
const open = new Set();

const STATE = {
  unwrap: ['Old launcher entry', 'todo'], ok: ['Uses Habitab', 'ok'], conflict: ['Own browser', 'warn'], unsupported: ['Not supported', 'warn'],
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
  const ready = !!data.cd4a?.habitab;
  let lead;
  if (f.actionable) {
    lead = el('input');
    lead.type = 'checkbox';
    lead.checked = selected.has(f.id);
    lead.onchange = () => { lead.checked ? selected.add(f.id) : selected.delete(f.id); update(); };
  } else if (f.status === 'ok') lead = icon(ready ? 'check' : 'dash', ready ? 'ok' : 'off');
  else lead = icon('alert', 'warn');
  const details = [el('p', '', f.detail), el('div', 'label', f.proposedLine ? 'Now' : 'Command'), el('code', '', f.line)];
  if (f.proposedLine) details.push(el('div', 'label', 'After the change'), el('code', '', f.proposedLine));
  let [text, cls] = STATE[f.status] ?? [f.status, ''];
  if (f.status === 'ok' && !ready) [text, cls] = ['Ready', ''];
  return item({ id: f.id, lead, name: f.name, badge: f.client, whereText: where(f), whereTitle: f.location, state: [text, cls], dim: f.status === 'conflict' || f.status === 'unsupported', details });
}

function summary() {
  const c = data.cd4a;
  const todo = data.findings.filter(f => f.actionable).length;
  const restart = data.legacyServers.filter(l => !l.replaced).length;
  if (!c) return 'Checking…';
  if (c.invalid) return `The global config of chrome-devtools-mcp is not valid JSON (${tilde(c.file)}).`;
  if (c.conflicts.length) return `The global config names ${c.conflicts.join(', ')}, which cannot be combined with Habitab's browser. Remove it there first.`;
  if (!c.habitab) return 'One setting gives every chrome-devtools-mcp its browser in Habitab: its global config. Client configurations stay as they are.';
  if (todo) return `Set up. ${todo} ${todo === 1 ? 'entry still has' : 'entries still have'} the launcher of Habitab 0.2 in front of the server; it is no longer needed.`;
  if (restart) return `Set up. ${restart} running ${restart === 1 ? 'session still uses' : 'sessions still use'} the old browser.`;
  const conflicts = data.findings.filter(f => f.status === 'conflict').length;
  if (conflicts) return `All set. ${conflicts} ${conflicts === 1 ? 'entry names' : 'entries name'} its own browser and will not start until it is kept out of the global config.`;
  return 'All set. Agents open their browsers in Habitab.';
}

/** The global config of chrome-devtools-mcp: the one setting that matters. */
function cd4aItem() {
  const c = data.cd4a;
  const ok = c.habitab && !c.invalid;
  const blocked = c.invalid || c.conflicts.length;
  const details = [
    el('p', '', 'chrome-devtools-mcp (1.10 or newer) reads this file wherever it is started from, also when a CLI bundles the server. ' +
      'With Habitab\'s browser as executablePath, the server starts it in place of Chrome and the session appears here. ' +
      'A server that names its own browser (--browserUrl, --autoConnect, --channel) would not start: give it CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1 in its env.'),
    el('div', 'label', 'File'), el('code', '', tilde(c.file)),
  ];
  if (c.exists && !c.invalid) details.push(el('div', 'label', 'Content'), el('code', '', JSON.stringify(c.config)));
  if (c.invalid) details.push(el('div', 'label', 'Problem'), el('code', '', c.invalid));
  return item({
    id: 'cd4a', lead: icon(ok ? 'check' : blocked ? 'alert' : 'dash', ok ? 'ok' : blocked ? 'warn' : 'off'), name: 'Global config',
    whereText: 'executablePath', whereTitle: c.file,
    state: ok ? ['Habitab\'s browser', 'ok'] : blocked ? ['Blocked', 'warn'] : ['Not set', 'todo'], details,
  });
}

function render() {
  main.replaceChildren();
  $('summary').textContent = summary();

  if (results.length || cd4aResult) {
    const bad = [...(cd4aResult && !cd4aResult.ok ? [cd4aResult.message] : []), ...results.filter(r => !r.ok).map(r => `${r.finding.name} (${where(r.finding)}): ${r.message}`)];
    const b = el('div', 'banner ' + (bad.length ? 'bad' : 'ok'));
    if (bad.length) for (const m of bad) b.appendChild(el('div', '', m));
    else b.textContent = results.length ? `Done: ${results.length} ${results.length === 1 ? 'entry' : 'entries'} changed.` : 'Done.';
    main.appendChild(b);
  }

  if (data.cd4a) {
    main.appendChild(el('h2', '', 'Browser of chrome-devtools-mcp'));
    const card = el('div', 'card');
    card.appendChild(cd4aItem());
    main.appendChild(card);
  }

  // Client configurations stay as they are; only entries that need attention are listed.
  const attention = data.findings.filter(f => f.status !== 'ok');
  if (attention.length) {
    main.appendChild(el('h2', '', 'Client Configurations That Need Attention'));
    const card = el('div', 'card');
    const order = f => (f.actionable ? 0 : 1);
    for (const f of [...attention].sort((a, b) => order(a) - order(b))) card.appendChild(findingItem(f));
    main.appendChild(card);
    main.appendChild(el('p', 'hint', 'Entries wrapped by Habitab 0.2 get their original command back. An entry with its own browser needs CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1 in its env.'));
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
  const c = data.cd4a;
  const needsSetup = c && !c.habitab && !c.invalid && !c.conflicts.length;
  $('apply').textContent = needsSetup ? (selected.size ? `Set Up and Clean ${selected.size}` : 'Set Up') : selected.size ? `Clean ${selected.size}` : 'Done';
  $('apply').disabled = !!c?.invalid || !!c?.conflicts.length;
  $('uninstall').disabled = !(c?.habitab || data.findings.some(f => f.actionable));
}

async function scan() {
  busy('Checking…');
  data = await api.setup('scan');
  selected.clear();
  for (const f of data.findings) if (f.actionable) selected.add(f.id);
  busy();
  render();
}

$('rescan').onclick = () => { results = []; cd4aResult = null; scan(); };
$('apply').onclick = async () => {
  const c = data.cd4a;
  if (c?.habitab && !selected.size) return window.close();
  busy('Applying…');
  const r = await api.setup('apply', [...selected]);
  results = r.results ?? [];
  cd4aResult = r.cd4a ?? null;
  await scan();
};
$('uninstall').onclick = async () => {
  if (!confirm('Remove Habitab from the configurations?\n\nThe global config of chrome-devtools-mcp loses Habitab\'s browser, and old launcher entries get their original command back. Running sessions keep their browser in Habitab until they restart.')) return;
  busy('Removing…');
  const r = await api.setup('uninstall');
  results = r.results ?? [];
  cd4aResult = r.cd4a ?? null;
  await scan();
};
scan();
