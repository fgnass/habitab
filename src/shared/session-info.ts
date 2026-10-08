// Session metadata from sources the clients actually provide (measured with
// Claude Code 2.1.292 and Codex 0.159.1). Each value records its source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionMeta } from './ipc';
import { processName } from './platform';

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

export function collectMeta(): SessionMeta {
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
  const parent = processName(process.ppid)?.toLowerCase();
  if (parent === 'claude') { meta.client = 'claude'; meta.clientSource = 'process'; meta.clientPid = process.ppid; }
  else if (parent?.startsWith('codex')) { meta.client = 'codex'; meta.clientSource = 'process'; meta.clientPid = process.ppid; }

  const sid = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (sid) {
    meta.agentSessionId = sid;
    meta.agentSessionSource = 'env';
    if (!meta.client) { meta.client = 'claude'; meta.clientSource = 'env'; meta.clientPid = process.ppid; }
  }
  if (meta.client === 'claude' && meta.clientPid) applyClaudeSessionFile(meta, false);
  return meta;
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
