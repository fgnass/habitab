// Integration test for setup/uninstall against sandboxed client configs.
//
//   npm run build && node tests/integration/install.mjs
//
// Writes typical client configurations and edge cases into CLAUDE_CONFIG_DIR /
// CODEX_HOME sandboxes, plus entries wrapped by the launcher of Habitab 0.2.
// The real configurations are not read, so the result does not depend on the
// machine (or on a Habitab setup already applied there). Setup writes the
// global config of chrome-devtools-mcp (XDG_CONFIG_HOME) and unwraps.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './mcp-client.mjs';

const cli = path.resolve(import.meta.dirname, '../../dist/launcher/main.js');
// The real path: Claude Code keys projects by it (macOS: /var is a link to /private/var).
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-install-')));
const claudeDir = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), home = path.join(root, 'habitab');
const proj = path.join(root, 'proj');
// Second Codex project: taken over, then no longer trusted before uninstall.
const proj2 = path.join(root, 'proj2');
for (const d of [claudeDir, codexHome, home, path.join(proj, '.git'), path.join(proj, '.codex'), path.join(proj2, '.codex')]) fs.mkdirSync(d, { recursive: true });
// OpenCode, Cursor, Gemini CLI and Windsurf read their configs below $HOME.
const userHome = path.join(root, 'home');
const claudeBin = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim().split('\n').pop();
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, HABITAB_HOME: home, HOME: userHome, XDG_CONFIG_HOME: path.join(root, 'xdg'), HABITAB_CLAUDE_CLI: claudeBin };
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
const launcher = path.join(home, 'bin', 'habitab');
const browser = path.join(home, 'bin', 'habitab-browser');
const cd4aFile = path.join(root, 'xdg', 'cd4a', 'config.json');
// A launcher of Habitab 0.2 at another location: its entries are unwrapped too.
const oldLauncher = '/Applications/Old/habitab';

// --- Claude Code sandbox: user-scope entries (as `claude mcp add` writes them) + local + project cases.
const userServers = {
  'chrome-devtools': { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: {} },
  // Wrapped by Habitab 0.2: the original command comes back.
  'wrapped-devtools': { type: 'stdio', command: oldLauncher, args: ['mcp', '--', 'npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'], env: { DEBUG: '1' } },
  // Connects to a browser of its own (here an Electron app): not Habitab's business.
  'electron-devtools': { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9229'], env: {} },
  // The same, kept out of the global config: fine.
  'electron-kept': { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9229'], env: { CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1' } },
  'other-tool': { type: 'stdio', command: 'node', args: ['server.js'], env: {} },
};
const claudeJson = {
  numStartups: 1,
  mcpServers: userServers,
  projects: { [proj]: { mcpServers: { 'cdp-local': { type: 'stdio', command: oldLauncher, args: ['mcp', '--', 'npx', 'chrome-devtools-mcp@latest', '--viewport', '1024x768'], env: { DEBUG: '1' } } } } },
};
fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify(claudeJson, null, 2));
fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
  'team-browser': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--headless'] },
  'profile-browser': { command: 'npx', args: ['chrome-devtools-mcp', '--user-data-dir', '/tmp/x'] },
} }, null, 2));
const mcpJsonBefore = fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8');

// --- Codex sandbox: a typical config file (settings, another server, tool approvals)
// plus edge cases and a trusted project.
const baseToml = `model = "gpt-5-codex"
# My settings
approval_policy = "on-request"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[mcp_servers.chrome-devtools]
command = "npx"
args = ["-y", "chrome-devtools-mcp@latest"]

[mcp_servers.chrome-devtools.tools.take_screenshot]
approval_mode = "approve"
`;
const codexToml = baseToml + `

# Habitab test entries
[mcp_servers."cdp-quoted"]
command = 'npx'   # literal string, trailing comment
args = [
  "chrome-devtools-mcp@latest",   # multi-line array
  "--channel", "beta",
]
startup_timeout_sec = 30

[mcp_servers.cdp-noargs]
command = "/opt/homebrew/bin/chrome-devtools-mcp"
enabled = true

[mcp_servers.cdp-wrapped]
command = "${oldLauncher}"
args = ["mcp", "--", "npx", "chrome-devtools-mcp@latest"]   # Habitab 0.2
startup_timeout_sec = 20

[mcp_servers.cdp-external]
command = "npx"
args = ["chrome-devtools-mcp@latest", "-u", "http://127.0.0.1:9333"]

[mcp_servers]
cdp-inline = { command = "npx", args = ["chrome-devtools-mcp@latest"] }

[projects."${proj}"]
trust_level = "trusted"
`;
const proj2Trust = `\n[projects."${proj2}"]\ntrust_level = "trusted"\n`;
fs.writeFileSync(path.join(codexHome, 'config.toml'), codexToml + proj2Trust);
fs.writeFileSync(path.join(proj, '.codex', 'config.toml'), `[mcp_servers.proj-cdp]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest", "--isolated"]\n`);
const proj2Toml = `[mcp_servers.proj2-cdp]\ncommand = "${oldLauncher}"\nargs = ["mcp", "--", "npx", "chrome-devtools-mcp@latest"]\n`;
fs.writeFileSync(path.join(proj2, '.codex', 'config.toml'), proj2Toml);

