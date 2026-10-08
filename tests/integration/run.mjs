// Runs all integration tests against separate Habitab instances.
//   npm run test:integration
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const dir = import.meta.dirname;
let failed = 0;
for (const t of ['app.mjs', 'install.mjs']) {
  console.log(`\n== ${t}`);
  const r = spawnSync(process.execPath, [path.join(dir, t)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: { ...process.env, HABITAB_SOCKET: process.env.HABITAB_SOCKET ?? path.join(os.tmpdir(), `hb-it-${process.pid}.sock`) },
  });
  const lines = r.stdout.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
  for (const l of lines) console.log(l);
  if (r.status !== 0 || lines.some(l => l.startsWith('FAIL'))) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nAll integration tests passed.');
process.exit(failed ? 1 : 0);
