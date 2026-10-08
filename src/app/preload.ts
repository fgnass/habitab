// Bridge for Habitab's own UI views (never loaded into session pages).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('habitab', {
  onState: (cb: (state: unknown) => void) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusUrl: (cb: () => void) => ipcRenderer.on('focus-url', () => cb()),
  onFocusSearch: (cb: () => void) => ipcRenderer.on('focus-search', () => cb()),
  onThumb: (cb: (id: string, url: string | null) => void) => ipcRenderer.on('thumb', (_e, id, url) => cb(id, url)),
  action: (name: string, ...args: unknown[]) => ipcRenderer.invoke('action', name, ...args),
  setup: (op: string, ids?: string[]) => ipcRenderer.invoke('setup', op, ids),
  platform: process.platform,
});
