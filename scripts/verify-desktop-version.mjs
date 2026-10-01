import { readFileSync } from 'node:fs';

const base = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, base), 'utf8');
const version = JSON.parse(read('package.json')).version;
const tauriVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version;
const cargoVersion = read('src-tauri/Cargo.toml').match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const lockVersion = read('src-tauri/Cargo.lock').match(/\[\[package\]\]\r?\nname = "canvas-desktop"\r?\nversion = "([^"]+)"/)?.[1];
for (const [source, actual] of [['Tauri config', tauriVersion], ['Cargo manifest', cargoVersion], ['Cargo lock', lockVersion]]) {
    if (actual !== version) throw new Error(`${source} version ${actual} differs from package.json ${version}`);
}
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} differs from v${version}`);
console.log(`Desktop versions agree: ${version}`);
