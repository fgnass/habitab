// Bridge for Habitab's own UI views (never loaded into session pages).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('habitab', {
  onState: (cb: (state: unknown) => void) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusUrl: (cb: () => void) => ipcRenderer.on('focus-url', () => cb()),
  onAnnotateRect: (cb: (rect: { x: number; y: number; width: number; height: number }) => void) => ipcRenderer.on('annotate-rect', (_e, r) => cb(r)),
  onFocusSearch: (cb: () => void) => ipcRenderer.on('focus-search', () => cb()),
  onThumb: (cb: (tabId: number, url: string | null) => void) => ipcRenderer.on('thumb', (_e, id, url) => cb(id, url)),
  action: (name: string, ...args: unknown[]) => ipcRenderer.invoke('action', name, ...args),
  setup: (op: string, ids?: string[]) => ipcRenderer.invoke('setup', op, ids),
  platform: process.platform,
});

// Styles that differ by platform use :root[data-platform=…].
const markPlatform = () => { if (document.documentElement) document.documentElement.dataset.platform = process.platform; };
markPlatform();
window.addEventListener('DOMContentLoaded', markPlatform);

// The UI writes key hints in macOS notation (⇧⌘P). Other platforms see their own
// (Ctrl+Shift+P), with the accelerators of the menu where they differ.
if (process.platform !== 'darwin') {
  const special: Record<string, string> = { '⌥⌘I': 'Ctrl+Shift+I', '⌃⌘S': 'Ctrl+Shift+S' };
  const keys = (s: string) => s.replace(/[⌃⌥⇧⌘]+./g, k => special[k] ?? [
    k.includes('⌘') || k.includes('⌃') ? 'Ctrl' : '', k.includes('⌥') ? 'Alt' : '', k.includes('⇧') ? 'Shift' : '', k.slice(-1).toUpperCase(),
  ].filter(Boolean).join('+'));
  const fix = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { if (/[⌃⌥⇧⌘]/.test(node.nodeValue!)) node.nodeValue = keys(node.nodeValue!); return; }
    if (!(node instanceof Element)) return;
    for (const el of [node, ...node.querySelectorAll('[title]')]) {
      const t = el.getAttribute('title');
      if (t && /[⌃⌥⇧⌘]/.test(t)) el.setAttribute('title', keys(t));
    }
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) fix(walk.currentNode);
  };
  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes' || r.type === 'characterData') fix(r.target);
      else r.addedNodes.forEach(fix);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });
}
