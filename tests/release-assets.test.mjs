import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishStableAssets, stableAssetName, stableAssetPlan } from '../scripts/release-assets.mjs';

const pairs = [
    ['Canvas.Desktop-0.3.2-1.x86_64.rpm', 'canvas-desktop-linux-x86_64.rpm'],
    ['Canvas.Desktop_0.3.2_amd64.AppImage', 'canvas-desktop-linux-x86_64.AppImage'],
    ['Canvas.Desktop_0.3.2_amd64.deb', 'canvas-desktop-linux-x86_64.deb'],
    ['Canvas.Desktop_0.3.2_aarch64.dmg', 'canvas-desktop-macos-aarch64.dmg'],
    ['Canvas.Desktop_0.3.2_x64.dmg', 'canvas-desktop-macos-x86_64.dmg'],
    ['Canvas.Desktop_0.3.2_x64-setup.exe', 'canvas-desktop-windows-x86_64-setup.exe'],
    ['Canvas.Desktop_0.3.2_x64_en-US.msi', 'canvas-desktop-windows-x86_64-en-US.msi'],
    ['Canvas.Desktop_aarch64.app.tar.gz', 'canvas-desktop-macos-aarch64.app.tar.gz'],
    ['Canvas.Desktop_x64.app.tar.gz', 'canvas-desktop-macos-x86_64.app.tar.gz'],
];
test('all desktop installer names have stable, distinct aliases across versions', () => {
    for (const [original, alias] of pairs) {
        assert.equal(stableAssetName(original), alias);
        assert.equal(stableAssetName(original.replace('0.3.2', '12.34.56')), alias);
        assert.equal(stableAssetName(alias), null);
        assert.equal(stableAssetName(`${original}.sig`), null);
    }
    assert.equal(stableAssetName('latest.json'), null);
    assert.equal(stableAssetName('Canvas.Desktop_0.3.2_arm64_en-US.msi'), null);
    assert.equal(stableAssetName('Canvas.Desktop_0.3.2_x64_de-DE.msi'), 'canvas-desktop-windows-x86_64-de-DE.msi');
});
test('ambiguous, empty, and unsafe source assets are rejected', () => {
    const asset = { name: pairs[0][0], size: 100 };
    assert.throws(() => stableAssetPlan([asset, { ...asset, name: asset.name.replace('0.3.2', '0.3.3') }]), /Multiple installers/);
    assert.throws(() => stableAssetPlan([{ ...asset, size: 0 }]), /Invalid installer/);
    assert.throws(() => stableAssetPlan([{ ...asset, name: 'Canvas.Desktop_/../../bad_x64.deb' }]), /Invalid installer/);
});
test('backfill preserves originals, verifies bytes, uploads aliases and checksums, and cleans temporary files', () => {
    const data = Buffer.from('installer bytes');
    const hash = createHash('sha256').update(data).digest('hex');
    const assets = pairs.map(([name]) => ({ name, size: data.length, digest: `sha256:${hash}` }));
    let directory;
    let uploads = 0;
    publishStableAssets({ assets }, 'v0.3.2', 'canvas-ui/canvas-desktop', args => {
        if (args[1] === 'download') {
            directory = args[args.indexOf('--dir') + 1];
            for (const asset of assets) writeFileSync(join(directory, asset.name), data);
        } else {
            assert.equal(args[1], 'upload');
            uploads++;
            for (const [original, alias] of pairs) {
                assert.ok(args.includes(join(directory, alias)));
                assert.ok(!args.includes(join(directory, original)));
                assert.deepEqual(readFileSync(join(directory, alias)), data);
            }
            const sums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8');
            for (const names of pairs) for (const name of names) assert.ok(sums.includes(`${hash}  ${name}\n`));
        }
    });
    assert.equal(uploads, 1);
    assert.equal(existsSync(directory), false);
});
test('corrupt downloads fail before uploading aliases', () => {
    let directory;
    const assets = pairs.map(([name]) => ({ name, size: 5, digest: `sha256:${'0'.repeat(64)}` }));
    assert.throws(() => publishStableAssets({ assets }, 'v0.3.2', 'canvas-ui/canvas-desktop', args => {
        assert.equal(args[1], 'download');
        directory = args[args.indexOf('--dir') + 1];
        for (const asset of assets) writeFileSync(join(directory, asset.name), 'wrong');
    }), /failed verification/);
    assert.equal(existsSync(directory), false);
});
test('every documented installer alias must be present before any network requests', () => {
    assert.throws(() => publishStableAssets({ assets: [{ name: pairs[0][0], size: 100 }] }, 'v0.3.2', 'canvas-ui/canvas-desktop', () => assert.fail('unexpected network request')), /missing stable installer/);
});
