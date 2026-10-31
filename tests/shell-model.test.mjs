import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, navigate, navigateLocation, focusFrame, scopeKey, addCanvas, updateLayout, closeTab, detachTab, parseState, cycleMenu, openTab, patchTab, browserCanvas, webCanvas, webTitle, routeScope, documentLocation, tabAction, moveTab, closeSavedTab } from '../src/shell/model.ts';

const incident = { mode: 'explorer', workspace: 'universe', tree: 'context', treeType: 'context', path: '/work/customer-foo/ops/snow-12345' };
test('path changes restore independent windows and tabs without mutating the previous layout', () => {
  const first = navigate(initialState(), incident);
  const key = scopeKey(incident);
  const edited = updateLayout(first, key, layout => addCanvas(addCanvas(layout, 'notes'), 'emails', true));
  const elsewhere = navigate(edited, { ...incident, path: '/work/other' });
  assert.equal(elsewhere.layouts[scopeKey(elsewhere.scope)].frames.length, 1);
  const returned = navigate(elsewhere, incident);
  assert.deepEqual(returned.layouts[key], edited.layouts[key]);
  assert.equal(returned.layouts[key].frames.length, 2);
  assert.equal(returned.layouts[key].frames[1].tabs.length, 2);
  assert.equal(first.layouts[key].frames.length, 1);
  assert.deepEqual(parseState(JSON.stringify(returned)), returned);
});
test('scope identity normalizes separators and separates trees, workspaces and tree types', () => {
  assert.equal(scopeKey(incident), scopeKey({ ...incident, path: '//work/customer-foo/ops/snow-12345/' }));
  for (const patch of [{ workspace: 'other' }, { tree: 'other' }, { treeType: 'directory' }, { path: '/work/customer-foo/ops/snow-99999' }]) assert.notEqual(scopeKey(incident), scopeKey({ ...incident, ...patch }));
});
test('closing the final tab preserves an intentionally empty path', () => {
  let state = navigate(initialState(), incident);
  const key = scopeKey(incident), frame = state.layouts[key].frames[0];
  state = updateLayout(state, key, layout => closeTab(layout, frame.id, frame.active));
  assert.equal(navigate(state, incident).layouts[key].frames.length, 0);
  assert.equal(parseState(JSON.stringify(state)).layouts[key].focused, '');
});
test('detaching moves the same tab into a new window and leaves a valid active tab', () => {
  const state = navigate(initialState(), incident);
  const layout = addCanvas(state.layouts[scopeKey(incident)], 'notes', true);
  const frame = layout.frames[0], detached = frame.active;
  const next = detachTab(layout, frame.id, detached);
  assert.equal(next.frames.length, 2);
  assert.equal(next.frames[0].tabs.length, 1);
  assert.equal(next.frames[0].active, next.frames[0].tabs[0].id);
  assert.equal(next.frames[1].active, detached);
  assert.equal(next.focused, next.frames[1].id);
});
test('global toolbox state survives context changes and menu cycling reaches all levels', () => {
  const state = initialState(); state.toolbox = { mode: 'global', open: true, page: 'agents' };
  assert.deepEqual(navigate(state, incident).toolbox, state.toolbox);
  assert.deepEqual(['hidden', 'm2', 'm1', 'm0'].map(cycleMenu), ['m2', 'm1', 'm0', 'hidden']);
});
test('unsupported or corrupt layouts fail without silently resetting saved data', () => {
  assert.throws(() => parseState('{bad json'));
  assert.throws(() => parseState(JSON.stringify({ ...initialState(), version: 999 })));
  assert.throws(() => parseState(JSON.stringify({ ...initialState(), gap: -1 })));
  const state = navigate(initialState(), incident);
  state.layouts[scopeKey(incident)].frames.push(state.layouts[scopeKey(incident)].frames[0]);
  assert.throws(() => parseState(JSON.stringify(state)));
});

