// Browser bridge <-> app protocol: one JSON object per line over a Unix
// socket (named pipe on Windows). All fields except `type` are optional, so
// bridges and apps of different versions can talk to each other.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface SessionMeta {
  cwd?: string;
  projectRoot?: string;
  projectName?: string;
  /** "claude" | "codex" */
  client?: string;
  /** How `client` was determined: "clientInfo", "env", "process". */
  clientSource?: string;
  clientPid?: number;
  /** Chat/thread id from the client, with its source. */
  agentSessionId?: string;
  agentSessionSource?: string;
  agentSessionName?: string;
  /** Claude Code gave the server its inbox socket (cross-session messaging): feedback reaches the session as a note. */
  inbox?: boolean;
  /** The app talks to Codex's app-server daemon for this thread: tool calls and feedback go through it. */
  codexAppServer?: boolean;
  serverName?: string;
  originalCommand?: string[];
  startedAt?: string;
}

export type Message =
  /** launcherPid: the bridge; serverPid: the MCP server above it, which outlives the bridge (and the app) and starts a new one. */
  | { type: 'hello'; sessionId: string; launcherPid: number; serverPid?: number; meta: SessionMeta; launch?: { proxyServer?: string; viewport?: string; acceptInsecureCerts?: boolean } }
  | { type: 'meta'; meta: SessionMeta }
  /** The bridge needs the browser: the app creates the session browser if needed. */
  | { type: 'attach'; requestId: number }
  | { type: 'endpoint'; requestId: number; port?: number; error?: string }
  /** The user has control: the bridge holds the agent's commands (and releases them by itself after a limit). */
  | { type: 'hold'; hold: boolean }
  /** Feedback for the agent: pushed into the Claude Code session through its inbox socket. */
  | { type: 'feedbackPush'; content: string }
  | { type: 'bye'; reason: string };

/** Feedback reaches the agent as a note (Claude Code inbox, Codex app-server). */
export const canPush = (m: SessionMeta): boolean => !!(m.inbox || m.codexAppServer);

export class LineSocket extends EventEmitter {
  private buffer = '';
  constructor(readonly socket: net.Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        try { this.emit('message', JSON.parse(line)); } catch {}
      }
    });
    socket.on('close', () => this.emit('close'));
    socket.on('error', () => {});
  }

  send(message: Message): void {
    if (!this.socket.destroyed) this.socket.write(JSON.stringify(message) + '\n');
  }

  close(): void { this.socket.destroy(); }
}

export function newSessionId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = 'hb-';
  for (let i = 0; i < 8; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^hb-[a-z0-9]{4,24}$/.test(s);
