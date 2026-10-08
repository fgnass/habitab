// Stands in for Claude Code started with channels: its own command line has
// `--dangerously-load-development-channels server:<name>` (what the launcher
// checks); everything after `--` runs as its child with the same stdio.
//   node channel-parent.mjs --dangerously-load-development-channels server:chrome-devtools -- <command> ...
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const [cmd, ...args] = process.argv.slice(sep + 1);
const child = spawn(cmd, args, { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
