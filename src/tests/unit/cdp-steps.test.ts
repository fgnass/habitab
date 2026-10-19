import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StepDetector, StepEnd, StepStart } from '../../app/cdp-steps';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('steps from CDP commands: boundaries, names, dropped bookkeeping', async () => {
  const started: StepStart[] = [], ended: StepEnd[] = [];
  const d = new StepDetector({ start: s => started.push(s), end: e => ended.push(e) });
  let id = 0;
  const cmd = (method: string, params: any = {}, sessionId = 'S1') => { const k = `1:${++id}`; d.command(k, method, params, sessionId); return k; };
  const done = (k: string, error?: string) => d.reply(k, error);
  // Puppeteer attaches: bookkeeping only, no step.
  for (const m of ['Target.setDiscoverTargets', 'Target.setAutoAttach', 'Runtime.enable', 'Page.enable']) done(cmd(m));
  await sleep(700);
  assert.equal(started.length, 0);
  // navigate_page: the step waits for the load event, then the trailing polls join it
  const nav = cmd('Page.navigate', { url: 'http://x/one' });
  done(nav);
  assert.equal(started[0]?.tool, 'Navigate');
  await sleep(700);
  assert.equal(ended.length, 0, 'open while loading');
  d.event('Page.loadEventFired');
  done(cmd('Runtime.callFunctionOn', { functionDeclaration: 'timeout => {}' }));
  done(cmd('Target.getDevToolsTarget', {}, undefined));
  await sleep(700);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].tool, 'Navigate');
  assert.equal(ended[0].summary, 'http://x/one');
  // list_pages: nothing worth a step
  done(cmd('Target.getTargets', {}, undefined));
  await sleep(700);
  assert.equal(ended.length, 1);
  // evaluate_script: the script's source from the evaluate before the wrapper
  done(cmd('Runtime.evaluate', { expression: '(\n() => 1 + 1\n)\n//# sourceURL=pptr:evaluate;x' }));
  done(cmd('Runtime.callFunctionOn', { functionDeclaration: 'async (fn, ...args) => {\n return JSON.stringify(await fn(...args));\n}' }));
  done(cmd('Target.getDevToolsTarget', {}, undefined));
  await sleep(700);
  assert.equal(ended[1]?.tool, 'Script');
  assert.equal(ended[1]?.summary, '() => 1 + 1');
  // click then snapshot without a pause: one step with both names, the click first
  done(cmd('Input.dispatchMouseEvent', { type: 'mouseMoved' }));
  done(cmd('Input.dispatchMouseEvent', { type: 'mousePressed', clickCount: 1 }));
  done(cmd('Input.dispatchMouseEvent', { type: 'mouseReleased' }));
  done(cmd('Accessibility.getFullAXTree'));
  await sleep(700);
  assert.equal(ended[2]?.tool, 'Click, Snapshot');
  // typing: the text as summary; a named key: Press
  for (const ch of 'hi') { done(cmd('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })); done(cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })); }
  done(cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' }));
  await sleep(700);
  assert.equal(ended[3]?.tool, 'Type, Press');
  assert.equal(ended[3]?.summary, 'hi');
  // a command without answer keeps the step open; an error answer marks it
  const shot = cmd('Page.captureScreenshot');
  await sleep(700);
  assert.equal(ended.length, 4, 'open while a command waits for its answer');
  done(shot, 'Target closed');
  await sleep(700);
  assert.equal(ended[4]?.tool, 'Screenshot');
  assert.equal(ended[4]?.isError, true);
  assert.equal(ended[4]?.detail, 'Target closed');
  assert.equal(started.length, ended.length);
  d.close();
});
