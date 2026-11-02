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
  store.dispatch({ type: 'preferences', patch: { menu: 'm1' } });
  assert.equal(store.get().menu, 'm1');
});

test('invalid updates never replace the saved layout', () => {
  const values = storage();
  const store = createDesktopStore('test');
  store.dispatch({ type: 'navigate', scope });
  const before = values.get(key);
  assert.throws(() => store.dispatch({ type: 'preferences', patch: { gap: -1 } }));
  assert.equal(values.get(key), before);
  assert.equal(store.get().gap, 16);
});

test('local preferences and repeated metadata preserve frame identity', () => {
  storage();
  const store = createDesktopStore('test');
  store.dispatch({ type: 'navigate', scope });
  const frame = store.get().layouts[scopeKey(scope)].frames[0];
  store.dispatch({ type: 'preferences', patch: { menu: 'm0' } });
  assert.equal(store.get().layouts[scopeKey(scope)].frames[0], frame);
  const before = store.get();
  store.dispatch({ type: 'preferences', patch: { menu: 'm0' } });
  assert.equal(store.get(), before);
});

test('another webview can update preferences without replacing unchanged frames', () => {
  const values = storage();
  const store = createDesktopStore('test');
  store.dispatch({ type: 'navigate', scope });
  const frame = store.get().layouts[scopeKey(scope)].frames[0];
  const remote = JSON.parse(values.get(key));
  remote.toolbox.open = true;
  values.set(key, JSON.stringify(remote));
  store.dispatch({ type: 'preferences', patch: { menu: 'm0' } });
  assert.equal(store.get().toolbox.open, true);
  assert.equal(store.get().layouts[scopeKey(scope)].frames[0], frame);
  assert.equal(JSON.parse(values.get(key)).toolbox.open, true);
});

function peers() {
  const queue = [], handlers = new Map(), errors = [];
  globalThis.window = new EventTarget();
  function peer(id, seed) {
    const values = storage();
    if (seed) values.set(key, JSON.stringify(seed));
    let writes = 0;
    const set = localStorage.setItem;
    localStorage.setItem = (key, value) => { writes++; set(key, value); };
    const channel = {
      owner: id === 'main',
      receive: callback => { handlers.set(id, callback); return () => handlers.delete(id); },
      send: async message => { queue.push([id, structuredClone(message)]); },
      report: error => errors.push(String(error)),
    };
    const store = createDesktopStore('test', channel);
    const unsubscribe = store.subscribe(() => {});
    return { store, values, writes: () => writes, close: () => { unsubscribe(); store.dispose(); } };
  }
  function flush() {
    for (let guard = 0; queue.length && guard < 100; guard++) {
      const [id, message] = queue.shift();
      if (id === 'main') { for (const [name, handle] of handlers) if (name !== 'main') handle(message); }
      else handlers.get('main')?.(message);
    }
    assert.equal(queue.length, 0);
    assert.deepEqual(errors, []);
  }
  return { peer, flush };
}

test('stale window metadata cannot overwrite a tab created by the authoritative host', () => {
  const { peer, flush } = peers();
  const main = peer('main');
  main.store.dispatch({ type: 'navigate', scope });
  const child = peer('canvas', main.store.get());
  flush();
  const layoutKey = scopeKey(scope);
  const frame = child.store.get().layouts[layoutKey].frames[0];
  main.store.dispatch({ type: 'shortcut', action: 'new-tab' });
  child.store.dispatch({ type: 'patch-tab', key: layoutKey, frame: frame.id, tab: frame.active, patch: { view: { id: 'all', name: 'All', kind: 'documents' } } });
  flush();
  assert.equal(main.store.get().layouts[layoutKey].frames[0].tabs.length, 2);
  assert.deepEqual(child.store.get(), main.store.get());
  assert.equal(child.writes(), 0);
  main.close(); child.close();
});

test('concurrent windows keep every new tab and acknowledge optimistic actions once', () => {
  const { peer, flush } = peers();
  const main = peer('main');
  main.store.dispatch({ type: 'navigate', scope });
  const first = peer('first', main.store.get()), second = peer('second', main.store.get());
  flush();
  first.store.dispatch({ type: 'shortcut', action: 'new-tab' });
  second.store.dispatch({ type: 'shortcut', action: 'new-tab' });
  first.store.dispatch({ type: 'toolbox', patch: { open: true } });
  flush();
  assert.equal(main.store.get().layouts[scopeKey(scope)].frames[0].tabs.length, 3);
  assert.deepEqual(first.store.get(), main.store.get());
  assert.deepEqual(second.store.get(), main.store.get());
  assert.equal(first.writes() + second.writes(), 0);
  main.close(); first.close(); second.close();
});

test('a native focus action reaches the owner even when the window snapshot still shows it focused', () => {
  const { peer, flush } = peers();
  const main = peer('main');
  main.store.dispatch({ type: 'navigate', scope });
  main.store.dispatch({ type: 'open-canvas', kind: 'notes' });
  const frames = main.store.get().layouts[scopeKey(scope)].frames;
  main.store.dispatch({ type: 'focus-frame', frame: frames[0].id });
  const child = peer('first', main.store.get());
  flush();
  main.store.dispatch({ type: 'focus-frame', frame: frames[1].id });
  child.store.dispatch({ type: 'focus-frame', frame: frames[0].id });
  flush();
  assert.equal(main.store.get().layouts[scopeKey(scope)].focused, frames[0].id);
  assert.deepEqual(child.store.get(), main.store.get());
  main.close(); child.close();
});
