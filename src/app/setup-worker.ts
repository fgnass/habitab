// Installer operations off the main thread (the Claude CLI runs synchronously).
import { parentPort, workerData } from 'node:worker_threads';
import { apply, endLegacyBrowser, legacyBrowsers, legacyServers, scan, uninstall } from '../installer/installer';
import { commandLine, isActionable, location } from '../installer/model';

const view = (f: ReturnType<typeof scan>[number]) => ({
  ...f, entry: undefined, location: location(f), actionable: isActionable(f),
  line: f.command ? commandLine(f.command, f.args) : '', proposedLine: f.proposedCommand ? commandLine(f.proposedCommand, f.proposedArgs!) : null,
});

const { op, ids } = workerData as { op: string; ids?: string[] };
let result: unknown;
try {
  if (op === 'scan') {
    result = { findings: scan().map(view), legacyServers: legacyServers(), legacyBrowsers: legacyBrowsers() };
  } else if (op === 'apply') {
    const chosen = new Set(ids ?? []);
    result = { results: apply(scan().filter(f => isActionable(f) && chosen.has(f.id))).map(r => ({ ...r, finding: view(r.finding) })) };
  } else if (op === 'uninstall') {
    result = { results: uninstall().map(r => ({ ...r, finding: view(r.finding) })) };
  } else if (op === 'endLegacy') {
    const b = legacyBrowsers().find(x => String(x.pid) === ids?.[0]);
    result = { ok: !!b && endLegacyBrowser(b) };
  }
} catch (e: any) {
  result = { error: e.message };
}
parentPort?.postMessage(result);
