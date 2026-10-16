// Integration test for setup/uninstall against sandboxed client configs.
//
//   npm run build && node tests/integration/install.mjs
//
// Copies the chrome-devtools-mcp entries of the real configurations (read
// only) into CLAUDE_CONFIG_DIR / CODEX_HOME sandboxes and adds edge cases.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './mcp-client.mjs';

const cli = path.resolve(import.meta.dirname, '../../dist/launcher/main.js');
const root = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'hb-install-'));
const claudeDir = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), home = path.join(root, 'habitab');
const proj = path.join(root, 'proj');
// Second Codex project: taken over, then no longer trusted before uninstall.
const proj2 = path.join(root, 'proj2');
for (const d of [claudeDir, codexHome, home, path.join(proj, '.git'), path.join(proj, '.codex'), path.join(proj2, '.codex')]) fs.mkdirSync(d, { recursive: true });
// OpenCode, Cursor, Gemini CLI and Windsurf read their configs below $HOME.
const userHome = path.join(root, 'home');
const claudeBin = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim().split('\n').pop();
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, HABITAB_HOME: home, HOME: userHome, HABITAB_CLAUDE_CLI: claudeBin };
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
const launcher = path.join(home, 'bin', 'habitab');

// --- Claude Code sandbox: real user-scope entries + local + project cases.
const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
const userServers = Object.fromEntries(Object.entries(real.mcpServers ?? {}).filter(([, v]) => JSON.stringify(v).includes('chrome-devtools-mcp')));
userServers['other-tool'] = { type: 'stdio', command: 'node', args: ['server.js'], env: {} };
const claudeJson = {
  numStartups: 1,
  mcpServers: userServers,
  projects: { [proj]: { mcpServers: { 'cdp-local': { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest', '--viewport', '1024x768'], env: { DEBUG: '1' } } } } },
};
fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify(claudeJson, null, 2));
fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
  'team-browser': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--headless'] },
  'profile-browser': { command: 'npx', args: ['chrome-devtools-mcp', '--user-data-dir', '/tmp/x'] },
} }, null, 2));
const mcpJsonBefore = fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8');

