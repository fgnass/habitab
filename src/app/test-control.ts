// Test control channel (HABITAB_TEST_CONTROL=1): stdin commands, JSON on stdout.
import readline from 'node:readline';
import type { BaseWindow, WebContentsView } from 'electron';
import type { SessionManager } from './sessions';
import { uiState } from './ui-state';

export function attach(m: SessionManager, ui: { win: BaseWindow; select: (id: string, tab?: number) => void; layout: () => void; publish: () => void; upstreamUrl: () => string; action: (name: string, ...args: any[]) => Promise<unknown>; quit: () => void; clipboard: () => string; background: () => WebContentsView; errors: () => string[]; annotating: () => boolean; annotateKept: () => number; findText: () => string | null; lastShare: () => unknown; view: (name: string) => WebContentsView | undefined; speechResult: (text: string, final: boolean) => boolean; speechLevel: (level: number) => boolean; speechPermission: (wait: boolean) => void }): void {
  const out = (o: object) => process.stdout.write(JSON.stringify({ ...o, at: Date.now() }) + '\n');
  out({ ready: true, chrome: process.versions.chrome, upstream: ui.upstreamUrl() });
  // The window must never take focus on its own (agents work in the background).
  ui.win.on('focus', () => out({ focus: Date.now(), stack: [...m.sessions.values()].map(s => `${s.id}:${s.currentTool?.tool ?? '-'}/${s.activity[0]?.tool ?? '-'}`).join(' ') }));
  // `page`: the active tab of the selected session; other names: the app's own views.
  const view = (name: string) => name === 'page' ? m.sessions.get(m.selected ?? '')?.active?.view : ui.view(name);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const [cmd, id, arg, ...rest] = line.trim().split(/\s+/);
    const s = id ? m.sessions.get(id) : undefined;
    try {
      if (cmd === 'state') out({ state: { ...uiState(m), clipboard: ui.clipboard(), errors: ui.errors(), annotating: ui.annotating(), annotateKept: ui.annotateKept(), findText: ui.findText(), lastShare: ui.lastShare() } });
      // `bounds`: the window's content; `bounds page|topbar|…`: a view in it (window coordinates).
      else if (cmd === 'bounds') {
        const v = id ? view(id) : undefined;
        out({ bounds: v ? v.getBounds() : ui.win.getContentBounds() });
      }
      else if (cmd === 'resize') ui.win.setContentSize(Number(id), Number(arg));
      // The native window id (macOS: CGWindowID), e.g. for `screencapture -l` without focusing the window.
      else if (cmd === 'windowid') out({ windowId: ui.win.getMediaSourceId() });
      else if (cmd === 'select' && s) ui.select(s.id, arg ? Number(arg) : undefined);
      // No session selected: the start page, with the sessions in the sidebar (screenshots).
      else if (cmd === 'deselect') { m.selected = undefined; ui.layout(); ui.publish(); }
      else if (cmd === 'devtools' && s) m.toggleDevtools(s);
      else if (cmd === 'hold' && s) m.setHold(s, arg === 'on');
      else if (cmd === 'pin' && s) s.pinned = arg !== 'off';
      else if (cmd === 'interact' && s) m.interaction(s);
      else if (cmd === 'debugger' && s?.active) void m.pauseDebugger(s, s.active, arg === 'off');
      // Native input like a user's click (not through the CDP proxy), at page coordinates (default 5, 5).
      else if (cmd === 'userclick' && s?.active) {
        const x = Number(arg ?? 5), y = Number(rest[0] ?? 5);
        for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) s.active.view.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
      }
      // A user's mouse in one of the views (`page`, `annotator`, …): `usermouse <view> down|move|up x y`; a move holds the button.
      else if (cmd === 'usermouse') {
        const type = ({ down: 'mouseDown', move: 'mouseMove', up: 'mouseUp' } as Record<string, 'mouseDown' | 'mouseMove' | 'mouseUp'>)[arg];
        if (type) view(id)?.webContents.sendInputEvent({ type, x: Number(rest[0]), y: Number(rest[1]), button: 'left', clickCount: 1, ...(type === 'mouseMove' ? { modifiers: ['leftbuttondown'] } : {}) });
      }
      // A user's scroll wheel at (x, y): `userscroll <id> x y dy` (dy > 0 scrolls down).
      else if (cmd === 'userscroll' && s?.active) s.active.view.webContents.sendInputEvent({ type: 'mouseWheel', x: Number(arg), y: Number(rest[0]), deltaX: 0, deltaY: -Number(rest[1]) });
      else if (cmd === 'userkey' && s?.active) {
        for (const type of ['rawKeyDown', 'keyUp'] as const) s.active.view.webContents.sendInputEvent({ type, keyCode: 'Tab', modifiers: ['meta'] });
      }
      // Like Cmd+W: closes the active tab without activating another one first.
      else if (cmd === 'gpupause' && s?.active) m.pauseGpu(s, s.active);
      else if (cmd === 'closetab' && s?.active) s.active.view.webContents.close();
      else if (cmd === 'remove' && s) m.remove(s);
      // Runs a script in one of the app's own views (e.g. \`ui timeline <js>\`), in the selected session's DevTools, or in its page (`ui page <js>`, not through the CDP proxy).
      else if (cmd === 'ui') { const v = view(id); if (v) void v.webContents.executeJavaScript([arg, ...rest].join(' ')).then(r => out({ ui: id, result: r }), e => out({ ui: id, error: e.message })); }
      // Like the page context menu's "Send Element to Agent…" at (x, y).
      else if (cmd === 'sendelement' && s?.active) m.onSendElement(s, s.active, Number(arg), Number(rest[0]));
      // A stored site answer, as if the user had answered the sheet: `access <id> media|clipboard <origin> allow|block|forget`.
      else if (cmd === 'access' && s) m.setSiteAccess(s, arg as 'media' | 'clipboard', rest[0], rest[1] === 'forget' ? undefined : rest[1] as 'allow' | 'block');
      // HABITAB_FAKE_SPEECH=1: a result of the running recognition: `speech interim|final <text>`.
      else if (cmd === 'speech' && id === 'level') out({ speech: ui.speechLevel(Number(arg)) });
      // `speech permission wait|answer`: the microphone question of the dictation stays open, or gets its (allowing) answer.
      else if (cmd === 'speech' && id === 'permission') ui.speechPermission(arg === 'wait');
      else if (cmd === 'speech') out({ speech: ui.speechResult([arg, ...rest].join(' '), id === 'final') });
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
