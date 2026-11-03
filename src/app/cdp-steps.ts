// Steps of an agent whose tool calls Habitab does not see (sessions of the
// browser bridge): derived from the CDP commands of its session browser.
//
// A step is a burst of commands. It ends after a pause with nothing pending;
// after a navigation only when the page has loaded (or after a limit). Steps
// with nothing but Puppeteer's bookkeeping (attach, enable, element lookups,
// the stabilization polls after an action) are dropped. The names are short
// and readable ("Click", "Navigate"), not chrome-devtools-mcp's tool names;
// two tools without a pause between them become one step ("Click, Snapshot").

import { isAgentAction } from '../shared/agent-actions';

export interface StepStart { tool: string; summary?: string }
export interface StepEnd extends StepStart { durationMs: number; isError: boolean; detail?: string }

/** Pause after the last command or answer that ends a step. Agents need longer between two calls. */
const GAP_MS = 500;
/** A navigation keeps its step open this long at most while the page loads. */
const LOAD_LIMIT_MS = 15_000;
/** Longer than any chrome-devtools-mcp wait: a command without answer no longer keeps a step open. */
const PENDING_LIMIT_MS = 60_000;

interface Name { name: string; weight: number; summary?: string }

interface Current {
  since: number;
  lastActivity: number;
  names: Map<string, Name>;
  pending: Map<string, number>;
  /** Commands that named the step: only their errors count. */
  significant: Set<string>;
  started: boolean;
  /** A navigation command was sent; the step waits for the page to load. */
  navigatedAt?: number;
  loaded: boolean;
  typed: string;
  keys: string[];
  mouseDown: boolean;
  error?: string;
}

export class StepDetector {
  private current?: Current;
  private timer?: NodeJS.Timeout;
  /** The last Runtime.evaluate expression per CDP session: the agent's script before chrome-devtools-mcp's wrapper call. */
  private evaluated = new Map<string, string>();
  private closed = false;

  constructor(private hooks: { start: (s: StepStart) => void; end: (s: StepEnd) => void }) {}

  command(key: string, method: string, params: any, sessionId?: string): void {
    if (this.closed) return;
    const now = Date.now();
    const c: Current = this.current ?? (this.current = { since: now, lastActivity: now, names: new Map(), pending: new Map(), significant: new Set(), started: false, loaded: false, typed: '', keys: [], mouseDown: false });
    c.lastActivity = now;
    c.pending.set(key, now);
    const name = this.classify(c, method, params ?? {}, sessionId);
    if (name) {
      c.significant.add(key);
      const known = c.names.get(name.name);
      if (!known) c.names.set(name.name, name);
      else if (name.summary) known.summary = name.summary;
      if (!c.started) {
        c.started = true;
        c.since = now;
        this.hooks.start({ tool: this.label(c), summary: this.summary(c) });
      }
    }
    if (NAVIGATION.has(method)) { c.navigatedAt = now; c.loaded = false; }
    this.schedule();
  }

  reply(key: string, error?: string): void {
    const c = this.current;
    if (!c || !c.pending.delete(key)) return;
    c.lastActivity = Date.now();
    if (error && !c.error && c.significant.has(key)) c.error = error;
    this.schedule();
  }

  /** Events of the session browser: the end of a navigation. */
  event(method: string): void {
    const c = this.current;
    if (!c || !c.navigatedAt) return;
    if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') { c.loaded = true; this.schedule(); }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.finish();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), GAP_MS);
    this.timer.unref();
  }

  private check(): void {
    const c = this.current;
    if (!c) return;
    const now = Date.now();
    const pending = [...c.pending.values()].some(t => now - t < PENDING_LIMIT_MS);
    const loading = !!c.navigatedAt && !c.loaded && now - c.navigatedAt < LOAD_LIMIT_MS;
    if (pending || loading || now - c.lastActivity < GAP_MS) return this.schedule();
    this.finish();
  }

  private finish(): void {
    const c = this.current;
    this.current = undefined;
    if (!c || !c.started) return;
    // Measured to the last command or answer, not to the pause that ended the step.
    this.hooks.end({ tool: this.label(c), summary: this.summary(c), durationMs: Math.max(0, c.lastActivity - c.since), isError: !!c.error, detail: c.error });
  }

  private ordered(c: Current): Name[] {
    const names = [...c.names.values()];
    // Puppeteer moves the pointer before it presses: a hover is only a hover on its own.
    // A new page is navigated to its URL: that navigation is part of opening it.
    const drop = new Set<string>();
    if (names.some(n => n.name === 'Click' || n.name === 'Double click' || n.name === 'Drag')) drop.add('Hover');
    if (names.some(n => n.name === 'New page')) drop.add('Navigate');
    return names.filter(n => !drop.has(n.name)).sort((a, b) => b.weight - a.weight);
  }

  private label(c: Current): string {
    return this.ordered(c).slice(0, 3).map(n => n.name).join(', ');
  }

  private summary(c: Current): string | undefined {
    const first = this.ordered(c)[0];
    if (!first) return undefined;
    if (first.name === 'Type') return c.typed.slice(0, 120);
    if (first.name === 'Press') return [...new Set(c.keys)].join(', ').slice(0, 120);
    return first.summary;
  }