test('links open as a tab of their frame by default and beside it with shift', () => {
  let layout = addCanvas(addCanvas(navigate(initialState(), incident).layouts[scopeKey(incident)], 'notes'), 'files');
  const [first, second, third] = layout.frames.map(frame => frame.id);
  const page = browserCanvas('https://example.com/docs', undefined);
  assert.equal(page.kind, 'browser');
  assert.equal(page.title, 'example.com');
  layout = openTab(layout, page, { frame: first });
  assert.equal(layout.frames.length, 3);
  assert.deepEqual(layout.frames[0].tabs.map(tab => tab.id).slice(-1), [page.id]);
  assert.equal(layout.frames[0].active, page.id);
  assert.equal(layout.focused, first, 'opening a tab focuses its frame');
  const beside = browserCanvas('https://example.org');
  layout = openTab(layout, beside, { frame: first, side: true });
  assert.equal(layout.frames.length, 4);
  assert.equal(layout.frames[1].tabs[0].id, beside.id, 'a side canvas lands right after its source frame');
  assert.deepEqual(layout.frames.slice(2).map(frame => frame.id), [second, third]);
  assert.equal(layout.focused, layout.frames[1].id);
  const renamed = patchTab(layout, layout.frames[1].id, beside.id, { title: 'Example Domain' });
  assert.equal(renamed.frames[1].tabs[0].title, 'Example Domain');
  assert.equal(layout.frames[1].tabs[0].title, 'example.org', 'patching never mutates the previous layout');
  assert.deepEqual(parseState(JSON.stringify({ ...navigate(initialState(), incident), layouts: { [scopeKey(incident)]: renamed } })).layouts[scopeKey(incident)], renamed);
});

test('web UI routes become tabs with readable titles and tree paths map back to desktop scopes', () => {
  assert.equal(webTitle('/'), 'Desk');
  assert.equal(webTitle('/home'), 'Home');
  assert.equal(webTitle('/workspaces/universe/trees/context/path/work/customer-foo?x=1'), 'customer-foo');
  assert.equal(webTitle('/workspaces/universe/documents/42'), 'Document');
  assert.equal(webTitle('/api-tokens'), 'Api tokens');
  assert.equal(documentLocation('universe', 42), '/workspaces/universe/documents/42');
  const treeType = tree => tree === 'context' ? 'context' : 'directory';
  assert.deepEqual(routeScope('/workspaces/universe/trees/context/path/work/customer-foo', treeType), { mode: 'explorer', workspace: 'universe', tree: 'context', treeType: 'context', path: '/work/customer-foo' });
  assert.deepEqual(routeScope('/workspaces/universe/trees/projects', treeType), { mode: 'explorer', workspace: 'universe', tree: 'projects', treeType: 'directory', path: '/' });
  assert.deepEqual(routeScope('/workspaces/universe', treeType).path, '/');
  assert.equal(routeScope('/workspaces/universe/documents/42', treeType), undefined);
  assert.equal(routeScope('/workspaces/universe/settings', treeType), undefined);
  assert.equal(routeScope('/agents', treeType), undefined);
  const tab = webCanvas('/workspaces/universe/documents/42', 'Incident notes');
  assert.equal(tab.kind, 'web');
  let state = navigate(initialState(), incident);
  state = updateLayout(state, scopeKey(incident), layout => openTab(layout, tab));
  assert.deepEqual(parseState(JSON.stringify(state)), state);
});

test('pinned frames follow paths with their tabs and placement identity, including returning to an existing layout', () => {
  let state = navigate(initialState(), incident);
  const firstKey = scopeKey(incident);
  state = updateLayout(state, firstKey, layout => addCanvas(layout, 'emails'));
  const pinned = state.layouts[firstKey].frames[1];
  pinned.pinned = true;
  pinned.tabs[0].documentLayout = 'table';
  const nextScope = { ...incident, path: '/next' };
  state = navigate(state, nextScope);
  assert.deepEqual(state.layouts[scopeKey(nextScope)].frames, [pinned]);
  assert.equal(state.layouts[firstKey].frames.length, 1);
  state = parseState(JSON.stringify(state));
  state = navigate(state, incident);
  assert.equal(state.layouts[firstKey].frames[0].id, pinned.id);
  assert.equal(state.layouts[firstKey].frames[0].tabs[0].documentLayout, 'table');
  assert.equal(state.layouts[firstKey].frames.length, 2);
  assert.equal(state.layouts[scopeKey(nextScope)].frames.length, 0);
  state = updateLayout(state, firstKey, layout => ({ ...layout, frames: layout.frames.map(frame => ({ ...frame, pinned: false })) }));
  assert.equal(navigate(state, nextScope).layouts[scopeKey(nextScope)].frames.length, 0);
});

