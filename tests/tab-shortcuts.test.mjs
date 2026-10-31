import test from 'node:test';
import assert from 'node:assert/strict';
import { tabShortcut } from '../src/shell/tab-shortcuts.ts';
const key = (code, options = {}) => tabShortcut({ code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...options });
test('browser accelerators preserve shell Ctrl+C and reserve the usual tab controls', () => {
  assert.equal(key('KeyT'), 'new-tab');
  assert.equal(key('KeyT', { shiftKey: true }), 'reopen-tab');
  assert.equal(key('KeyW'), 'close-tab');
  assert.equal(key('KeyN'), 'new-window');
  assert.equal(key('Tab', { shiftKey: true }), 'previous-tab');
  assert.equal(key('Digit9'), 'select-9');
  assert.equal(key('KeyC'), undefined);
  assert.equal(key('KeyT', { ctrlKey: false }), undefined);
  assert.equal(key('KeyL'), 'address');
});
