// Entry point of the `habitab` command.
// The script in Habitab's bin folder starts this file with the app's runtime
// via ELECTRON_RUN_AS_NODE. Child processes must not inherit it: `open` passes
// the environment on, and the app would start as plain Node and exit.
delete process.env.ELECTRON_RUN_AS_NODE;
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { runBrowser } from './browser';
import { applyCd4a, cd4aStatus, removeCd4a } from '../installer/cd4a';
import { installLauncher, legacyBrowsers, legacyServers, scan, unwrap } from '../installer/installer';
import { paths } from '../shared/paths';
import { clientLabel, commandLine, Finding, isActionable, location } from '../installer/model';

const usage = `habitab – one home for your agent browsers

  habitab setup                 Show the global config of chrome-devtools-mcp (cd4a) and the
                                chrome-devtools-mcp entries of the client configurations
  habitab setup --apply [ids]   Name Habitab's browser as executablePath in the global config
                                and remove the launcher wrappers of Habitab 0.2 (all, or the given ids)
  habitab uninstall             Remove the entry from the global config and all wrappers
  habitab status                Configurations, sessions that need a restart, old MCP browsers
  habitab cd4a [--apply|--remove]   Only the global config
  habitab browser <args...>     Started by chrome-devtools-mcp in place of Chrome (executablePath)
  habitab mcp -- <command...>   Runs the command unchanged (what Habitab 0.2 configurations call)
`;

function describe(f: Finding): string {
  const lines = [`[${f.status}] ${clientLabel(f.client)} · ${f.name} · ${location(f)}`, `    id: ${f.id}`];
  if (f.command) lines.push(`    now:   ${commandLine(f.command, f.args)}`);
  if (f.proposedCommand) lines.push(`    after: ${commandLine(f.proposedCommand, f.proposedArgs!)}`);
  lines.push(`    ${f.detail}`);
  return lines.join('\n');
}

function cd4aLines(): string[] {
  const s = cd4aStatus();
  const out = [`Global config of chrome-devtools-mcp: ${s.file}${s.exists ? '' : ' (not present)'}`];
  if (s.invalid) out.push(`  not valid JSON: ${s.invalid}`);
  else if (s.exists) out.push(`  ${JSON.stringify(s.config)}`);
  out.push(s.habitab ? `  [ok] executablePath names Habitab's browser: every chrome-devtools-mcp (1.10 or newer) opens its browser in Habitab.`
    : `  [todo] Habitab's browser is not configured.`);
  if (s.conflicts.length) out.push(`  ${s.conflicts.join(', ')} cannot be combined with executablePath.`);
  return out;
}

function restartHint(): void {
  const all = legacyServers();
  const legacy = all.filter(l => !l.replaced), leftover = all.filter(l => l.replaced);
  if (legacy.length) {
    console.log(`\nRestart required: ${legacy.length} running session(s) still use their old browser.`);
    for (const l of legacy) console.log(`  ${l.client} (pid ${l.clientPid ?? '?'})`);
    console.log('Claude Code: /mcp → reconnect the server, or restart the session. Codex: restart the session.');
  }
  if (leftover.length) {
    console.log(`\nAlready reconnected, but the old server process still runs (pid ${leftover.map(l => l.pid).join(', ')}).`);
    console.log('It ends with its session, or quit it yourself.');
  }
}

/** Runs a command unchanged with inherited stdio and relays its exit (0.2 configurations). */
function passThrough(argv: string[]): void {
  if (!argv.length) { process.stderr.write('habitab mcp: missing command after --\n'); process.exit(64); }
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  child.on('error', e => { process.stderr.write(`habitab: ${e.message}\n`); process.exit(127); });
}

const printResults = (results: ReturnType<typeof unwrap>) => {
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.finding.name} (${location(r.finding)}): ${r.message}`);
};

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'mcp':
      return passThrough(rest[0] === '--' ? rest.slice(1) : rest);
    case 'browser':
      return runBrowser(rest);
    case 'setup': {
      for (const l of cd4aLines()) console.log(l);
      const findings = scan();
      console.log(findings.length ? '\nConfigurations:' : '\nNo chrome-devtools-mcp entries found in the client configurations.');
      for (const f of findings) console.log(describe(f) + '\n');
      if (!rest.includes('--apply')) { console.log('To apply: habitab setup --apply'); return; }
      // The app normally installs the scripts; without the app the CLI installs ones that use the current runtime.
      if (!fs.existsSync(paths.browser)) installLauncher(process.execPath, __filename);
      const r = applyCd4a();
      console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
      const ids = new Set(rest.filter(a => !a.startsWith('--')));
      printResults(unwrap(findings.filter(f => isActionable(f) && (!ids.size || ids.has(f.id)))));
      restartHint();
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'uninstall': {
      const r = removeCd4a();
      console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
      const results = unwrap();
      printResults(results);
      console.log('Running sessions keep their browser in Habitab until they restart.');
      return;
    }
    case 'status': {
      for (const l of cd4aLines()) console.log(l);
      console.log('\nConfigurations:');
      for (const f of scan()) console.log(`  [${f.status}] ${clientLabel(f.client)} · ${f.name} · ${location(f)}`);
      restartHint();
      const lb = legacyBrowsers();
      if (lb.length) {
        console.log('\nBrowsers started by chrome-devtools-mcp:');
        for (const b of lb) console.log(`  pid ${b.pid} ${b.orphaned ? 'ORPHANED' : ''} ${b.profile}`);
      }
      return;
    }
    case 'cd4a': {
      if (rest.includes('--apply') || rest.includes('--remove')) {
        if (!fs.existsSync(paths.browser)) installLauncher(process.execPath, __filename);
        const r = rest.includes('--apply') ? applyCd4a() : removeCd4a();
        console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
        if (r.ok) console.log('Servers started from now on use it; running sessions keep their browser until they restart.');
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      for (const l of cd4aLines()) console.log(l);
      return;
    }
    default:
      console.log(usage);
  }
}

main().catch(e => { process.stderr.write(`habitab: ${e?.message ?? e}\n`); process.exit(1); });
