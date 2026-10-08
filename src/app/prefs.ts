// User preferences of the app (window layout, projects with a persistent profile).
import fs from 'node:fs';
import { paths } from '../shared/paths';

export type SidebarMode = 'full' | 'compact' | 'hidden';

/** What the sidebar shows: hidden wins over the chosen width. */
export const sidebarMode = (): SidebarMode => (prefs().sidebarHidden ? 'hidden' : prefs().sidebarCompact ? 'compact' : 'full');

export interface Prefs {
  devtoolsRatio?: number;
  /** Thumbnails only (narrow) instead of thumbnails with titles. */
  sidebarCompact?: boolean;
  sidebarHidden?: boolean;
  /** Project roots whose browser profile (cookies, storage, cache) is stored on disk. */
  persistentProfiles?: string[];
}

let cache: Prefs | undefined;

export function prefs(): Prefs {
  if (!cache) {
    try { cache = JSON.parse(fs.readFileSync(paths.ui, 'utf8')) as Prefs; } catch { cache = {}; }
  }
  return cache;
}

export function setPrefs(change: Partial<Prefs>): void {
  cache = { ...prefs(), ...change };
  try { fs.writeFileSync(paths.ui, JSON.stringify(cache, null, 2), { mode: 0o600 }); } catch {}
}
