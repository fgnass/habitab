import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldError } from '../../launcher/browser';
import { isAgentAction } from '../../shared/agent-actions';

test('a command that waited for the user gets an error that names the cause', () => {
  const reply = JSON.parse(heldError('{"id":7,"method":"Input.dispatchMouseEvent","params":{},"sessionId":"S1"}', 30_400)!);
  assert.equal(reply.id, 7);
  assert.equal(reply.sessionId, 'S1');
  assert.equal(reply.error.code, -32000);
  assert.match(reply.error.message, /user has taken control/);
  assert.match(reply.error.message, /waited 30 s/);
  assert.match(reply.error.message, /do not debug/);
});

test('a browser-level command gets its error without a session', () => {
  const reply = JSON.parse(heldError('{"id":3,"method":"Target.createTarget","params":{}}', 31_000)!);
  assert.equal(reply.id, 3);
  assert.equal('sessionId' in reply, false);
});

test('no error for a message without an id', () => {
  assert.equal(heldError('{"method":"Runtime.evaluate"}', 31_000), undefined);
  assert.equal(heldError('not json', 31_000), undefined);
});

test('only the agent actions wait for the user, not the server bookkeeping', () => {
  for (const m of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Runtime.callFunctionOn', 'Runtime.evaluate', 'Page.navigate', 'Page.captureScreenshot', 'Accessibility.getFullAXTree'])
    assert.equal(isAgentAction(m), true, m);
  for (const m of ['DOM.getTopLayerElements', 'Target.getDevToolsTarget', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Page.getFrameTree', 'DOM.resolveNode', 'Network.enable', undefined])
    assert.equal(isAgentAction(m), false, String(m));
});
