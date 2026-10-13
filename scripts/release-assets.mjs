import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep Tauri's original filenames (including updater bundles) intact.
export function stableAssetName(name) {
    if (!/^Canvas[._ ]Desktop[_-]/.test(name)) return null;
    if (/(?:amd64|x64|x86_64)\.deb$/i.test(name)) return 'canvas-desktop-linux-x86_64.deb';
    if (/(?:amd64|x64|x86_64)\.rpm$/i.test(name)) return 'canvas-desktop-linux-x86_64.rpm';
    if (/(?:amd64|x64|x86_64)\.AppImage$/i.test(name)) return 'canvas-desktop-linux-x86_64.AppImage';
    if (/(?:aarch64|arm64)\.dmg$/i.test(name)) return 'canvas-desktop-macos-aarch64.dmg';
    if (/(?:x64|x86_64)\.dmg$/i.test(name)) return 'canvas-desktop-macos-x86_64.dmg';
    if (/(?:aarch64|arm64)\.app\.tar\.gz$/i.test(name)) return 'canvas-desktop-macos-aarch64.app.tar.gz';
    if (/(?:x64|x86_64)\.app\.tar\.gz$/i.test(name)) return 'canvas-desktop-macos-x86_64.app.tar.gz';
    if (/(?:x64|x86_64)[_-]setup\.exe$/i.test(name)) return 'canvas-desktop-windows-x86_64-setup.exe';
    const msi = name.match(/(?:x64|x86_64)_([a-z]{2}-[a-z]{2})\.msi$/i);
    if (msi) return `canvas-desktop-windows-x86_64-${msi[1]}.msi`;
    return null;
}

export function stableAssetPlan(assets) {
    const aliases = new Set();
    return assets.flatMap(asset => {
        const name = stableAssetName(asset.name);
        if (!name) return [];
        if (/[\/\\\r\n]/.test(asset.name) || asset.size <= 0) throw new Error(`Invalid installer: ${asset.name}`);
        if (aliases.has(name)) throw new Error(`Multiple installers map to ${name}`);
        aliases.add(name);
        return [{ asset, name }];
    });
}

export function publishStableAssets(release, tag, repository, gh) {
    const plan = stableAssetPlan(release.assets || []);
    const required = [
        'canvas-desktop-linux-x86_64.deb',
        'canvas-desktop-linux-x86_64.rpm',
        'canvas-desktop-linux-x86_64.AppImage',
        'canvas-desktop-macos-aarch64.dmg',
        'canvas-desktop-macos-x86_64.dmg',
        'canvas-desktop-windows-x86_64-setup.exe',
        'canvas-desktop-windows-x86_64-en-US.msi',
    ];
    for (const name of required) {
        if (!plan.some(alias => alias.name === name)) throw new Error(`${tag} is missing stable installer ${name}`);
    }
    const directory = mkdtempSync(join(tmpdir(), 'canvas-desktop-release-'));
    try {
        gh(['release', 'download', tag, '--repo', repository, '--dir', directory,
            ...plan.flatMap(({ asset }) => ['--pattern', asset.name])]);
        const checksums = [];
        for (const { asset, name } of plan) {
            const source = join(directory, asset.name);
            const data = readFileSync(source);
            const hash = createHash('sha256').update(data).digest('hex');
            if (data.length !== asset.size || (asset.digest && asset.digest !== `sha256:${hash}`)) {
                throw new Error(`Downloaded installer failed verification: ${asset.name}`);
            }
            copyFileSync(source, join(directory, name));
            checksums.push(`${hash}  ${asset.name}`, `${hash}  ${name}`);
        }
        const manifest = join(directory, 'SHA256SUMS');
        writeFileSync(manifest, `${checksums.sort().join('\n')}\n`);
        gh(['release', 'upload', tag, '--repo', repository, '--clobber',
            ...plan.map(({ name }) => join(directory, name)), manifest]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
