import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { classify } from '../../installer/model';
import { applyEdits, stringArrayOf, stringOf, TomlScanner } from '../../installer/toml';
import { parseCommand, rewriteServerArgs, wrapper } from '../../shared/server-command';
import { launcherScript } from '../../shared/platform';

const parse = (line: string) => { const [c, ...a] = line.split(' '); return parseCommand(c, a); };

test('server command detection', () => {
  assert.equal(parse('npx -y chrome-devtools-mcp@latest --isolated')?.mode, 'managed');
  assert.deepEqual(parse('npx -y chrome-devtools-mcp@latest --isolated')?.runner, ['npx', '-y', 'chrome-devtools-mcp@latest']);
  assert.equal(parse('node /x/node_modules/chrome-devtools-mcp/build/src/index.js')?.serverIndex, 1);
  assert.equal(parse('/opt/bin/chrome-devtools-mcp --headless')?.serverIndex, 0);
  assert.equal(parse('npx some-other-mcp'), undefined);
  assert.equal(parse('npx @acme/chrome-devtools-mcp-fork'), undefined);
});

test('external and persistent browsers', () => {
  for (const l of ['npx chrome-devtools-mcp --browser-url http://127.0.0.1:9222', 'npx chrome-devtools-mcp --browserUrl=http://x:1',
    'npx chrome-devtools-mcp -u http://x:1', 'npx chrome-devtools-mcp -w ws://x/devtools/browser/1', 'npx chrome-devtools-mcp --autoConnect']) {
    assert.equal(parse(l)?.mode, 'external', l);
  }
  assert.equal(parse('npx chrome-devtools-mcp --auto-connect=false')?.mode, 'managed');
  assert.equal(parse('npx chrome-devtools-mcp --no-auto-connect')?.mode, 'managed');
  assert.equal(parse('npx chrome-devtools-mcp --user-data-dir /p')?.mode, 'persistentProfile');
});

test('launch options', () => {
  const l = parse('npx chrome-devtools-mcp -e /c/chrome --channel beta --chrome-arg=--lang=de --proxy-server http://p:1 --viewport 1024x768 --accept-insecure-certs')!.launch;
  assert.deepEqual(l.ignored, ['--executablePath', '--channel', '--chromeArg']);
  assert.equal(l.proxyServer, 'http://p:1');
  assert.equal(l.viewport, '1024x768');
  assert.equal(l.acceptInsecureCerts, true);
  assert.deepEqual(
    rewriteServerArgs(['--isolated', '--headless=true', '-e', '/c', '--viewport', '800x600', '--chromeArg', '--x', '--no-usage-statistics'], 'http://127.0.0.1:5'),
    ['--viewport', '800x600', '--no-usage-statistics', '--browserUrl', 'http://127.0.0.1:5']);
});

test('wrapper round trip and classification', () => {
  const [c, a] = wrapper.wrap('npx', ['chrome-devtools-mcp@latest', '--isolated'], '/L/habitab');
  assert.deepEqual([c, a], ['/L/habitab', ['mcp', '--', 'npx', 'chrome-devtools-mcp@latest', '--isolated']]);
  assert.deepEqual(wrapper.unwrap(c, a), ['npx', ['chrome-devtools-mcp@latest', '--isolated']]);
  const base = { client: 'codex' as const, scope: 'user', file: 'f', name: 'n' };
  assert.equal(classify({ ...base, command: c, args: a }, '/L/habitab')?.status, 'migrated');
  assert.equal(classify({ ...base, command: '/old/habitab', args: a }, '/L/habitab')?.status, 'updatePath');
  assert.equal(classify({ ...base, command: 'npx', args: ['chrome-devtools-mcp'] }, '/L/habitab')?.status, 'migrate');
});

test('TOML scanner and byte-exact edits', () => {
  const toml = `# top
model = "x"

[mcp_servers."chrome devtools"] # comment
command = 'npx'
args = [
  "chrome-devtools-mcp@latest", # c1
  '--isolated',
]
env = { A = "1" }

[mcp_servers."chrome devtools".tools.click]
approval_mode = "approve"

[profiles.p]
s = """multi
line"""
`;
  const s = new TomlScanner(toml);
  const cmd = s.pairs.find(p => p.path.join('.') === 'mcp_servers.chrome devtools.command')!;
  const args = s.pairs.find(p => p.path.join('.') === 'mcp_servers.chrome devtools.args')!;
  assert.equal(stringOf(cmd.value), 'npx');
  assert.deepEqual(stringArrayOf(args.value), ['chrome-devtools-mcp@latest', '--isolated']);
  assert.ok(s.pairs.some(p => p.path.join('.') === 'profiles.p.s' && stringOf(p.value) === 'multi\nline'));
  const out = applyEdits(toml, [
    { start: cmd.valueStart, end: cmd.valueEnd, replacement: TomlScanner.quote('/L/hé bitab') },
    { start: args.valueStart, end: args.valueEnd, replacement: TomlScanner.array(['mcp', '--', 'a"b\\c']) },
  ]);
  assert.deepEqual(stringArrayOf(new TomlScanner(out).pairs.find(p => p.path.at(-1) === 'args')!.value), ['mcp', '--', 'a"b\\c']);
  assert.ok(out.startsWith('# top\nmodel = "x"\n\n[mcp_servers."chrome devtools"] # comment\ncommand = "/L/hé bitab"'));
  assert.ok(out.endsWith('env = { A = "1" }\n\n[mcp_servers."chrome devtools".tools.click]\napproval_mode = "approve"\n\n[profiles.p]\ns = """multi\nline"""\n'));
  assert.throws(() => new TomlScanner('a = "unterminated\n'));
});

test('launcher script falls back to the original command', () => {
  const script = launcherScript('/Apps/Habitab.app/Contents/MacOS/Habitab', path.join('/x', "it's", 'main.js'));
  assert.match(script, /ELECTRON_RUN_AS_NODE=1 exec "\$APP" "\$JS" "\$@"/);
  assert.match(script, /JS='\/x\/it'\\''s\/main\.js'/);
  assert.match(script, /\[ "\$1" = "mcp" \] && shift\n\[ "\$1" = "--" \] && shift\nexec "\$@"/);
});
