import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopStore } from '../src/shell/store.ts';
import { initialState, navigate, scopeKey } from '../src/shell/model.ts';

const scope = { mode: 'explorer', workspace: 'universe', tree: 'context', treeType: 'context', path: '/mail' };
const key = 'desktop.shell.v2:test';
function storage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  return values;
}

test('a saved stale focus is repaired without losing the layout or blocking menu updates', () => {
  const values = storage();
  const saved = navigate(initialState(), scope);
  const layout = saved.layouts[scopeKey(scope)];
  layout.frames[0].pinned = true;
  layout.focused = 'closed-window';
  values.set(key, JSON.stringify(saved));
  const store = createDesktopStore('test');
  assert.equal(store.error(), '');
  assert.deepEqual(store.get().layouts[scopeKey(scope)].frames, layout.frames);
  assert.equal(store.get().layouts[scopeKey(scope)].focused, layout.frames[0].id);
  assert.equal(JSON.parse(values.get(key)).layouts[scopeKey(scope)].focused, layout.frames[0].id);
  store.update(old => ({ ...old, menu: 'm1' }));
  assert.equal(store.get().menu, 'm1');
});

test('invalid updates never replace the saved layout', () => {
  const values = storage();
  const store = createDesktopStore('test');
  store.update(() => navigate(initialState(), scope));
  const before = values.get(key);
  assert.throws(() => store.update(old => ({ ...old, gap: -1 })));
  assert.equal(values.get(key), before);
  assert.equal(store.get().gap, 16);
});
