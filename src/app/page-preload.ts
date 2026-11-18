// Preload of the session pages (sandboxed, isolated world). Pages get what
// Electron lacks compared to Chrome, before their own scripts run:
//   - the Web Share API (Chromium has it in //chrome): a share opens the macOS
//     share menu (see the 'habitab:share' handler in main.ts);
//   - the Web Speech API (Chrome's engine sends audio to Google; Electron's
//     start() fails with "network"): recognition on this Mac, see speech.ts.
// Nothing else is exposed to the page.
import { contextBridge, ipcRenderer } from 'electron';

/** Runs in the page's main world; only its arguments reach back to this preload. */
function installShare(send: (json: string) => Promise<string>): void {
  if (!isSecureContext || 'share' in Navigator.prototype) return;
  const noFields = "Failed to execute 'share' on 'Navigator': No known share data fields supplied. If using only new fields (other than title, text and url), you must feature-detect them first.";
  let busy = false;

  /** Validates like Chrome and serializes the data (files as base64). */
  const serialize = async (d: ShareData | undefined): Promise<object> => {
    if (d == null || typeof d !== 'object') throw new TypeError(noFields);
    const out: { title?: string; text?: string; url?: string; files?: { name: string; type: string; data: string }[] } = {};
    if (d.title !== undefined) out.title = String(d.title);
    if (d.text !== undefined) out.text = String(d.text);
    if (d.url !== undefined) {
      try { out.url = new URL(String(d.url), document.baseURI).href; } catch { throw new TypeError("Failed to execute 'share' on 'Navigator': Invalid URL"); }
    }
    const files = d.files === undefined ? [] : Array.from(d.files);
    if (files.some(f => !(f instanceof File))) throw new TypeError("Failed to execute 'share' on 'Navigator': files must contain File objects");
    if (files.length) {
      out.files = await Promise.all(files.map(async f => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { name: f.name, type: f.type, data: btoa(bin) };
      }));
    }
    if (out.title === undefined && out.text === undefined && out.url === undefined && !files.length) throw new TypeError(noFields);
    return out;
  };

  function canShare(d?: ShareData): boolean {
    try {
      if (d == null || typeof d !== 'object') return false;
      if (d.url !== undefined) new URL(String(d.url), document.baseURI);
      const files = d.files === undefined ? [] : Array.from(d.files);
      if (files.some(f => !(f instanceof File))) return false;
      return d.title !== undefined || d.text !== undefined || d.url !== undefined || files.length > 0;
    } catch { return false; }
  }

  async function share(d?: ShareData): Promise<void> {
    if (busy) throw new DOMException('An earlier share has not yet completed.', 'InvalidStateError');
    if (navigator.userActivation && !navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to perform a share request.', 'NotAllowedError');
    const data = await serialize(d);
    busy = true;
    try {
      const r = await send(JSON.stringify(data));
      if (r !== 'ok') throw new DOMException(r === 'AbortError' ? 'Share canceled' : r === 'DataError' ? 'The share data is too large.' : 'Share failed', r);
    } finally { busy = false; }
  }

  for (const [name, value] of [['share', share], ['canShare', canShare]] as const) {
    Object.defineProperty(Navigator.prototype, name, { configurable: true, enumerable: true, writable: true, value });
  }
}

/**
 * Runs in the page's main world: SpeechRecognition (and webkitSpeechRecognition)
 * like Chrome's, with the events, result lists and error names of the spec.
 * Requests go to the app as JSON ({ op, id, … }); events come back as JSON
 * ({ id, type, … }, see SpeechEvent in speech.ts).
 */