test('in-page searches preserve their query without replacing a pinned canvas', () => {
  let state = navigate(initialState(), incident);
  const key = scopeKey(incident), frame = state.layouts[key].frames[0];
  frame.pinned = true;
  const location = '/workspaces/universe/trees/context/path/work?q=latency#results';
  state = navigateLocation(state, incident, location, frame.id, frame.active);
  assert.equal(state.layouts[key].frames[0].tabs[0].location, location);
  assert.equal(state.layouts[key].frames[0].id, frame.id);
});

test('delayed focus notifications from closed and hidden windows cannot corrupt the selection', () => {
  const initial = navigate(initialState(), incident), key = scopeKey(incident);
  const original = initial.layouts[key].frames[0];
  let state = updateLayout(initial, key, layout => addCanvas(layout, 'emails'));
  const other = state.layouts[key].frames[1];
  state = updateLayout(state, key, layout => closeTab(layout, original.id, original.active));
  assert.equal(focusFrame(state, original.id), state);
  assert.equal(parseState(JSON.stringify(state)).layouts[key].focused, other.id);
  const elsewhere = navigate(state, { ...incident, path: '/elsewhere' });
  assert.equal(focusFrame(elsewhere, other.id), elsewhere);
  const closed = updateLayout(state, key, layout => closeTab(layout, other.id, other.active));
  assert.equal(focusFrame(closed, other.id), closed);
  assert.equal(parseState(JSON.stringify(closed)).layouts[key].focused, '');
});

test('browser tab commands create, cycle, close adjacent and reopen the same tab', () => {
  let state = navigate(initialState(), incident);
  const key = scopeKey(incident), original = state.layouts[key].frames[0];
  state = tabAction(state, 'new-tab', original.id);
  const browser = state.layouts[key].frames[0].tabs[1];
  assert.equal(browser.kind, 'browser');
  state = tabAction(state, 'previous-tab', original.id);
  assert.equal(state.layouts[key].frames[0].active, original.active);
  state = closeSavedTab(state, key, original.id, original.active);
  assert.equal(state.layouts[key].frames[0].active, browser.id);
  state = tabAction(state, 'reopen-tab');
  assert.equal(state.layouts[key].frames[0].tabs[0].id, original.active);
  state = tabAction(state, 'new-window');
  assert.equal(state.layouts[key].frames.length, 2);
  assert.deepEqual(parseState(JSON.stringify(state)), state);
});
test('dragging tabs preserves identity across ordering and window merges', () => {
  let layout = addCanvas(navigate(initialState(), incident).layouts[scopeKey(incident)], 'terminal');
  const [first, second] = layout.frames;
  layout = openTab(layout, browserCanvas('https://example.com'), { frame: first.id });
  const tab = layout.frames[0].tabs[1];
  layout = moveTab(layout, first.id, tab.id, first.id, first.active);
  assert.equal(layout.frames[0].tabs[0].id, tab.id);
  layout = moveTab(layout, first.id, tab.id, second.id);
  assert.equal(layout.frames[1].tabs[1].id, tab.id);
  assert.equal(layout.focused, second.id);
  assert.equal(layout.frames[0].tabs.length, 1);
});

test('a shortcut from a dormant native window cannot close the current context tab', () => {
  const original = navigate(initialState(), incident);
  const frame = original.layouts[scopeKey(incident)].frames[0];
  const current = navigate(original, { ...incident, path: '/different' });
  assert.equal(tabAction(current, 'close-tab', frame.id), current);
});
