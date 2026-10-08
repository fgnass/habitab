// Test control channel (HABITAB_TEST_CONTROL=1): stdin commands, JSON on stdout.
import readline from 'node:readline';
import type { BaseWindow, WebContentsView } from 'electron';
import type { SessionManager } from './sessions';
import { uiState } from './ui-state';

export function attach(m: SessionManager, ui: { win: BaseWindow; select: (id: string, tab?: number) => void; layout: () => void; upstreamUrl: () => string; action: (name: string, ...args: any[]) => Promise<unknown>; quit: () => void; clipboard: () => string; background: () => WebContentsView }): void {
  const out = (o: object) => process.stdout.write(JSON.stringify({ ...o, at: Date.now() }) + '\n');
  out({ ready: true, chrome: process.versions.chrome, upstream: ui.upstreamUrl() });
  // The window must never take focus on its own (agents work in the background).
  ui.win.on('focus', () => out({ focus: Date.now(), stack: [...m.sessions.values()].map(s => `${s.id}:${s.currentTool?.tool ?? '-'}/${s.activity[0]?.tool ?? '-'}`).join(' ') }));
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const [cmd, id, arg, ...rest] = line.trim().split(/\s+/);
    const s = id ? m.sessions.get(id) : undefined;
    try {
      if (cmd === 'state') out({ state: { ...uiState(m), clipboard: ui.clipboard() } });
      else if (cmd === 'select' && s) ui.select(s.id);
      else if (cmd === 'devtools' && s) m.toggleDevtools(s);
      else if (cmd === 'hold' && s) m.setHold(s, arg === 'on');
      else if (cmd === 'pin' && s) s.pinned = arg !== 'off';
      else if (cmd === 'interact' && s) m.interaction(s);
      // Native input like a user's click (not through the CDP proxy).
      else if (cmd === 'userclick' && s?.active) {
        for (const type of ['mouseDown', 'mouseUp'] as const) s.active.view.webContents.sendInputEvent({ type, x: 5, y: 5, button: 'left', clickCount: 1 });
      }
      else if (cmd === 'remove' && s) m.remove(s);
      else if (cmd === 'quit') ui.quit();
      // As if the user switched to another app.
      else if (cmd === 'blur') ui.win.emit('blur');
      // Drags the right resize handle of responsive mode by `arg` px, like a user.
      else if (cmd === 'draghandle' && s?.active?.frame) {
        const f = s.active.frame;
        const x = f.x + f.width + 9, y = Math.round(f.y + f.height / 2);
        const wc = ui.background().webContents;
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 5; i++) setTimeout(() => wc.sendInputEvent({ type: 'mouseMove', x: x + (Number(arg) * i) / 5, y, modifiers: ['leftbuttondown'] }), i * 40);
        setTimeout(() => wc.sendInputEvent({ type: 'mouseUp', x: x + Number(arg), y, button: 'left', clickCount: 1 }), 260);
      }
      // A UI action on the session, e.g. `action <id> emulate {"width":400}`.
      else if (cmd === 'action' && s) { ui.select(s.id); const json = rest.join(' '); void ui.action(arg, ...(json ? [JSON.parse(json)] : [])); }
      out({ ack: line.trim() });
    } catch (e: any) {
      out({ ack: line.trim(), error: e.message });
    }
  });
}
