import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedStorage, serverUrl } from '../src/web-session.ts';
function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,String(v)), removeItem: k => map.delete(k), clear: () => map.clear() };
}
test('server sessions isolate credentials, UI state and logout', () => {
  const raw = storage(); raw.setItem('canvas.desktop.connection','keep');
  const a = scopedStorage(raw,'https://a.example');
  const b = scopedStorage(raw,'https://b.example');
  a.setItem('authToken','a'); a.setItem('lastPath','/private'); b.setItem('authToken','b');
  assert.equal(b.getItem('lastPath'),null);assert.equal(a.getItem('authToken'),'a');
  a.clear();assert.equal(b.getItem('authToken'),'b');assert.equal(raw.getItem('canvas.desktop.connection'),'keep');
});
test('only the authenticated token is forwarded to the native remote store', () => {
  const tokens=[];const s=scopedStorage(storage(),'https://a.example', t=>tokens.push(t));
  s.setItem('lastPath','/');s.setItem('authToken','canvas-token');s.removeItem('authToken');
  assert.deepEqual(tokens,['canvas-token']);
});
test('server addresses reject credentials and unsupported schemes', () => {
  assert.equal(serverUrl('https://example.com/'),'https://example.com');
  for(const url of ['file:///tmp/app','javascript:alert(1)','https://user:password@example.com','https://example.com?token=x']) assert.throws(()=>serverUrl(url));
});
