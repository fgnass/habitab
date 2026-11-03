// The CDP commands that are an agent's action in a page: it clicks, types,
// navigates, runs a script, takes a screenshot or a snapshot, emulates. The
// MCP server also sends commands by itself (its DevTools SDK answers the
// page's events: attach, enable, element and target lookups); those are
// bookkeeping, and the list leaves them out on purpose.
//
// Two users: the bridge holds only these while the user has control (and
// tells the agent why), and the step detector (cdp-steps.ts) names steps
// only after them.

const ACTIONS = new Set([
  // Interaction
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent', 'Input.dispatchDragEvent', 'Input.imeSetComposition',
  'DOM.setFileInputFiles', 'Page.handleJavaScriptDialog',
  // Navigation and tabs
  'Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry',
  'Target.createTarget', 'Target.closeTarget', 'Target.activateTarget', 'Page.bringToFront',
  // Scripts (also Puppeteer's element actions, e.g. scrolling an element into view before a click)
  'Runtime.evaluate', 'Runtime.callFunctionOn',
  // Looking at the page
  'Page.captureScreenshot', 'Page.printToPDF', 'Accessibility.getFullAXTree',
  'CSS.getComputedStyleForNode', 'CSS.getMatchedStylesForNode', 'HeapProfiler.takeHeapSnapshot',
  'Tracing.start', 'Tracing.end', 'Page.startScreencast', 'Page.stopScreencast',
  // Emulation, network and storage
  'Browser.setContentsSize',
  'Emulation.setDeviceMetricsOverride', 'Emulation.setUserAgentOverride', 'Emulation.setEmulatedMedia', 'Emulation.setTouchEmulationEnabled',
  'Emulation.setGeolocationOverride', 'Emulation.setCPUThrottlingRate',
  'Network.emulateNetworkConditions', 'Network.setCookie', 'Network.setCookies', 'Network.clearBrowserCookies', 'Network.deleteCookies',
  'Storage.clearDataForOrigin',
]);

export const isAgentAction = (method: string | undefined): boolean => !!method && ACTIONS.has(method);
