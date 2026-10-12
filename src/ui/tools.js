// Human-friendly names and short summaries for the agent's tool calls
// (chrome-devtools-mcp and Habitab's own). Summaries come from the agent's
// arguments: shown only where they help (a URL, a key, typed text), never
// scripts or the snapshot's element ids.
const TOOL_LABELS = {
  navigate_page: 'Navigate', new_page: 'New tab', close_page: 'Close tab', select_page: 'Switch tab', list_pages: 'List tabs',
  take_snapshot: 'Read page', take_screenshot: 'Screenshot', evaluate_script: 'Run script', wait_for: 'Wait for text',
  click: 'Click', click_at: 'Click', hover: 'Hover', drag: 'Drag', fill: 'Fill in', fill_form: 'Fill in form', type_text: 'Type',
  press_key: 'Press key', upload_file: 'Upload file', handle_dialog: 'Answer dialog', resize_page: 'Resize page', emulate: 'Emulate',
  list_console_messages: 'Read console', get_console_message: 'Read console message',
  list_network_requests: 'List requests', get_network_request: 'Read request', get_css_styles: 'Read styles',
  performance_start_trace: 'Start trace', performance_stop_trace: 'Stop trace', performance_analyze_insight: 'Analyze trace',
  lighthouse_audit: 'Lighthouse audit', screencast_start: 'Start screencast', screencast_stop: 'Stop screencast',
  take_heapsnapshot: 'Heap snapshot', open_devtools: 'Open DevTools', reveal_in_devtools: 'Reveal in DevTools',
  wait_for_user_feedback: 'Ask you', Download: 'Download',
};

/** "take_snapshot" -> "Read page"; unknown tools: "get_tab_id" -> "Get tab id". */
window.toolLabel = tool => TOOL_LABELS[tool] ?? String(tool ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** URLs without the scheme, like the address bar. */
const shortUrl = u => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname) + x.search; } catch { return u; } };

/** The part of a call's summary worth showing inline ('' when it would be noise). */
window.toolSummary = (tool, summary) => {
  if (!summary) return '';
  switch (tool) {
    case 'navigate_page': case 'new_page': return /^[a-z]+:/i.test(summary) ? shortUrl(summary) : summary;
    case 'press_key': case 'wait_for_user_feedback': case 'Download': return summary;
    case 'type_text': case 'fill': case 'wait_for': return `“${summary.length > 40 ? summary.slice(0, 40) + '…' : summary}”`;
    case 'upload_file': return summary.split(/[\\/]/).pop();
    default: return '';
  }
};

/** Label and inline summary: "Navigate · shop.example/cart". */
window.toolText = (tool, summary) => [window.toolLabel(tool), window.toolSummary(tool, summary)].filter(Boolean).join(' · ');

// MARK: Timeline (shared by the thumbnails at the top and the status bar at the bottom)

window.fmtTime = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
window.fmtDuration = ms => ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
window.toolCalls = n => `${n} tool call${n > 1 ? 's' : ''}`;

/**
 * Steps -> changes. A step without URL is still waiting for its screenshot;
 * one with an empty URL had no tab. Each group is named by its first step.
 */
window.timelineGroups = steps => {
  const out = [];
  for (const x of steps) {
    const state = x.url === undefined ? 'pending' : x.shot ?? 'none';
    const last = out[out.length - 1];
    // A step still waiting for its screenshot joins the card before it: it gets a
    // card of its own only when the screenshot shows a change.
    if (last && (last.state === state || state === 'pending')) last.steps.push(x);
    else out.push({ id: x.id, state, shot: x.shot, steps: [x] });
  }
  for (const g of out) {
    const end = g.steps[g.steps.length - 1];
    Object.assign(g, { head: g.steps[0], url: end.url, title: end.title, errors: g.steps.filter(x => x.isError) });
  }
  return out;
};