// --- JSON clients: OpenCode (JSONC with comments), Cursor (user + project), Gemini CLI, Windsurf
const jsonFiles = {
  opencode: [path.join(userHome, '.config', 'opencode', 'opencode.jsonc'), `{
  // my OpenCode config
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "mcp": {
    "oc-browser": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"], // the browser
      "enabled": true,
    },
    "remote-thing": { "type": "remote", "url": "https://example.com/mcp" },
  },
}
`],
  cursor: [path.join(userHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'cursor-browser': { command: oldLauncher, args: ['mcp', '--', 'npx', 'chrome-devtools-mcp@latest'], env: { DEBUG: '1' } } } }, null, 2) + '\n'],
  cursorProject: [path.join(proj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'cursor-proj': { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] } } }, null, 2) + '\n'],
  gemini: [path.join(userHome, '.gemini', 'settings.json'), JSON.stringify({ theme: 'GitHub', mcpServers: { 'gemini-browser': { command: '/usr/local/bin/chrome-devtools-mcp', timeout: 30000 } } }, null, 2) + '\n'],
  windsurf: [path.join(userHome, '.codeium', 'windsurf', 'mcp_config.json'), '{\n\t"mcpServers": {\n\t\t"ws-browser": {\n\t\t\t"command": "/Applications/Old/habitab",\n\t\t\t"args": ["mcp", "--", "npx", "chrome-devtools-mcp@latest"]\n\t\t},\n\t\t"ws-external": {\n\t\t\t"command": "npx",\n\t\t\t"args": ["chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:9222"]\n\t\t}\n\t}\n}\n'],
};
for (const [file, text] of Object.values(jsonFiles)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const jsonText = k => fs.readFileSync(jsonFiles[k][0], 'utf8');

// --- 1. Preview
const preview = run('setup');
const status = name => (preview.match(new RegExp(`^\\[(\\w+)\\] [^\\n]*· ${name} ·`, 'm')) ?? [])[1];
check(/\[todo\] Habitab's browser is not configured/.test(preview), 'preview: the global config is not set yet');
check(status('chrome-devtools') === 'ok', 'plain Claude/Codex entries are fine as they are');
check(status('wrapped-devtools') === 'unwrap' && status('cdp-local') === 'unwrap', 'Claude entries wrapped by Habitab 0.2 are proposed for unwrapping');
check(status('electron-devtools') === 'conflict' && preview.includes('CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY'), 'external --browser-url entry reported as conflict with the hint');
check(status('electron-kept') === 'ok', 'an entry kept out of the global config by its env is fine');
check(!preview.includes('other-tool'), 'non chrome-devtools servers are ignored');
check(status('team-browser') === 'ok' && preview.includes('Project'), 'Claude .mcp.json entry found');
check(status('profile-browser') === 'ok' && preview.includes('--userDataDir has no effect'), '--user-data-dir entry is fine, with a note');
check(status('cdp-quoted') === 'conflict', 'Codex --channel entry reported as conflict');
check(status('cdp-noargs') === 'ok', 'Codex entry without args parsed');
check(status('cdp-wrapped') === 'unwrap', 'Codex wrapped entry proposed for unwrapping');
check(status('cdp-external') === 'conflict', 'Codex -u alias recognized as conflict');
check(status('cdp-inline') === 'unsupported', 'Codex inline table reported as unsupported');
check(status('proj-cdp') === 'ok', 'Codex trusted project file found');
check(status('oc-browser') === 'ok' && !preview.includes('remote-thing'), 'OpenCode JSONC entry found, remote server ignored');
check(status('cursor-browser') === 'unwrap' && status('cursor-proj') === 'ok', 'Cursor wrapped user entry and plain project entry');
check(status('gemini-browser') === 'ok', 'Gemini CLI entry without args found');
check(status('ws-browser') === 'unwrap' && status('ws-external') === 'conflict', 'Windsurf wrapped entry and external one');
check(status('proj2-cdp') === 'unwrap', 'second Codex trusted project file: wrapped entry found');

// --- 2. Apply: global config, plus unwrapping everything except the Codex project file of proj2
const ids = [...preview.matchAll(/^\s+id: (.+)$/gm)].map(m => m[1]).filter(id => !id.includes(`|${proj2}|`));
const applied = run('setup', '--apply', ...ids);
check(!applied.includes('✗'), 'apply without errors', applied.split('\n').filter(l => l.includes('✗')).join(' | '));
check(fs.existsSync(browser) && fs.existsSync(launcher), 'the habitab command and the browser script are installed');
check(JSON.parse(fs.readFileSync(cd4aFile, 'utf8')).executablePath === browser, 'the global config names the browser script', fs.readFileSync(cd4aFile, 'utf8'));
const cj = JSON.parse(fs.readFileSync(path.join(claudeDir, '.claude.json'), 'utf8'));
check(JSON.stringify(cj.mcpServers['chrome-devtools']) === JSON.stringify(userServers['chrome-devtools']), 'plain Claude entry unchanged');
const uw = cj.mcpServers['wrapped-devtools'];
check(uw && uw.command === 'npx' && uw.args.join(' ') === '-y chrome-devtools-mcp@latest --isolated' && uw.env.DEBUG === '1', 'Claude wrapped entry unwrapped, env kept', JSON.stringify(uw));
const local = cj.projects[proj].mcpServers;
check(local['cdp-local'].command === 'npx' && local['cdp-local'].args.join(' ') === 'chrome-devtools-mcp@latest --viewport 1024x768' && local['cdp-local'].env.DEBUG === '1', 'Claude local entry unwrapped, env kept');
check(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8') === mcpJsonBefore, 'shared .mcp.json unchanged');
const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
check(toml.startsWith(baseToml), 'Codex file before the wrapped entry byte-identical');
check(toml.includes('[mcp_servers.cdp-wrapped]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest"]   # Habitab 0.2\nstartup_timeout_sec = 20'), 'Codex wrapped entry unwrapped, comment and other keys kept', toml.match(/\[mcp_servers\.cdp-wrapped\][^[]*/)?.[0]);
check(toml.includes('args = ["chrome-devtools-mcp@latest", "-u", "http://127.0.0.1:9333"]'), 'Codex external entry unchanged');
check(fs.readFileSync(path.join(proj2, '.codex', 'config.toml'), 'utf8') === proj2Toml, 'skipped Codex project file untouched');
{
  const cu = JSON.parse(jsonText('cursor')).mcpServers['cursor-browser'];
  check(cu.command === 'npx' && cu.args.join(' ') === 'chrome-devtools-mcp@latest' && cu.env.DEBUG === '1', 'Cursor: unwrapped, env kept', JSON.stringify(cu));
  const ws = jsonText('windsurf');
  check(ws.includes('\t\t"ws-external"') && JSON.parse(ws).mcpServers['ws-browser'].command === 'npx', 'Windsurf: unwrapped, tab indentation kept');
  check(jsonText('opencode') === jsonFiles.opencode[1] && jsonText('gemini') === jsonFiles.gemini[1], 'OpenCode and Gemini CLI files untouched');
}

// --- 3. Idempotent
const again = run('setup');
check(/\[ok\] executablePath names Habitab's browser/.test(again), 'second run: the global config is set');
const pendingAgain = again.split('\n').filter(l => /^\[unwrap\]/.test(l) && !l.includes('proj2-cdp'));
check(pendingAgain.length === 0, 'second run proposes nothing new (except the skipped project file)', pendingAgain.join(' | '));

// --- 4. Uninstall: the global config loses the entry, the skipped project file is unwrapped too
const un = run('uninstall');
check(!un.includes('✗'), 'uninstall without errors', un.split('\n').filter(l => l.includes('✗')).join(' | '));
check(!fs.existsSync(cd4aFile), 'uninstall removes the global config entry (the file had nothing else)');
check(fs.readFileSync(path.join(proj2, '.codex', 'config.toml'), 'utf8').includes('command = "npx"'), 'Codex project file unwrapped on uninstall');
check(!/\[unwrap\]/.test(run('setup')), 'nothing left to unwrap');

fs.rmSync(root, { recursive: true, force: true });
