// Session metadata from sources the clients actually provide (measured with
// Claude Code 2.1.292 and Codex 0.159.1). Each value records its source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionMeta } from './ipc';
import { processList, processName } from './platform';

export function projectRootOf(dir: string): string | undefined {
  let current = path.resolve(dir);
  const home = os.homedir();
  while (current !== path.dirname(current) && current !== home) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return undefined;
}

export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/**
 * Session metadata of this process. The launcher is a child of the client;
 * the browser bridge sits below the MCP server (and its runners), so it looks
 * further up the process tree (`searchTree`).
 */
export function collectMeta(searchTree = false): SessionMeta {
  const env = process.env;
  const cwd = process.cwd();
  // Claude Code sets CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID for MCP servers.
  const root = env.CLAUDE_PROJECT_DIR || projectRootOf(cwd);
  const meta: SessionMeta = {
    cwd,
    projectRoot: root,
    projectName: path.basename(root ?? cwd),
    startedAt: new Date().toISOString(),
  };
  const found = searchTree ? clientInTree(process.ppid) : clientByName(process.ppid, processName(process.ppid));
  if (found) { meta.client = found.client; meta.clientSource = 'process'; meta.clientPid = found.pid; }

  const sid = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (sid) {
    meta.agentSessionId = sid;
    meta.agentSessionSource = 'env';
    if (!meta.client) { meta.client = 'claude'; meta.clientSource = 'env'; meta.clientPid = process.ppid; }
  }
  if (meta.client === 'claude' && meta.clientPid) applyClaudeSessionFile(meta, false);
  return meta;
}

function clientByName(pid: number, name: string | undefined): { client: string; pid: number } | undefined {
  const n = name?.toLowerCase();
  if (n === 'claude') return { client: 'claude', pid };
  if (n?.startsWith('codex')) return { client: 'codex', pid };
  return undefined;
}

/**
 * The client process above a chain of runners (sh, npx, node): the first
 * process whose command line names a known client. Known by the executable
 * name ("claude", "codex", "gemini", "cursor") or by its package directory
 * ("node .../claude-code/cli.js").
 */
export function clientInTree(from: number): { client: string; pid: number } | undefined {
  const rows = new Map(processList().map(r => [r.pid, r]));
  let pid = from;
  // Server, its runners (npx, sh) and the client: a few levels, not the whole tree.
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    const row = rows.get(pid);
    if (!row) return undefined;
    const client = clientOfCommand(row.command);
    if (client) return { client, pid };
    pid = row.ppid;
  }
  return undefined;
}

/**
 * The client a command line belongs to: the executable ("claude", "codex",
 * "gemini"), its install directory ("node .../claude-code/cli.js", the native
 * "claude/versions/..." binary) or the app bundle (Cursor, Windsurf).
 */
export function clientOfCommand(cmd: string): string | undefined {
  const c = cmd.replace(/\\/g, '/');
  const exe = path.basename(c.split(' ')[0]).toLowerCase();
  if (/(^|\/)claude(\s|$)/.test(c) || /\/claude\/versions\//.test(c) || /\/claude-code\//.test(c)) return 'claude';
  if (/(^|\/)codex(\s|$)/.test(c) || exe.includes('codex') || /\/@openai\/codex\//.test(c)) return 'codex';
  if (/(^|\/)opencode(\s|$)/.test(c)) return 'opencode';
  if (c.includes('/Cursor.app/') || exe === 'cursor') return 'cursor';
  if (c.includes('/Windsurf.app/') || exe === 'windsurf') return 'windsurf';
  if (/(^|\/)gemini(\s|$)/.test(c) || /\/gemini-cli\//.test(c)) return 'gemini';
  return undefined;
}

/**
 * Claude Code writes ~/.claude/sessions/<pid>.json for each running process.
 * The format is internal, so it is a labeled, best-effort source. After
 * /clear it shows the new session id while the MCP server keeps running.
 */
export function applyClaudeSessionFile(meta: SessionMeta, allowOverride: boolean): boolean {
  if (!meta.clientPid) return false;
  try {
    const json = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'sessions', `${meta.clientPid}.json`), 'utf8'));
    let changed = false;
    if (typeof json.sessionId === 'string' && json.sessionId !== meta.agentSessionId
        && (!meta.agentSessionId || allowOverride)) {
      meta.agentSessionId = json.sessionId;
      meta.agentSessionSource = 'claude-sessions-file';
      changed = true;
    }
    if (typeof json.name === 'string' && json.name && json.name !== meta.agentSessionName) {
      meta.agentSessionName = json.name;
      changed = true;
    }
    return changed;
  } catch { return false; }
}

/** Codex thread title from its session index (newest entries at the end). */
export function codexThreadName(threadId: string): string | undefined {
  try {
    const file = path.join(codexHome(), 'session_index.jsonl');
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 512_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    let name: string | undefined;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes(threadId)) continue;
      try { const o = JSON.parse(line); if (o.id === threadId && o.thread_name) name = o.thread_name; } catch {}
    }
    return name;
  } catch { return undefined; }
}
