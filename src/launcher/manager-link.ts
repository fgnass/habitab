// Connection from a browser bridge to the Habitab app. The app is started
// when it is not running. The link reconnects by itself, for example after
// an app restart.
import fs from 'node:fs';
import net from 'node:net';
import { LineSocket, Message, SessionMeta } from '../shared/ipc';
import { log, paths } from '../shared/paths';
import { startApp } from '../shared/platform';

export class ManagerLink {
  private line?: LineSocket;
  private closed = false;
  private nextRequest = 1;
  private pending = new Map<number, (port?: number, error?: string) => void>();
  private lastWake = 0;
  private connecting?: Promise<boolean>;
  onHold?: (hold: boolean, targets?: string[]) => void;
  onFeedbackPush?: (content: string) => void;

  constructor(private hello: () => Message) {}

  start(): void { void this.loop(); }

  get connected(): boolean { return !!this.line; }

  private async loop(): Promise<void> {
    while (!this.closed) {
      if (!this.line) await this.connect();
      await new Promise(r => setTimeout(r, this.line ? 1000 : 2000));
    }
  }

  private connect(): Promise<boolean> {
    this.connecting ??= new Promise<boolean>(resolve => {
      const socket = net.connect(paths.socket);
      socket.once('connect', () => {
        const line = new LineSocket(socket);
        this.line = line;
        line.on('message', (m: Message) => this.handle(m));
        line.on('close', () => {
          if (this.line === line) this.line = undefined;
          for (const [, cb] of this.pending) cb(undefined, 'Connection to the Habitab app lost');
          this.pending.clear();
        });
        line.send(this.hello());
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private handle(m: Message): void {
    if (m.type === 'endpoint') {
      const cb = this.pending.get(m.requestId);
      this.pending.delete(m.requestId);
      cb?.(m.port, m.error);
    } else if (m.type === 'hold') {
      this.onHold?.(m.hold, m.targets);
    } else if (m.type === 'feedbackPush') {
      this.onFeedbackPush?.(m.content);
    }
  }

  send(m: Message): void { this.line?.send(m); }

  sendMeta(meta: SessionMeta): void { this.send({ type: 'meta', meta }); }

  /** Port of the session's CDP endpoint in the app. Starts the app if needed. */
  async attach(timeoutMs = 25_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (!this.line) {
      if (await this.connect()) break;
      this.wake();
      if (Date.now() > deadline) throw new Error('Habitab app not reachable');
      await new Promise(r => setTimeout(r, 400));
    }
    return new Promise<number>((resolve, reject) => {
      const requestId = this.nextRequest++;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Habitab app does not respond')); }, 20_000);
      this.pending.set(requestId, (port, error) => {
        clearTimeout(timer);
        port ? resolve(port) : reject(new Error(error ?? 'no browser'));
      });
      this.line!.send({ type: 'attach', requestId });
    });
  }

  private wake(): void {
    if (Date.now() - this.lastWake < 30_000 || process.env.HABITAB_NO_APP_LAUNCH === '1') return;
    this.lastWake = Date.now();
    try {
      const raw = fs.readFileSync(paths.appPathFile, 'utf8').trim();
      const cmd = raw.startsWith('{') ? JSON.parse(raw) : { exe: raw, args: [] };
      log(`starting app ${cmd.exe} ${cmd.args.join(' ')}`);
      startApp(cmd);
    } catch {
      log('app path unknown; cannot start Habitab');
    }
  }

  /** Ends the link. `signOff` tells the app that the session is over; without it the session waits for the next bridge. */
  close(reason: string, signOff = true): void {
    this.closed = true;
    if (signOff) this.line?.send({ type: 'bye', reason });
    this.line?.socket.end();
  }
}
