// Shared setup for tests and demos that start chrome-devtools-mcp unchanged:
// a global config of the server (under its own XDG_CONFIG_HOME) names the
// browser script of a Habitab instance, and a shell script named like a
// client ("claude", "codex") stands in for the client above the server, so
// the bridge finds it in the process tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVER = ['npx', '-y', 'chrome-devtools-mcp@latest', '--isolated'];

/**
 * Environment for a separate Habitab instance in `dir`: own HABITAB_HOME,
 * socket and server config. The browser script exists once the app has run.
 */
export function bridgeEnv(dir, extra = {}) {
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(path.join(xdg, 'cd4a'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'cd4a', 'config.json'), JSON.stringify({ executablePath: path.join(home, 'bin', 'habitab-browser') }));
  return {
    HABITAB_HOME: home,
    HABITAB_SOCKET: process.env.HABITAB_SOCKET ?? path.join(os.tmpdir(), `hb-${path.basename(dir)}-${process.pid}.sock`),
    HABITAB_NO_APP_LAUNCH: '1',
    HABITAB_TEST_CONTROL: '1',
    HABITAB_FAKE_SPEECH: '1',
    XDG_CONFIG_HOME: xdg,
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    // Tests may run inside a Claude Code session: its inbox must never get test messages.
    CLAUDE_CODE_MESSAGING_SOCKET: '',
    CLAUDE_CODE_MESSAGING_TOKEN: '',
    ...extra,
  };
}

/** A shell script named `kind` that runs the server: the client the bridge sees above the server. */
export function fakeClient(env, kind = 'claude') {
  const dir = path.join(env.HABITAB_HOME, '..', 'clients');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, kind);
  fs.writeFileSync(file, `#!/bin/sh\n${SERVER.join(' ')}\n`, { mode: 0o755 });
  return file;
}
