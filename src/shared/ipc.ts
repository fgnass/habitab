// Launcher <-> app protocol: one JSON object per line over a Unix socket
// (named pipe on Windows). All fields except `type` are optional, so
// launchers and apps of different versions can talk to each other.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface SessionMeta {
  cwd?: string;
  projectRoot?: string;
  projectName?: string;
  /** "claude" | "codex" */
  client?: string;
  clientName?: string;
  clientVersion?: string;
  /** How `client` was determined: "clientInfo", "env", "process". */
  clientSource?: string;
  clientPid?: number;
  /** Chat/thread id from the client, with its source. */
  agentSessionId?: string;
  agentSessionSource?: string;
  agentSessionName?: string;
  roots?: string[];
  /** Claude Code runs this server as a channel (started with the development channel flag). */
  channel?: boolean;
  /** Claude Code gave the server its inbox socket (cross-session messaging): feedback can wake the session. */
  inbox?: boolean;
  /** Codex has `codex queue`: feedback can be queued as a prompt for the thread (agentSessionId). */
  codexQueue?: boolean;
  serverName?: string;
  originalCommand?: string[];
  startedAt?: string;
}

export type Message =
  | { type: 'hello'; sessionId: string; launcherPid: number; meta: SessionMeta; launch?: { proxyServer?: string; viewport?: string; acceptInsecureCerts?: boolean } }
  | { type: 'meta'; meta: SessionMeta }
  /** Launcher needs the browser: app creates the session browser if needed. */
  | { type: 'attach'; requestId: number }
  | { type: 'endpoint'; requestId: number; port?: number; error?: string }
  | { type: 'toolStart'; callId: string; tool: string; summary?: string }
  | { type: 'toolEnd'; callId: string; tool: string; isError: boolean; durationMs: number; detail?: string }
  | { type: 'hold'; hold: boolean }
  /** The agent waits for the user to mark an area (wait_for_user_feedback). */
  | { type: 'feedbackRequest'; requestId: string; question?: string }
  /** The wait ended without an answer (timeout or cancelled by the client). */
  | { type: 'feedbackCancel'; requestId: string }
  /** Feedback while no call waits: pushed into the Claude Code session (channel event or inbox message). */
  | { type: 'feedbackPush'; content: string }
  /** The user's answer: comments and pages as text, the marked areas as PNGs (base64). */
  | { type: 'feedbackResult'; requestId: string; text: string; images: string[] }
  | { type: 'bye'; reason: string };

/** Feedback reaches the agent at once, also when no wait_for_user_feedback call waits. */
export const canPush = (m: SessionMeta): boolean => !!(m.channel || m.inbox || (m.codexQueue && m.agentSessionId));

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
