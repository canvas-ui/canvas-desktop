import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandQueue } from '../src/shell/command-queue.ts';

test('creation, cleanup and remount execute in order even while creation is pending', async () => {
  const enqueue = createCommandQueue();
  let created = false, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const order = [];
  const first = enqueue('window', async () => { order.push('creating'); await blocked; created = true; });
  const close = enqueue('window', async () => { assert.equal(created, true); order.push('close'); created = false; });
  const remount = enqueue('window', async () => { assert.equal(created, false); order.push('reopen'); created = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['creating']);
  release();
  await Promise.all([first, close, remount]);
  assert.deepEqual(order, ['creating', 'close', 'reopen']);
});

test('a failed creation does not block other windows or subsequent retry', async () => {
  const enqueue = createCommandQueue();
  const failure = enqueue('one', async () => { throw new Error('create failed'); });
  const failed = assert.rejects(failure, /create failed/);
  assert.equal(await enqueue('two', async () => 'other'), 'other');
  assert.equal(await enqueue('one', async () => 'retry'), 'retry');
  await failed;
});
