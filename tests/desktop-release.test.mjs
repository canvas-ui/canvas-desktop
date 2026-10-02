import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, prepareRelease, finalizeRelease } from '../scripts/desktop-release.mjs';
const sha = 'a'.repeat(40);
const ref = 'b'.repeat(40);
const assets = ['Canvas_amd64.deb', 'Canvas_x86_64.rpm', 'Canvas_amd64.AppImage', 'Canvas_aarch64.dmg', 'Canvas_x64.dmg', 'Canvas_x64.msi', 'Canvas_x64-setup.exe'].map(name => ({ name, size: 100 }));
test('new releases stay draft until all installers succeed', () => {
    const calls = [];
    assert.deepEqual(prepareRelease({ tag: 'v1.0.0', sha }, args => calls.push(args)), { tag: 'v1.0.0', ref: sha });
    assert.ok(calls[0].includes('--draft'));
    assert.throws(() => finalizeRelease({ assets: assets.slice(1) }, 'v1.0.0', args => calls.push(args)), /missing installers/);
    assert.equal(calls.length, 1);
    finalizeRelease({ assets }, 'v1.0.0', args => calls.push(args));
    assert.ok(calls[1].includes('--draft=false'));
});
test('retry resumes drafts and repairs incomplete public releases at their original commit', () => {
    for (const draft of [true, false]) {
        const calls = [];
        assert.deepEqual(prepareRelease({ release: { draft, target_commitish: ref, assets: [] }, tag: 'v1.0.0', sha }, args => calls.push(args)), { tag: 'v1.0.0', ref });
        assert.equal(calls.length, draft ? 0 : 1);
        if (!draft) assert.ok(calls[0].includes('--draft=true'));
    }
});
test('complete public releases are untouched; empty installers do not count', () => {
    assert.equal(prepareRelease({ release: { draft: false, assets }, tag: 'v1.0.0', sha }, () => assert.fail('release changed')), null);
    assert.equal(complete({ assets: assets.map(asset => ({ ...asset, size: 0 })) }), false);
    assert.throws(() => prepareRelease({ release: { draft: true, target_commitish: 'main' }, tag: 'v1.0.0', sha }, () => {}), /immutable/);
});
