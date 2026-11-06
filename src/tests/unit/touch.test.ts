import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showsContextMenu } from '../../shared/touch';

test('a long press (touch emulation) opens no context menu; a right click and the menu key do', () => {
  for (const s of ['longPress', 'longTap', 'touch', 'touchMenu', 'touchHandle']) assert.equal(showsContextMenu(s), false, s);
  for (const s of ['mouse', 'keyboard', 'none', undefined]) assert.equal(showsContextMenu(s), true, String(s));
});
