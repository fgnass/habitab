// Pushing a note into a client's session while no tool call waits for it.
import net from 'node:net';
import { log } from './paths';

/**
 * Posts a message into the Claude Code session through its inbox socket
 * (cross-session messaging, CLAUDE_CODE_MESSAGING_SOCKET): an idle session
 * starts a new turn with it, a busy one reads it between tool calls. The
 * sender is a descendant of the claude process (launcher or browser bridge),
 * so the session accepts it without asking the user. The socket is
 * documented, the line format only in Claude Code's debug log (measured with
 * 2.1.296).
 */
export function postToInbox(text: string): Promise<boolean> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  return new Promise(resolve => {
    if (!socketPath) return resolve(false);
    let answer = '', finished = false;
    const socket = net.connect(socketPath);
    const done = (ok: boolean, why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      log(`feedback pushed to the Claude Code inbox: ${why}${answer.trim() ? ` (${answer.trim().slice(0, 300)})` : ''}`);
      resolve(ok);
    };
    const timer = setTimeout(() => done(true, 'sent'), 3000);
    socket.setEncoding('utf8');
    socket.on('data', d => { answer += d; });
    socket.once('error', e => done(false, `failed: ${e.message}`));
    socket.once('close', () => done(true, 'sent'));
    socket.once('connect', () => {
      if (token) socket.write(JSON.stringify({ type: 'auth', token }) + '\n');
      socket.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      socket.end();
    });
  });
}
