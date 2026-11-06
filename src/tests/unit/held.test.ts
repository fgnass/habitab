import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldError, trackSession, waitsForTabs } from '../../launcher/browser';
import { isAgentAction } from '../../shared/agent-actions';

test('a command that waited for the user gets an error that names the cause', () => {
  const reply = JSON.parse(heldError('{"id":7,"method":"Input.dispatchMouseEvent","params":{},"sessionId":"S1"}', 30_400)!);
  assert.equal(reply.id, 7);
  assert.equal(reply.sessionId, 'S1');
  assert.equal(reply.error.code, -32000);
  assert.match(reply.error.message, /user uses this browser/);
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

test('control of one tab: the agent\'s actions in its other tabs go on', () => {
  const pageOf = new Map<string, string>();
  trackSession({ method: 'Target.attachedToTarget', params: { sessionId: 'SA', targetInfo: { targetId: 'A', type: 'page' } } }, pageOf);
  trackSession({ method: 'Target.attachedToTarget', params: { sessionId: 'SB', targetInfo: { targetId: 'B', type: 'page' } } }, pageOf);
  // A frame of B belongs to B.
  trackSession({ method: 'Target.attachedToTarget', sessionId: 'SB', params: { sessionId: 'SF', targetInfo: { targetId: 'F', type: 'iframe' } } }, pageOf);
  const held = new Set(['B']);
  const cmd = (method: string, sessionId?: string, params: object = {}) => JSON.stringify({ id: 1, method, params, ...(sessionId ? { sessionId } : {}) });
  assert.equal(waitsForTabs(cmd('Input.dispatchMouseEvent', 'SA'), held, pageOf), false);
  assert.equal(waitsForTabs(cmd('Input.dispatchMouseEvent', 'SB'), held, pageOf), true);
  assert.equal(waitsForTabs(cmd('Runtime.evaluate', 'SF'), held, pageOf), true);
  assert.equal(waitsForTabs(cmd('Target.closeTarget', undefined, { targetId: 'A' }), held, pageOf), false);
  assert.equal(waitsForTabs(cmd('Target.closeTarget', undefined, { targetId: 'B' }), held, pageOf), true);
  // Commands that would show another tab in place of the user's wait.
  assert.equal(waitsForTabs(cmd('Target.createTarget', undefined, { url: 'about:blank' }), held, pageOf), true);
  assert.equal(waitsForTabs(cmd('Target.activateTarget', undefined, { targetId: 'A' }), held, pageOf), true);
  assert.equal(waitsForTabs(cmd('Page.bringToFront', 'SA'), held, pageOf), true);
  trackSession({ method: 'Target.detachedFromTarget', params: { sessionId: 'SB' } }, pageOf);
  assert.equal(waitsForTabs(cmd('Input.dispatchMouseEvent', 'SB'), held, pageOf), false);
});

test('the error names a tab when the user has control of single tabs', () => {
  const reply = JSON.parse(heldError('{"id":7,"method":"Input.dispatchMouseEvent","params":{},"sessionId":"S1"}', 30_400, true)!);
  assert.match(reply.error.message, /user uses a tab of this browser/);
});