  /** The readable name a command gives its step, or undefined for Puppeteer's bookkeeping. */
  private classify(c: Current, method: string, p: any, sessionId?: string): Name | undefined {
    if (!isAgentAction(method)) return undefined;
    switch (method) {
      case 'Page.navigate': return { name: 'Navigate', weight: 10, summary: p.url };
      case 'Page.reload': return { name: 'Reload', weight: 10 };
      case 'Page.navigateToHistoryEntry': return { name: 'History', weight: 10 };
      case 'Target.createTarget': return { name: 'New page', weight: 9, summary: p.url && p.url !== 'about:blank' ? p.url : undefined };
      case 'Target.closeTarget': return { name: 'Close page', weight: 9 };
      case 'Target.activateTarget': case 'Page.bringToFront': return { name: 'Select page', weight: 4 };
      case 'Input.dispatchMouseEvent':
        if (p.type === 'mousePressed') { c.mouseDown = true; return { name: p.clickCount >= 2 ? 'Double click' : 'Click', weight: 9 }; }
        if (p.type === 'mouseReleased') { c.mouseDown = false; return undefined; }
        if (p.type === 'mouseWheel') return { name: 'Scroll', weight: 8 };
        if (p.type === 'mouseMoved') return c.mouseDown ? { name: 'Drag', weight: 9 } : { name: 'Hover', weight: 7 };
        return undefined;
      case 'Input.dispatchKeyEvent':
        if (p.type !== 'keyDown' && p.type !== 'rawKeyDown') return undefined;
        if (typeof p.text === 'string' && p.text && !p.modifiers) { c.typed += p.text; return { name: 'Type', weight: 9 }; }
        c.keys.push(keyLabel(p));
        return { name: 'Press', weight: 8 };
      case 'Input.insertText':
        c.typed += p.text ?? '';
        return { name: 'Type', weight: 9 };
      case 'Page.captureScreenshot': return { name: 'Screenshot', weight: 6 };
      case 'Page.printToPDF': return { name: 'PDF', weight: 6 };
      case 'Accessibility.getFullAXTree': return { name: 'Snapshot', weight: 5 };
      case 'Runtime.evaluate':
        if (typeof p.expression === 'string' && sessionId) this.evaluated.set(sessionId, p.expression);
        return undefined;
      case 'Runtime.callFunctionOn': {
        // chrome-devtools-mcp runs the agent's script through this wrapper; the script was the Runtime.evaluate before.
        if (typeof p.functionDeclaration !== 'string' || !p.functionDeclaration.includes('JSON.stringify(await fn(')) return undefined;
        const expr = sessionId ? this.evaluated.get(sessionId) : undefined;
        return { name: 'Script', weight: 6, summary: expr ? scriptSource(expr) : undefined };
      }
      case 'Browser.setContentsSize': return { name: 'Resize', weight: 7, summary: `${p.width}×${p.height}` };
      case 'Emulation.setDeviceMetricsOverride': return { name: 'Emulate', weight: 7, summary: p.width && p.height ? `${p.width}×${p.height}` : undefined };
      case 'Emulation.setUserAgentOverride': case 'Emulation.setEmulatedMedia': case 'Emulation.setTouchEmulationEnabled': return { name: 'Emulate', weight: 7 };
      case 'Emulation.setGeolocationOverride': return { name: 'Geolocation', weight: 7 };
      case 'Emulation.setCPUThrottlingRate': return { name: p.rate > 1 ? 'Throttle CPU' : 'CPU normal', weight: 7 };
      case 'Network.emulateNetworkConditions': return { name: p.offline || p.latency || p.downloadThroughput > 0 ? 'Throttle network' : 'Network normal', weight: 7 };
      case 'Tracing.start': return { name: 'Trace', weight: 8 };
      case 'Tracing.end': return { name: 'Trace end', weight: 8 };
      case 'Page.startScreencast': return { name: 'Screencast', weight: 8 };
      case 'Page.stopScreencast': return { name: 'Screencast end', weight: 8 };
      case 'HeapProfiler.takeHeapSnapshot': return { name: 'Heap snapshot', weight: 6 };
      case 'DOM.setFileInputFiles': return { name: 'Upload', weight: 9, summary: (p.files ?? []).map((f: string) => f.split('/').pop()).join(', ') };
      case 'Page.handleJavaScriptDialog': return { name: p.accept ? 'Dialog OK' : 'Dialog cancel', weight: 9 };
      case 'Network.setCookie': case 'Network.setCookies': return { name: 'Cookies', weight: 6 };
      case 'Network.clearBrowserCookies': return { name: 'Clear cookies', weight: 6 };
      case 'Storage.clearDataForOrigin': return { name: 'Clear storage', weight: 6 };
      case 'CSS.getComputedStyleForNode': case 'CSS.getMatchedStylesForNode': return { name: 'Styles', weight: 4 };
      default: return undefined;
    }
  }
}

const NAVIGATION = new Set(['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry']);

function keyLabel(p: any): string {
  const mods: string[] = [];
  if (p.modifiers & 8) mods.push('Meta');
  if (p.modifiers & 2) mods.push('Ctrl');
  if (p.modifiers & 1) mods.push('Alt');
  if (p.modifiers & 4) mods.push('Shift');
  return [...mods, p.key ?? p.code ?? '?'].join('+');
}

/** The agent's function out of Puppeteer's evaluate expression: "(\n<fn>\n)\n//# sourceURL=pptr:…". */
function scriptSource(expr: string): string {
  return expr.replace(/\n?\/\/# sourceURL=.*$/s, '').replace(/^\(\n?/, '').replace(/\n?\)\s*$/, '').trim().slice(0, 1000);
}
