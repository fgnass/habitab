// Preload of the session pages (sandboxed, isolated world). Electron lacks the
// Web Share API (Chromium has it in //chrome), so pages get navigator.share()
// and navigator.canShare() here, before their own scripts run; a share opens
// the macOS share menu (see the 'habitab:share' handler in main.ts).
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

if (process.platform === 'darwin') {
  contextBridge.executeInMainWorld({ func: installShare, args: [(json: string) => ipcRenderer.invoke('habitab:share', json)] });
}
