// Downloads of the session pages: where a file goes, and what the status line learns about it.
import fs from 'node:fs';
import path from 'node:path';

export type Download = { session: string; name: string; file: string; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; received: number; total: number };

/** Paths of the downloads that run now: their files may not exist yet. */
export const downloading = new Set<string>();

/** A free path for a download in `dir`, like Chrome: "name.ext", else "name (1).ext", "name (2).ext", … */
export function freeDownloadPath(dir: string, name: string, taken = (p: string) => downloading.has(p) || fs.existsSync(p)): string {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length) || 'download';
  for (let i = 0; ; i++) {
    const p = path.join(dir, i ? `${base} (${i})${ext}` : `${base}${ext}`);
    if (!taken(p)) return p;
  }
}