function installSpeech(request: (json: string) => Promise<string>, subscribe: (cb: (json: string) => void) => void): void {
  /** Chrome gives up after this time without any speech. */
  const NO_SPEECH_MS = 8000;
  type Handler = ((ev: Event) => void) | null;

  class SpeechRecognitionAlternative {
    constructor(readonly transcript: string, readonly confidence: number) {}
  }
  class SpeechRecognitionResult {
    readonly length: number;
    [index: number]: SpeechRecognitionAlternative;
    constructor(alternatives: SpeechRecognitionAlternative[], readonly isFinal: boolean) {
      alternatives.forEach((a, i) => Object.defineProperty(this, i, { value: a, enumerable: true }));
      this.length = alternatives.length;
    }
    item(i: number): SpeechRecognitionAlternative | null { return this[i] ?? null; }
    *[Symbol.iterator](): Iterator<SpeechRecognitionAlternative> { for (let i = 0; i < this.length; i++) yield this[i]; }
  }
  class SpeechRecognitionResultList {
    readonly length: number;
    [index: number]: SpeechRecognitionResult;
    constructor(results: SpeechRecognitionResult[]) {
      results.forEach((r, i) => Object.defineProperty(this, i, { value: r, enumerable: true }));
      this.length = results.length;
    }
    item(i: number): SpeechRecognitionResult | null { return this[i] ?? null; }
    *[Symbol.iterator](): Iterator<SpeechRecognitionResult> { for (let i = 0; i < this.length; i++) yield this[i]; }
  }
  class SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
    constructor(type: string, init?: { resultIndex?: number; results?: SpeechRecognitionResultList }) {
      super(type);
      this.resultIndex = init?.resultIndex ?? 0;
      this.results = init?.results ?? new SpeechRecognitionResultList([]);
    }
  }
  class SpeechRecognitionErrorEvent extends Event {
    readonly error: string;
    readonly message: string;
    constructor(type: string, init: { error: string; message?: string }) {
      super(type);
      this.error = init.error;
      this.message = init.message ?? '';
    }
  }

  const EVENTS = ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'result', 'nomatch', 'error', 'start', 'end'];
  let nextId = 1;
  const running = new Map<number, SpeechRecognition>();

  class SpeechRecognition extends EventTarget {
    grammars: unknown = null;
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    processLocally = false;
    #id = 0;
    #handlers = new Map<string, Handler>();
    #finals: string[] = [];
    #interim: string | null = null;
    #audio = false;
    #speech = false;
    #stopping = false;
    #timer: ReturnType<typeof setTimeout> | undefined;

    /** On-device recognition for these languages: "available", "downloadable", "downloading" or "unavailable". */
    static async available(options?: { langs?: string[]; processLocally?: boolean }): Promise<string> {
      const langs = options?.langs?.length ? options.langs : [''];
      const statuses = await Promise.all(langs.map(l => request(JSON.stringify({ op: 'available', lang: String(l) }))));
      for (const s of ['unavailable', 'downloading', 'downloadable']) if (statuses.includes(s)) return s;
      return 'available';
    }
    static async install(options?: { langs?: string[]; processLocally?: boolean }): Promise<boolean> {
      const langs = options?.langs?.length ? options.langs : [''];
      const ok = await Promise.all(langs.map(l => request(JSON.stringify({ op: 'install', lang: String(l) }))));
      return ok.every(x => x === 'true');
    }

    start(): void {
      if (this.#id) throw new DOMException("Failed to execute 'start' on 'SpeechRecognition': recognition has already started.", 'InvalidStateError');
      this.#id = nextId++;
      this.#finals = [];
      this.#interim = null;
      this.#audio = this.#speech = this.#stopping = false;
      running.set(this.#id, this);
      const lang = this.lang || document.documentElement.lang || navigator.language;
      void request(JSON.stringify({ op: 'start', id: this.#id, lang, interim: this.interimResults, continuous: this.continuous }));
      queueMicrotask(() => { if (this.#id) this.dispatchEvent(new Event('start')); });
    }
    stop(): void {
      if (!this.#id || this.#stopping) return;
      this.#stopping = true;
      void request(JSON.stringify({ op: 'stop', id: this.#id }));
    }
    abort(): void {
      if (!this.#id || this.#stopping) return;
      this.#stopping = true;
      void request(JSON.stringify({ op: 'abort', id: this.#id }));
      this.dispatchEvent(new SpeechRecognitionErrorEvent('error', { error: 'aborted' }));
    }

    /** An event of the app for this recognition. */
    _receive(e: { type: string; text?: string; final?: boolean; confidence?: number; error?: string; message?: string }): void {
      if (!this.#id) return;
      if (e.type === 'started') {
        this.#audio = true;
        this.dispatchEvent(new Event('audiostart'));
        this.#timer = setTimeout(() => this.#noSpeech(), NO_SPEECH_MS);
      } else if (e.type === 'result') {
        clearTimeout(this.#timer);
        if (!this.#speech) {
          this.#speech = true;
          this.dispatchEvent(new Event('soundstart'));
          this.dispatchEvent(new Event('speechstart'));
        }
        const text = (e.text ?? '').trim();
        if (e.final) { this.#interim = null; if (text) this.#finals.push(text); }
        else this.#interim = text;
        const items = this.#finals.map(t => new SpeechRecognitionResult([new SpeechRecognitionAlternative(t, e.final ? e.confidence ?? 1 : 1)], true));
        if (this.#interim !== null && this.interimResults) items.push(new SpeechRecognitionResult([new SpeechRecognitionAlternative(this.#interim, 1)], false));
        if (!e.final && !this.interimResults) return;
        if (!e.final && !this.#interim) return;
        const resultIndex = e.final ? Math.max(0, this.#finals.length - 1) : this.#finals.length;
        if (e.final && !text) return;
        this.dispatchEvent(new SpeechRecognitionEvent('result', { resultIndex, results: new SpeechRecognitionResultList(items) }));
        if (e.final && !this.continuous) this.stop();
      } else if (e.type === 'error') {
        clearTimeout(this.#timer);
        this.dispatchEvent(new SpeechRecognitionErrorEvent('error', { error: e.error ?? 'network', message: e.message }));
      } else if (e.type === 'end') {
        clearTimeout(this.#timer);
        running.delete(this.#id);
        this.#id = 0;
        if (this.#speech) { this.dispatchEvent(new Event('speechend')); this.dispatchEvent(new Event('soundend')); }
        if (this.#audio) this.dispatchEvent(new Event('audioend'));
        if (!this.#finals.length && this.#audio && this.#speech) this.dispatchEvent(new SpeechRecognitionEvent('nomatch'));
        this.dispatchEvent(new Event('end'));
      }
    }
    #noSpeech(): void {
      if (!this.#id || this.#speech || this.#stopping) return;
      this.dispatchEvent(new SpeechRecognitionErrorEvent('error', { error: 'no-speech' }));
      this.#stopping = true;
      void request(JSON.stringify({ op: 'abort', id: this.#id }));
    }
    /** on<event> attributes, as listeners (so the order with addEventListener is kept). */
    _handler(type: string): Handler { return this.#handlers.get(type) ?? null; }
    _setHandler(type: string, h: Handler): void {
      const old = this.#handlers.get(type);
      if (old) this.removeEventListener(type, old);
      this.#handlers.set(type, typeof h === 'function' ? h : null);
      if (typeof h === 'function') this.addEventListener(type, h);
    }
  }
  for (const type of EVENTS) {
    Object.defineProperty(SpeechRecognition.prototype, 'on' + type, {
      configurable: true, enumerable: true,
      get(this: SpeechRecognition) { return this._handler(type); },
      set(this: SpeechRecognition, h: Handler) { this._setHandler(type, h); },
    });
  }
  subscribe(json => {
    let e: { id: number; type: string };
    try { e = JSON.parse(json); } catch { return; }
    running.get(e.id)?._receive(e);
  });
  const globals: Record<string, unknown> = { SpeechRecognition, webkitSpeechRecognition: SpeechRecognition, SpeechRecognitionEvent, SpeechRecognitionErrorEvent, SpeechRecognitionResultList, SpeechRecognitionResult, SpeechRecognitionAlternative };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(window, name, { configurable: true, enumerable: false, writable: true, value });
}

/**
 * Runs in the page's main world, for the app's GPU check (see
 * SessionManager.gpuCheck):
 *   - counts the page's draw calls (WebGL) and submits (WebGPU) and tells the
 *     app once a second while there are some, and once more when they stop.
 *     These tell which tabs can load the GPU; timer queries in the page
 *     cannot tell, as they also count the time the GPU works for other tabs;
 *   - holds the page when the app asks: a moment, to see how much the GPU
 *     load goes down, or until the user resumes it (too much load). Level 1:
 *     requestAnimationFrame callbacks wait; level 2: also the callbacks of
 *     setTimeout and setInterval (one per timer). They run when the hold
 *     ends; the canvas keeps its last picture.
 * Not covered: workers (OffscreenCanvas).
 */
function installGpuProbe(report: (draws: number) => void, onHold: (cb: (level: number) => void) => void): void {
  let draws = 0, quiet = 2;
  const count = (proto: any, names: string[]) => {
    for (const name of names) {
      const orig = proto?.[name];
      if (typeof orig !== 'function') continue;
      proto[name] = function (this: unknown, ...args: unknown[]) { draws++; return orig.apply(this, args); };
    }
  };
  const DRAWS = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
  count(globalThis.WebGLRenderingContext?.prototype, DRAWS);
  count(globalThis.WebGL2RenderingContext?.prototype, DRAWS);
  count((globalThis as any).GPUQueue?.prototype, ['submit']);
  setInterval(() => {
    quiet = draws ? 0 : quiet + 1;
    if (quiet <= 1) report(draws);
    draws = 0;
  }, 1000);

  // While held, callbacks get ids of their own; when the hold ends they are
  // requested for real, and a cancel with the held id still finds them.
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  let held = false, nextId = 1e9;
  const waiting = new Map<number, FrameRequestCallback>(), real = new Map<number, number>();
  window.requestAnimationFrame = function requestAnimationFrame(cb: FrameRequestCallback): number {
    if (!held) return raf(cb);
    const id = nextId++;
    waiting.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id: number): void {
    if (waiting.delete(id)) return;
    const r = real.get(id);
    if (r !== undefined) { real.delete(id); return caf(r); }
    caf(id);
  };

  // Timers: a callback that comes while held waits, the newest one per timer.
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  let timersHeld = false;
  const later = new Map<object, () => void>();
  const guard = (cb: Function, args: unknown[]) => {
    const run = function (this: unknown) {
      if (timersHeld) { later.set(run, () => cb.apply(this, args)); return; }
      return cb.apply(this, args);
    };
    return run;
  };
  (window as any).setTimeout = function setTimeout(cb: unknown, ms?: number, ...args: unknown[]) {
    return typeof cb === 'function' ? st(guard(cb, args) as TimerHandler, ms) : st(cb as TimerHandler, ms, ...args);
  };
  (window as any).setInterval = function setInterval(cb: unknown, ms?: number, ...args: unknown[]) {
    return typeof cb === 'function' ? si(guard(cb, args) as TimerHandler, ms) : si(cb as TimerHandler, ms, ...args);
  };

  onHold(level => {
    held = level >= 1;
    timersHeld = level >= 2;
    if (!timersHeld && later.size) {
      const due = [...later.values()];
      later.clear();
      for (const f of due) st(f, 0);
    }
    if (held) return;
    real.clear();
    for (const [id, cb] of waiting) real.set(id, raf(cb));
    waiting.clear();
  });
}

contextBridge.executeInMainWorld({ func: installGpuProbe, args: [
  (draws: number) => ipcRenderer.send('habitab:draws', draws),
  (cb: (level: number) => void) => { ipcRenderer.on('habitab:hold-frames', (_e, level: number | boolean) => cb(Number(level) || 0)); },
] });

/**
 * Marking mode (annotate.js): each mark of the user follows an element of the
 * page, so it moves when the page scrolls, and stays where a fixed or sticky
 * element stays. Runs in this preload's world: the page does not see it, and
 * a held page (installGpuProbe) does not stop it.
 * The anchor is the innermost element at the mark's center that contains the
 * whole mark (else the element at its center). Without one, the mark scrolls
 * with the document.
 */
type Anchor = { el: Element | null; x: number; y: number; width: number; height: number };
const anchors = new Map<number, Anchor>();
let sent = '', loop = 0;

function anchorFor(r: { x: number; y: number; width: number; height: number }): Anchor {
  const root = (el: Element | null) => !el || el === document.body || el === document.documentElement;
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  const contains = (b: DOMRect) => b.left <= r.x + 2 && b.top <= r.y + 2 && b.right >= r.x + r.width - 2 && b.bottom >= r.y + r.height - 2;
  let el = hit;
  while (!root(el) && !contains(el!.getBoundingClientRect())) el = el!.parentElement;
  if (root(el)) el = root(hit) ? null : hit;
  // The offset to the anchor (or the place in the document).
  const b = el?.getBoundingClientRect() ?? { left: -scrollX, top: -scrollY };
  return { el, x: r.x - b.left, y: r.y - b.top, width: r.width, height: r.height };
}

/** Where the marks are now (CSS pixels of the viewport); `gone`: the element is no longer shown. */
function track(): void {
  loop = 0;
  if (!anchors.size) return;
  const now = [...anchors].map(([id, a]) => {
    if (a.el && !a.el.isConnected) return { id, gone: true };
    const b = a.el?.getBoundingClientRect() ?? { left: -scrollX, top: -scrollY, width: 1, height: 1 };
    if (!b.width && !b.height) return { id, gone: true };
    return { id, x: Math.round(b.left + a.x), y: Math.round(b.top + a.y), width: Math.round(a.width), height: Math.round(a.height) };
  });
  const json = JSON.stringify(now);
  if (json !== sent) { sent = json; ipcRenderer.send('habitab:marks', now); }
  loop = requestAnimationFrame(track);
}

if (window === window.top) {
  ipcRenderer.on('habitab:mark', (_e, m: { id: number; css: { x: number; y: number; width: number; height: number } }) => {
    anchors.set(m.id, anchorFor(m.css));
    sent = '';
    if (!loop) loop = requestAnimationFrame(track);
  });
  ipcRenderer.on('habitab:unmark', (_e, id: number | null) => {
    if (id === null) anchors.clear(); else anchors.delete(id);
    if (!anchors.size && loop) { cancelAnimationFrame(loop); loop = 0; sent = ''; }
  });
  // A click on a mark that is out of view: the page scrolls to it.
  ipcRenderer.on('habitab:mark-show', (_e, id: number) => {
    const a = anchors.get(id);
    if (!a) return;
    if (a.el?.isConnected) {
      // The anchor to the center (also in a scroll container); an anchor
      // larger than the view: the document scrolls to the mark in it.
      const b = a.el.getBoundingClientRect();
      if (b.height <= innerHeight && b.width <= innerWidth) a.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      else scrollBy({ left: b.left + a.x + a.width / 2 - innerWidth / 2, top: b.top + a.y + a.height / 2 - innerHeight / 2, behavior: 'smooth' });
    } else if (!a.el) scrollTo({ left: a.x - (innerWidth - a.width) / 2, top: a.y - (innerHeight - a.height) / 2, behavior: 'smooth' });
  });
}

if (process.platform === 'darwin') {
  contextBridge.executeInMainWorld({ func: installShare, args: [(json: string) => ipcRenderer.invoke('habitab:share', json)] });
}
// Linux has no recognizer yet (the API stays as Electron has it).
if (process.platform === 'darwin' || process.env?.HABITAB_FAKE_SPEECH === '1') {
  contextBridge.executeInMainWorld({ func: installSpeech, args: [
    (json: string) => ipcRenderer.invoke('habitab:speech', json),
    (cb: (json: string) => void) => { ipcRenderer.on('habitab:speech', (_e, json: string) => cb(json)); },
  ] });
}
