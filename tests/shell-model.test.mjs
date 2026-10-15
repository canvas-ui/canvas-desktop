import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, navigate, scopeKey, addCanvas, updateLayout, closeTab, detachTab, parseState, cycleMenu } from '../src/shell/model.ts';

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
  assert.throws(() => parseState(JSON.stringify({ ...initialState(), version: 2 })));
  assert.throws(() => parseState(JSON.stringify({ ...initialState(), gap: -1 })));
  const state = navigate(initialState(), incident);
  state.layouts[scopeKey(incident)].frames.push(state.layouts[scopeKey(incident)].frames[0]);
  assert.throws(() => parseState(JSON.stringify(state)));
});
