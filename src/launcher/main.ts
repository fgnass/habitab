// Entry point of the `habitab` command.
// The launcher script starts this file with the app's runtime via
// ELECTRON_RUN_AS_NODE. Child processes must not inherit it: `open` passes
// the environment on, and the app would start as plain Node and exit.
delete process.env.ELECTRON_RUN_AS_NODE;
import { runMcp } from './launcher';
import fs from 'node:fs';
import { apply, installLauncher, legacyBrowsers, legacyServers, scan, uninstall } from '../installer/installer';
import { paths } from '../shared/paths';
import { clientLabel, commandLine, Finding, isActionable, location } from '../installer/model';

const usage = `habitab – one home for your agent browsers

  habitab mcp -- <command...>   Run a chrome-devtools-mcp command through Habitab
                                (this is what client configurations call)
  habitab setup                 Show which MCP configurations Habitab would change
  habitab setup --apply [ids]   Apply the proposed changes (all, or the given ids)
  habitab uninstall             Restore all configurations
  habitab status                Configurations and sessions that still need a restart
`;

function describe(f: Finding): string {
  const lines = [`[${f.status}] ${clientLabel(f.client)} · ${f.name} · ${location(f)}`, `    id: ${f.id}`];
  if (f.command) lines.push(`    now:   ${commandLine(f.command, f.args)}`);
  if (f.proposedCommand) lines.push(`    after: ${commandLine(f.proposedCommand, f.proposedArgs!)}`);
  lines.push(`    ${f.detail}`);
  return lines.join('\n');
}

function restartHint(): void {
  const all = legacyServers();
  const legacy = all.filter(l => !l.replaced), leftover = all.filter(l => l.replaced);
  if (legacy.length) {
    console.log(`\nRestart required: ${legacy.length} running session(s) still use the old configuration.`);
    for (const l of legacy) console.log(`  ${l.client} (pid ${l.clientPid ?? '?'})`);
    console.log('Claude Code: /mcp → reconnect the server, or restart the session. Codex: restart the session.');
  }
  if (leftover.length) {
    console.log(`\nAlready reconnected, but the old server process still runs (pid ${leftover.map(l => l.pid).join(', ')}).`);
    console.log('It ends with its session, or quit it yourself.');
  }
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'mcp':
      return runMcp(rest[0] === '--' ? rest.slice(1) : rest);
    case 'setup': {
      const findings = scan();
      if (!findings.length) console.log('No chrome-devtools-mcp entries found.');
      for (const f of findings) console.log(describe(f) + '\n');
      if (!rest.includes('--apply')) { console.log('To apply: habitab setup --apply'); return; }
      // The app normally installs the launcher script; without the app the
      // CLI installs one that uses the current runtime.
      if (!fs.existsSync(paths.launcher)) installLauncher(process.execPath, __filename);
      const ids = new Set(rest.filter(a => !a.startsWith('--')));
      for (const r of apply(findings.filter(f => isActionable(f) && (!ids.size || ids.has(f.id))))) {
        console.log(`${r.ok ? '✓' : '✗'} ${r.finding.name} (${location(r.finding)}): ${r.message}`);
      }
      restartHint();
      return;
    }
    case 'uninstall': {
      const results = uninstall();
      if (!results.length) console.log('No Habitab entries found.');
      for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.finding.name} (${location(r.finding)}): ${r.message}`);
      if (results.length) console.log('Running sessions keep using Habitab until they restart.');
      return;
    }
    case 'status': {
      console.log('Configurations:');
      for (const f of scan()) console.log(`  [${f.status}] ${clientLabel(f.client)} · ${f.name} · ${location(f)}`);
      restartHint();
      const lb = legacyBrowsers();
      if (lb.length) {
        console.log('\nBrowsers started by chrome-devtools-mcp:');
        for (const b of lb) console.log(`  pid ${b.pid} ${b.orphaned ? 'ORPHANED' : ''} ${b.profile}`);
      }
      return;
    }
    default:
      console.log(usage);
  }
}

main().catch(e => { process.stderr.write(`habitab: ${e?.message ?? e}\n`); process.exit(1); });
