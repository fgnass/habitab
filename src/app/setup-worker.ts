// Installer operations off the main thread (the Claude CLI runs synchronously).
import { parentPort, workerData } from 'node:worker_threads';
import { endLegacyBrowser, legacyBrowsers, legacyServers, scan, unwrap } from '../installer/installer';
import { applyCd4a, cd4aStatus, removeCd4a } from '../installer/cd4a';
import { commandLine, isActionable, location } from '../installer/model';

const view = (f: ReturnType<typeof scan>[number]) => ({
  ...f, entry: undefined, location: location(f), actionable: isActionable(f),
  line: f.command ? commandLine(f.command, f.args) : '', proposedLine: f.proposedCommand ? commandLine(f.proposedCommand, f.proposedArgs!) : null,
});

const { op, ids } = workerData as { op: string; ids?: string[] };
let result: unknown;
try {
  if (op === 'scan') {
    result = { cd4a: cd4aStatus(), findings: scan().map(view), legacyServers: legacyServers(), legacyBrowsers: legacyBrowsers() };
  } else if (op === 'apply') {
    // The global config, plus the removal of the chosen 0.2 launcher wrappers.
    const cd4a = applyCd4a();
    const chosen = new Set(ids ?? []);
    result = { cd4a, results: unwrap(scan().filter(f => isActionable(f) && chosen.has(f.id))).map(r => ({ ...r, finding: view(r.finding) })) };
  } else if (op === 'migrate') {
    // At app start: the global config when nothing is in the way, and the removal of 0.2 launcher wrappers.
    // ids ['cd4a']: only the global config (tests: the client configurations are the real ones).
    const s = cd4aStatus();
    const cd4a = s.habitab || s.invalid || s.conflicts.length ? undefined : applyCd4a();
    const findings = ids?.includes('cd4a') ? [] : scan().filter(isActionable);
    result = { cd4a, results: findings.length ? unwrap(findings).map(r => ({ ...r, finding: view(r.finding) })) : [] };
  } else if (op === 'uninstall') {
    result = { cd4a: removeCd4a(), results: unwrap().map(r => ({ ...r, finding: view(r.finding) })) };
  } else if (op === 'endLegacy') {
    const b = legacyBrowsers().find(x => String(x.pid) === ids?.[0]);
    result = { ok: !!b && endLegacyBrowser(b) };
  }
} catch (e: any) {
  result = { error: e.message };
}
parentPort?.postMessage(result);
