import test from 'node:test';
import assert from 'node:assert/strict';
import { readArrangement, withArrangement, documentRoute, pathRoute } from '../src/desktop-state.ts';
const empty = { version: 1, canvases: [] };
const canvas = { id: 'mail', kind: 'emails', title: 'Mail', width: 1, height: 360 };
test('Explorer defaults only when desktop metadata is absent; saved empty stays empty', () => {
  assert.equal(readArrangement({ toolbox: { schema: 'email' } }).canvases[0].kind, 'content');
  assert.deepEqual(readArrangement({ ui: { desktop: empty } }), empty);
});
test('saving a context or layer preserves query filters, web UI, and unknown desktop fields', () => {
  const metadata = { toolbox: { filters: ['notes'] }, ui: { color: '#fff', web: { columns: 2 }, desktop: { version: 1, canvases: [], future: true } }, custom: 42 };
  const arrangement = readArrangement(metadata);
  arrangement.canvases.push(canvas);
  const saved = withArrangement(metadata, arrangement);
  assert.deepEqual(saved.toolbox, metadata.toolbox);
  assert.deepEqual(saved.ui.web, metadata.ui.web);
  assert.equal(saved.ui.color, '#fff');
  assert.equal(saved.ui.desktop.future, true);
  assert.equal(saved.custom, 42);
  assert.equal(metadata.ui.desktop.canvases.length, 0);
});
test('future versions, duplicate IDs, and invalid geometry fail without default replacement', () => {
  for (const desktop of [{ version: 2, canvases: [] }, { version: 1, canvases: [canvas, canvas] }, { version: 1, canvases: [{ ...canvas, width: 0 }] }, null]) {
    assert.throws(() => readArrangement({ ui: { desktop } }));
  }
});
test('context-bound views use context documents so stored filters remain server enforced', () => {
  const route = documentRoute({ mode: 'context', context: 'dc-migration' }, { ...canvas, query: 'urgent' });
  assert.match(route, /^\/contexts\/dc-migration\/documents\?/);
  const params = new URLSearchParams(route.split('?')[1]);
  assert.equal(params.get('allOf'), 'data/schema/message/email');
  assert.equal(params.get('q'), 'urgent');
  assert.equal(params.has('applyContextSpec'), false);
  assert.equal(params.has('context'), false);
});
test('Explorer navigation changes the path scope and correctly selects directory trees', () => {
  const binding = { mode: 'explorer', workspace: 'work', tree: 'tasks', treeType: 'directory', path: '/ops/jira-1001' };
  const before = documentRoute(binding, canvas);
  const after = documentRoute({ ...binding, path: '/ops/jira-1002' }, canvas);
  assert.notEqual(before, after);
  const params = new URLSearchParams(after.split('?')[1]);
  assert.equal(params.get('context'), '/ops/jira-1002');
  assert.equal(params.get('treeNameOrTreeId'), 'tasks');
  assert.equal(params.get('treeType'), 'directory');
});
test('metadata path encoding keeps path segments separate and escapes reserved characters', () => {
  assert.equal(pathRoute('work', 'tasks', '/ops/a #b'), '/workspaces/work/trees/tasks/path/ops/a%20%23b');
});
