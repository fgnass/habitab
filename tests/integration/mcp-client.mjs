// Minimal MCP stdio client for integration tests.
import { spawn } from 'node:child_process';

export class McpClient {
  constructor(command, args, { env = {}, cwd, clientName = 'habitab-test' } = {}) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, cwd });
    this.clientName = clientName;
    this.pending = new Map();
    /** Notifications from the server (no id), e.g. Claude Code channel events. */
    this.notifications = [];
    this.nextId = 1;
    this.stderr = '';
    let buf = '';
    this.proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === 'roots/list' && msg.id !== undefined) {
          this.send({ jsonrpc: '2.0', id: msg.id, result: { roots: [{ uri: 'file://' + (cwd ?? process.cwd()), name: 'test' }] } });
        } else if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else if (msg.method && msg.id === undefined) {
          this.notifications.push(msg);
        }
      }
    });
    this.proc.stderr.on('data', d => { this.stderr += d; });
    this.exited = new Promise(r => this.proc.on('exit', (code, signal) => r({ code, signal })));
  }

  send(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      this.pending.set(id, m => { clearTimeout(t); resolve(m); });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: this.clientName, version: '1.0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }

  async tool(name, args = {}, meta) {
    const params = { name, arguments: args };
    if (meta) params._meta = meta;
    const r = await this.request('tools/call', params);
    const text = r.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(r.error);
    return { raw: r, text, isError: !!(r.error || r.result?.isError) };
  }

  close() { this.proc.stdin.end(); return this.exited; }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function check(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
  return cond;
}
