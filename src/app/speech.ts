// On-device speech recognition for pages (Web Speech API, see speech-polyfill.ts)
// and for Habitab's own dictation. macOS: the speech helper (src/speech,
// Apple's Speech framework), one JSON object per line over stdin/stdout. One
// microphone: one recognition at a time; a new one ends the running one.
// HABITAB_FAKE_SPEECH=1 (tests): no helper, results come from the test control.
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../shared/paths';

/**
 * The recognizer's model for a language. A language without its own model
 * (e.g. en-DE, a system language with a region) gets the model of the
 * language's usual region (en-US, de-DE, pt-BR), else any model of the
 * language; without one it stays as it is (and is reported unavailable).
 */
export function nearestModel(wanted: string, models: string[]): string {
  if (models.includes(wanted)) return wanted;
  const base = wanted.split(/[-_]/)[0];
  let usual: string | undefined;
  try { const region = new Intl.Locale(base).maximize().region; if (region) usual = `${base}-${region}`; } catch {}
  return (usual && models.includes(usual) ? usual : models.find(m => m.split('-')[0] === base)) ?? wanted;
}

export type SpeechEvent =
  | { type: 'started' }
  | { type: 'downloading' }
  | { type: 'level'; level: number }
  | { type: 'result'; text: string; final: boolean; confidence: number }
  | { type: 'end' }
  | { type: 'error'; error: string; message: string };

export interface SpeechOptions { lang: string; interim: boolean; context: string[] }

export class SpeechService {
  private readonly helper = path.join(__dirname, 'speech-helper');
  private readonly fake = process.env.HABITAB_FAKE_SPEECH === '1';
  private proc?: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private active?: { id: number; onEvent: (e: SpeechEvent) => void; ended: boolean };
  /** Answers to "available" and "install" requests. */
  private pending = new Map<number, (r: any) => void>();

  /** Speech recognition exists on this computer (macOS with the helper built). */
  get supported(): boolean { return this.fake || (process.platform === 'darwin' && fs.existsSync(this.helper)); }

  /** Starts a recognition; events come until "end" (always the last one). Returns its id. */
  start(opts: SpeechOptions, onEvent: (e: SpeechEvent) => void): number {
    const id = this.nextId++;
    this.endActive('aborted', 'A new recognition started');
    this.active = { id, onEvent, ended: false };
    if (this.fake) { setTimeout(() => this.deliver(id, { type: 'started' }), 10); return id; }
    this.send({ type: 'start', id, lang: opts.lang, interim: opts.interim, context: opts.context });
    return id;
  }

  /** Finishes: pending text becomes final, then "end". */
  stop(id: number): void {
    if (this.active?.id !== id) return;
    if (this.fake) { this.deliver(id, { type: 'end' }); return; }
    this.send({ type: 'stop', id });
  }

  abort(id: number): void {
    if (this.active?.id !== id) return;
    if (this.fake) { this.deliver(id, { type: 'end' }); return; }
    this.send({ type: 'abort', id });
  }

  /** Whether a language can be recognized: available, downloadable, downloading, unavailable. */
  async available(lang: string): Promise<string> {
    if (!this.supported) return 'unavailable';
    if (this.fake) return 'available';
    return this.ask({ type: 'available', lang }).then(r => String(r.status ?? 'unavailable'));
  }

  /** Languages the recognizer knows (BCP 47). */
  async languages(): Promise<string[]> {
    if (!this.supported) return [];
    if (this.fake) return ['en-US', 'de-DE'];
    return this.ask({ type: 'languages' }).then(r => Array.isArray(r.languages) ? r.languages.map(String) : []);
  }

  async install(lang: string): Promise<boolean> {
    if (!this.supported) return false;
    if (this.fake) return true;
    return this.ask({ type: 'install', lang }).then(r => !!r.ok);
  }

  /** Test control: a signal level for the running recognition. */
  fakeLevel(level: number): boolean {
    if (!this.fake || !this.active) return false;
    this.deliver(this.active.id, { type: 'level', level });
    return true;
  }

  /** Test control: a result for the running recognition. */
  fakeResult(text: string, final: boolean): boolean {
    if (!this.fake || !this.active) return false;
    this.deliver(this.active.id, { type: 'result', text, final, confidence: 0.9 });
    return true;
  }

  dispose(): void {
    this.endActive('aborted', 'Habitab quits');
    this.proc?.kill();
    this.proc = undefined;
  }

  private ask(req: object): Promise<any> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.send({ ...req, id });
      setTimeout(() => { if (this.pending.delete(id)) resolve({}); }, 10 * 60_000);
    });
  }

  private endActive(error: string, message: string): void {
    const a = this.active;
    if (!a || a.ended) return;
    if (!this.fake) this.send({ type: 'abort', id: a.id });
    this.deliver(a.id, { type: 'error', error, message });
    this.deliver(a.id, { type: 'end' });
  }

  private deliver(id: number, e: SpeechEvent): void {
    const a = this.active;
    if (!a || a.id !== id || a.ended) return;
    if (e.type === 'end') { a.ended = true; this.active = undefined; }
    try { a.onEvent(e); } catch (err) { log(`speech event handler failed: ${(err as Error).message}`); }
  }

  private send(msg: object): void {
    const p = this.process();
    if (!p) return;
    p.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private process(): ChildProcess | undefined {
    if (this.proc) return this.proc;
    if (!this.supported || this.fake) return undefined;
    const p = spawn(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (line) this.receive(line);
      }
    });
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (s: string) => log(`speech helper: ${s.trim()}`));
    p.on('error', e => log(`speech helper failed to start: ${e.message}`));
    p.on('exit', code => {
      if (this.proc === p) this.proc = undefined;
      this.buffer = '';
      log(`speech helper exited (${code})`);
      // A crash ends the running recognition like a lost connection.
      const a = this.active;
      if (a && !a.ended) { this.deliver(a.id, { type: 'error', error: 'network', message: 'The speech helper stopped' }); this.deliver(a.id, { type: 'end' }); }
      for (const [id, resolve] of this.pending) { this.pending.delete(id); resolve({}); }
    });
    return p;
  }

  private receive(line: string): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    const id = Number(m.id);
    const answer = this.pending.get(id);
    if (answer) { this.pending.delete(id); answer(m); return; }
    if (m.type === 'result') this.deliver(id, { type: 'result', text: String(m.text ?? ''), final: !!m.final, confidence: Number(m.confidence ?? 1) });
    else if (m.type === 'error') this.deliver(id, { type: 'error', error: String(m.error ?? 'network'), message: String(m.message ?? '') });
    else if (m.type === 'level') this.deliver(id, { type: 'level', level: Number(m.level ?? 0) });
    else if (m.type === 'started' || m.type === 'downloading' || m.type === 'end') this.deliver(id, { type: m.type });
  }
}
