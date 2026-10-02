import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const installerGroups = [
    /(?:amd64|x64|x86_64)\.deb$/i,
    /(?:amd64|x64|x86_64)\.rpm$/i,
    /(?:amd64|x64|x86_64)\.AppImage$/i,
    /(?:aarch64|arm64)\.dmg$/i,
    /(?:x64|x86_64)\.dmg$/i,
    /\.msi$/i,
    /(?:-setup|_setup)\.exe$/i,
];
export function complete(release) {
    const assets = release?.assets || [];
    return installerGroups.every(pattern => assets.some(asset => pattern.test(asset.name) && asset.size > 0));
}
export function prepareRelease({ release, tag, sha }, gh) {
    if (release?.prerelease) throw new Error(`${tag} is a prerelease; refusing to overwrite it`);
    if (release && !release.isDraft && !release.draft && complete(release)) return null;
    let ref = sha;
    if (release) {
        ref = release.target_commitish;
        if (!/^[a-f0-9]{40}$/i.test(ref || '')) throw new Error(`${tag} has no immutable commit target; repair its target before resuming`);
        if (!release.draft && !release.isDraft) gh(['release', 'edit', tag, '--draft=true']);
    } else {
        gh(['release', 'create', tag, '--draft', '--target', sha, '--title', `Canvas Desktop ${tag}`,
            '--notes', 'Canvas Desktop installers for Linux, macOS (Intel and Apple Silicon), and Windows. Not code-signed yet.']);
    }
    return { tag, ref };
}
export function finalizeRelease(release, tag, gh) {
    if (!complete(release)) throw new Error(`${tag} is missing installers; keeping it in draft`);
    gh(['release', 'edit', tag, '--draft=false']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
    const tag = process.env.RELEASE_TAG || `v${version}`;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error('GITHUB_REPOSITORY required');
    const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    // A failed registry/API request must fail the job, not mean “release absent”.
    const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
    const release = releases.find(item => item.tag_name === tag);
    if (process.argv[2] === 'prepare') {
        const plan = prepareRelease({ release, tag, sha: process.env.GITHUB_SHA }, gh);
        if (plan) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${plan.tag}\nref=${plan.ref}\n`);
        else console.log(`${tag} is complete — nothing to do`);
    } else if (process.argv[2] === 'finalize') {
        if (!release) throw new Error(`${tag} release not found`);
        finalizeRelease(release, tag, gh);
    } else throw new Error('Usage: desktop-release.mjs prepare|finalize');
}