// --- Codex sandbox: the real config file plus edge cases and a trusted project.
// Trusted projects of the real file are removed: they would point the scan
// at real project files outside the sandbox.
const realToml = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')
  .replace(/^\[projects\.[^\n]*\]\n(?:[^\[\n][^\n]*\n|\n)*/gm, '');
const codexToml = realToml + `

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
const proj2Toml = `[mcp_servers.proj2-cdp]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest"]\n`;
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
  cursor: [path.join(userHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'cursor-browser': { command: 'npx', args: ['chrome-devtools-mcp@latest'], env: { DEBUG: '1' } } } }, null, 2) + '\n'],
  cursorProject: [path.join(proj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'cursor-proj': { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] } } }, null, 2) + '\n'],
  gemini: [path.join(userHome, '.gemini', 'settings.json'), JSON.stringify({ theme: 'GitHub', mcpServers: { 'gemini-browser': { command: '/usr/local/bin/chrome-devtools-mcp', timeout: 30000 } } }, null, 2) + '\n'],
  windsurf: [path.join(userHome, '.codeium', 'windsurf', 'mcp_config.json'), '{\n\t"mcpServers": {\n\t\t"ws-browser": {\n\t\t\t"command": "npx",\n\t\t\t"args": ["chrome-devtools-mcp@latest"]\n\t\t},\n\t\t"ws-external": {\n\t\t\t"command": "npx",\n\t\t\t"args": ["chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:9222"]\n\t\t}\n\t}\n}\n'],
};
for (const [file, text] of Object.values(jsonFiles)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const jsonText = k => fs.readFileSync(jsonFiles[k][0], 'utf8');

// --- 1. Preview
const preview = run('setup');
const status = name => (preview.match(new RegExp(`^\\[(\\w+)\\] [^\\n]*· ${name} ·`, 'm')) ?? [])[1];
check(status('chrome-devtools') === 'migrate', 'real Claude/Codex chrome-devtools entries proposed');
check(status('electron-devtools') === 'external' || !userServers['electron-devtools'], 'external --browser-url entry left alone');
check(!preview.includes('other-tool'), 'non chrome-devtools servers are ignored');
check(status('cdp-local') === 'migrate', 'Claude local scope entry proposed');
check(status('team-browser') === 'migrate' && preview.includes('Project'), 'Claude .mcp.json entry proposed');
check(status('profile-browser') === 'persistentProfile', '--user-data-dir entry not taken over');
check(status('cdp-quoted') === 'migrate', 'Codex quoted table + multi-line array parsed');
check(status('cdp-noargs') === 'migrate', 'Codex entry without args parsed');
check(status('cdp-external') === 'external', 'Codex -u alias recognized as external');
check(status('cdp-inline') === 'unsupported', 'Codex inline table reported as unsupported');
check(status('proj-cdp') === 'migrate', 'Codex trusted project file found');
check(status('oc-browser') === 'migrate' && !preview.includes('remote-thing'), 'OpenCode JSONC entry proposed, remote server ignored');
check(status('cursor-browser') === 'migrate' && status('cursor-proj') === 'migrate', 'Cursor user and project entries proposed');
check(status('gemini-browser') === 'migrate', 'Gemini CLI entry without args proposed');
check(status('ws-browser') === 'migrate' && status('ws-external') === 'external', 'Windsurf entry proposed, external one left alone');
check(status('proj2-cdp') === 'migrate', 'second Codex trusted project file found');

// --- 2. Apply everything except the shared Codex project file of proj
const ids = [...preview.matchAll(/^\s+id: (.+)$/gm)].map(m => m[1]).filter(id => !id.startsWith('codex|project') || id.includes(`|${proj2}|`));
const applied = run('setup', '--apply', ...ids);
check(!applied.includes('✗'), 'apply without errors', applied.split('\n').filter(l => l.includes('✗')).join(' | '));
const cj = JSON.parse(fs.readFileSync(path.join(claudeDir, '.claude.json'), 'utf8'));
const cdt = cj.mcpServers['chrome-devtools'];
check(cdt && cdt.command === launcher && cdt.args[0] === 'mcp' && cdt.args[1] === '--', 'Claude user entry wrapped', JSON.stringify(cdt));
check(JSON.stringify(cj.mcpServers['other-tool']) === JSON.stringify(userServers['other-tool']), 'unrelated Claude server unchanged');
const local = cj.projects[proj].mcpServers;
check(local['cdp-local'].command === launcher && local['cdp-local'].env.DEBUG === '1', 'Claude local entry wrapped, env kept');
check(local['team-browser']?.command === launcher, 'Claude project entry shadowed by local override');
check(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8') === mcpJsonBefore, 'shared .mcp.json unchanged');
const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
check(toml.startsWith(realToml.split('[mcp_servers.chrome-devtools]')[0]), 'Codex file before the entry byte-identical');
check(toml.includes('[mcp_servers.chrome-devtools.tools.take_screenshot]\napproval_mode = "approve"'), 'Codex tool approvals kept');
check(toml.includes('startup_timeout_sec = 30') && toml.includes('enabled = true'), 'Codex other keys kept');
check(/\[mcp_servers\.cdp-noargs\]\ncommand = ".*habitab"\nargs = \["mcp", "--", "\/opt\/homebrew\/bin\/chrome-devtools-mcp"\]\nenabled = true/.test(toml), 'Codex args line inserted for entry without args');
check(toml.includes('args = ["chrome-devtools-mcp@latest", "-u", "http://127.0.0.1:9333"]'), 'Codex external entry unchanged');
const backups = fs.readdirSync(path.join(home, 'backups'));
check(backups.length === 1 && fs.readdirSync(path.join(home, 'backups', backups[0])).length === 8, 'one backup per changed file', fs.readdirSync(path.join(home, 'backups', backups[0])).length);
{
  // Putting the old array back must give the original file: nothing else changed.
  const oc = jsonText('opencode');
  const ocCmd = oc.match(/"command": (\[[^\]]*\])/)?.[1];
  check(JSON.parse(ocCmd ?? '[]')[0] === launcher && oc.replace(ocCmd, '["npx", "-y", "chrome-devtools-mcp@latest"]') === jsonFiles.opencode[1], 'OpenCode: only the command array changed, comments kept', ocCmd);
  const cu = JSON.parse(jsonText('cursor')).mcpServers['cursor-browser'];
  check(cu.command === launcher && cu.args.join(' ') === 'mcp -- npx chrome-devtools-mcp@latest' && cu.env.DEBUG === '1', 'Cursor: wrapped, env kept', JSON.stringify(cu));
  const ge = JSON.parse(jsonText('gemini'));
  check(ge.theme === 'GitHub' && ge.mcpServers['gemini-browser'].timeout === 30000 && ge.mcpServers['gemini-browser'].args?.join(' ') === 'mcp -- /usr/local/bin/chrome-devtools-mcp', 'Gemini CLI: args inserted, other settings kept', JSON.stringify(ge));
  const ws = jsonText('windsurf');
  check(ws.includes('\t\t"ws-external"') && JSON.parse(ws).mcpServers['ws-browser'].command === launcher, 'Windsurf: wrapped, tab indentation kept');
}
check(fs.existsSync(launcher), 'launcher copied to stable location');

// --- 3. Idempotent
const again = run('setup');
const pendingAgain = again.split('\n').filter(l => /^\[(migrate|updatePath)\]/.test(l) && !l.includes('proj-cdp'));
check(pendingAgain.length === 0, 'second run proposes nothing new (except skipped project file)', pendingAgain.join(' | '));
{ const m = (again.match(/^\[migrated\]/gm) ?? []).length; const expected = (preview.match(/^\[migrate\]/gm) ?? []).length - 1; check(m === expected, 'all applied entries reported as migrated', `${m}/${expected}`); }

// --- 4. User changes after apply, then uninstall
execFileSync(claudeBin, ['mcp', 'remove', 'cdp-local', '-s', 'local'], { env, cwd: proj, encoding: 'utf8' });
const changed = { ...local['cdp-local'], env: { DEBUG: '1', ADDED_LATER: 'yes' } };
execFileSync(claudeBin, ['mcp', 'add-json', 'cdp-local', JSON.stringify(changed), '-s', 'local'], { env, cwd: proj, encoding: 'utf8' });
let t2 = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
t2 = t2.replace('startup_timeout_sec = 30', 'startup_timeout_sec = 45').replace(proj2Trust, '');
fs.writeFileSync(path.join(codexHome, 'config.toml'), t2);

check(/^\[migrated\][^\n]*· proj2-cdp ·/m.test(run('setup')), 'untrusted project file with Habitab entry still found via manifest');

const un = run('uninstall');
check(!un.includes('✗'), 'uninstall without errors', un.split('\n').filter(l => l.includes('✗')).join(' | '));
const cj2 = JSON.parse(fs.readFileSync(path.join(claudeDir, '.claude.json'), 'utf8'));
check(JSON.stringify(cj2.mcpServers['chrome-devtools']) === JSON.stringify(userServers['chrome-devtools']), 'Claude user entry restored exactly');
const l2 = cj2.projects[proj].mcpServers;
check(l2['cdp-local'].command === 'npx' && l2['cdp-local'].env.ADDED_LATER === 'yes', 'Claude entry changed later: unwrapped, user change kept');
check(!l2['team-browser'], 'Claude local override removed, .mcp.json applies again');
const t3 = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
check(t3 === codexToml.replace('startup_timeout_sec = 30', 'startup_timeout_sec = 45'), 'Codex file byte-identical to original plus later user change');
check(fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8').includes('"--isolated"'), 'skipped Codex project file untouched');
check(fs.readFileSync(path.join(proj2, '.codex', 'config.toml'), 'utf8') === proj2Toml, 'Codex file of no longer trusted project restored');
for (const k of Object.keys(jsonFiles)) check(jsonText(k) === jsonFiles[k][1], `${k}: file byte-identical after uninstall`, jsonText(k).slice(0, 120));

fs.rmSync(root, { recursive: true, force: true });
