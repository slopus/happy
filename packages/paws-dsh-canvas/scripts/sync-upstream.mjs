import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repository = 'shanliuling/dsh-image-gen';
const pinnedCommit = '651190e1bafc784f7e0e49a38358dd50d0f5044b';
const compatibleTldraw = '5.3.0';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(packageRoot, 'vendor');
const upstreamFolder = 'dsh-image-gen';
const rendererFolder = 'src/client/tl';
const upstreamNotices = ['NOTICE', 'NOTICE.md', 'NOTICE.txt'];
const requiredRendererFiles = [
    'canvas-selection.ts',
    'canvas-sync.ts',
    'css-supports-shim.ts',
    'gallery-image-transfer.ts',
    'studio-tl-canvas.tsx',
    'tl-brand-theme.ts',
    'tl-brand-tokens.ts',
    'tl-canvas-bridge.ts',
    'tl-css.ts',
    'tl-theme-css.ts',
].map(file => `${rendererFolder}/${file}`).sort();
const requiredFiles = [
    'LICENSE',
    'package.json',
    'src/client/browser-image-utils.ts',
    'src/client/image-cache.ts',
    'src/shared.ts',
    ...requiredRendererFiles,
].sort();

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const version = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const maximumArchiveBytes = 64 * 1024 * 1024;
const maximumTarOutputBytes = 4 * 1024 * 1024;
const maximumRendererFiles = 32;
const maximumSourceFileBytes = 512 * 1024;
const rendererPrefix = `${rendererFolder}/`;
const rendererFileName = /^[a-z0-9][a-z0-9-]{0,99}\.tsx?$/;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function equalList(actual, expected, subject) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${subject} changed. Review the source list before syncing.\nExpected: ${expected.join(', ')}\nFound: ${actual.join(', ')}`);
}

function validateSourceList(paths) {
    assert(paths.every(path => typeof path === 'string'), 'Invalid upstream source path');
    const unique = new Set(paths);
    assert(unique.size === paths.length, 'Upstream source list contains duplicate paths');
    const missing = requiredFiles.filter(path => !unique.has(path));
    assert(missing.length === 0, `Required upstream files are missing: ${missing.join(', ')}`);
    const rendererPaths = paths.filter(path => path.startsWith(rendererPrefix));
    assert(rendererPaths.length <= maximumRendererFiles, `The upstream renderer has more than ${maximumRendererFiles} files`);
    for (const path of paths) {
        const rendererSource = path.startsWith(rendererPrefix) && rendererFileName.test(path.slice(rendererPrefix.length));
        assert(requiredFiles.includes(path) || upstreamNotices.includes(path) || rendererSource, `Upstream source is outside the allowed paths: ${path}`);
    }
    return [...unique].sort();
}

function validateSourceSizes(entries) {
    let total = 0;
    for (const entry of entries) {
        assert(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= maximumSourceFileBytes, `Invalid upstream source size: ${entry.path}`);
        total += entry.bytes;
    }
    assert(total <= maximumTarOutputBytes, 'Allowlisted upstream sources exceed the total byte limit');
}

function hashes(bytes) {
    return {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        gitBlob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    };
}

function attribution(lock) {
    return `Paws source attribution\n\nDSH Image Gen ${lock.version}\nhttps://github.com/${repository}/tree/${lock.commit}\nCommit: ${lock.commit}\n\nThe files in ${upstreamFolder}/ are unmodified copies of selected upstream files.\nSee ${upstreamFolder}/LICENSE for their Apache-2.0 license and retained notices.\nPaws integration code and third-party dependencies have their own terms.\n`;
}

async function regularFiles(directory, prefix = '') {
    assert((await lstat(directory)).isDirectory(), `Expected a directory at ${directory}`);
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) files.push(...await regularFiles(join(directory, entry.name), `${relative}/`));
        else {
            assert(entry.isFile(), `Vendor contains a non-regular file: ${relative}`);
            files.push(relative);
        }
    }
    return files.sort();
}

async function checkVendor(directory) {
    const files = await regularFiles(directory);
    assert(files.includes('upstream.json'), 'Vendor is missing upstream.json');
    const lockSource = await readFile(join(directory, 'upstream.json'), 'utf8');
    const lock = JSON.parse(lockSource);
    assert(lock.schemaVersion === 1 && lock.repository === repository && SHA1.test(lock.commit) && SHA1.test(lock.tree) && version.test(lock.version) && Array.isArray(lock.files), 'Invalid upstream lock');
    const manifestFiles = lock.files.map(entry => entry.path);
    const allowedFiles = validateSourceList(manifestFiles);
    equalList(manifestFiles, allowedFiles, 'Locked source list');
    equalList(files, ['NOTICE', 'upstream.json', ...allowedFiles.map(file => `${upstreamFolder}/${file}`)].sort(), 'Vendor files');
    assert(lockSource === `${JSON.stringify(lock, null, 2)}\n`, 'Upstream lock formatting has drifted');
    validateSourceSizes(lock.files);

    const sourceRoot = join(directory, upstreamFolder);
    for (const entry of lock.files) {
        assert(SHA256.test(entry.sha256) && SHA1.test(entry.gitBlob), `Invalid locked fingerprint: ${entry.path}`);
        const actual = hashes(await readFile(join(sourceRoot, entry.path)));
        assert(actual.bytes === entry.bytes && actual.sha256 === entry.sha256 && actual.gitBlob === entry.gitBlob, `Vendored original has drifted: ${entry.path}`);
    }
    assert(await readFile(join(directory, 'NOTICE'), 'utf8') === attribution(lock), 'Paws source attribution has drifted');

    const metadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    assert(metadata.name === upstreamFolder && metadata.version === lock.version && metadata.license === 'Apache-2.0', 'Upstream package identity or license changed');
    assert((metadata.dependencies?.tldraw ?? metadata.devDependencies?.tldraw) === compatibleTldraw, `Upstream tldraw version changed from ${compatibleTldraw}. Review renderer compatibility before activating it.`);
    assert((await readFile(join(sourceRoot, 'LICENSE'), 'utf8')).includes('Apache License'), 'Expected the upstream Apache license text');
    const renderer = await readFile(join(sourceRoot, rendererFolder, 'studio-tl-canvas.tsx'), 'utf8');
    assert(/\bexport\s+const\s+StudioTlCanvas\b/.test(renderer) && /from ['"]tldraw['"]/.test(renderer), 'Upstream renderer entry point changed. Review the Paws imports.');
    for (const dependency of ['../browser-image-utils.js', '../image-cache.js', '../../shared.js', './canvas-sync.js', './gallery-image-transfer.js', './tl-canvas-bridge.js']) {
        assert(renderer.includes(`'${dependency}'`) || renderer.includes(`"${dependency}"`), `Upstream renderer no longer imports ${dependency}. Review the Paws integration.`);
    }
    return lock;
}

async function github(path) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `GitHub could not read ${path}: HTTP ${response.status}`);
    return response.json();
}

async function resolveCommit(ref) {
    let sha = ref;
    if (!SHA1.test(ref)) {
        const tag = await github(`git/ref/tags/${encodeURIComponent(ref)}`);
        assert(tag.ref === `refs/tags/${ref}`, `GitHub did not return the exact tag ${ref}`);
        let pointer = tag.object;
        for (let depth = 0; pointer?.type === 'tag' && depth < 4; depth++) {
            assert(SHA1.test(pointer.sha), 'Invalid annotated tag SHA');
            const record = await github(`git/tags/${pointer.sha}`);
            assert(record.sha === pointer.sha, 'GitHub returned a different annotated tag');
            pointer = record.object;
        }
        assert(pointer?.type === 'commit' && SHA1.test(pointer.sha), `Tag ${ref} does not resolve to a commit`);
        sha = pointer.sha;
    }
    const record = await github(`git/commits/${sha}`);
    assert(record.sha === sha && SHA1.test(record.tree?.sha), 'GitHub returned a different commit or invalid tree');
    return { commit: sha, tree: record.tree.sha };
}

function archiveCommand(args) {
    const result = spawnSync('tar', args, { maxBuffer: maximumTarOutputBytes });
    if (result.error) throw result.error;
    assert(result.status === 0, `Could not read the GitHub archive: ${result.stderr.toString().trim()}`);
    return result.stdout;
}

async function downloadArchive(commit, destination) {
    const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${commit}`, { signal: AbortSignal.timeout(90_000) });
    assert(response.ok && response.body, `Could not download the GitHub archive: HTTP ${response.status}`);
    let size = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(size > maximumArchiveBytes ? new Error('Upstream archive exceeds the download limit') : null, chunk);
        },
    }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

async function stageVendor(ref, staging) {
    const { commit, tree } = await resolveCommit(ref);
    const remote = await github(`git/trees/${tree}?recursive=1`);
    assert(remote.sha === tree && remote.truncated === false && Array.isArray(remote.tree), 'GitHub did not return the complete pinned source tree');
    const fileNames = validateSourceList(remote.tree
        .filter(entry => entry.path.startsWith(rendererPrefix) || requiredFiles.includes(entry.path) || upstreamNotices.includes(entry.path))
        .map(entry => entry.path));
    const selectedEntries = new Map(fileNames.map(path => {
        const entry = remote.tree.find(candidate => candidate.path === path);
        assert(entry?.type === 'blob' && entry.mode === '100644' && SHA1.test(entry.sha), `Expected a regular upstream file: ${path}`);
        return [path, entry];
    }));
    validateSourceSizes([...selectedEntries.values()].map(entry => ({ path: entry.path, bytes: entry.size })));

    const archive = join(staging, 'upstream.tar.gz');
    await downloadArchive(commit, archive);
    const prefix = `${upstreamFolder}-${commit}/`;
    const wanted = new Set(fileNames.map(path => `${prefix}${path}`));
    const entriesInArchiveOrder = archiveCommand(['-tf', archive]).toString('utf8').split('\n').filter(path => wanted.has(path));
    equalList([...entriesInArchiveOrder].sort(), [...wanted].sort(), 'Allowlisted archive entries');
    // Only read explicit file contents to stdout. The archive never writes to disk directly.
    const concatenated = archiveCommand(['-xOf', archive, '--', ...entriesInArchiveOrder]);
    const candidate = join(staging, 'vendor');
    const fingerprints = new Map();
    let offset = 0;
    for (const entryPath of entriesInArchiveOrder) {
        const path = entryPath.slice(prefix.length);
        const entry = selectedEntries.get(path);
        const content = concatenated.subarray(offset, offset + entry.size);
        const fingerprint = hashes(content);
        assert(fingerprint.bytes === entry.size && fingerprint.gitBlob === entry.sha, `GitHub archive differs from the pinned Git blob: ${path}`);
        offset += entry.size;
        const destination = join(candidate, upstreamFolder, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, { flag: 'wx' });
        fingerprints.set(path, { path, ...fingerprint });
    }
    assert(offset === concatenated.length, 'GitHub archive returned bytes outside the file boundaries');
    const metadata = JSON.parse(await readFile(join(candidate, upstreamFolder, 'package.json'), 'utf8'));
    const lock = { schemaVersion: 1, repository, version: metadata.version, commit, tree, files: fileNames.map(path => fingerprints.get(path)) };
    await writeFile(join(candidate, 'upstream.json'), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
    await writeFile(join(candidate, 'NOTICE'), attribution(lock), { flag: 'wx' });
    return { candidate, lock: await checkVendor(candidate) };
}

async function exists(path) {
    try { await lstat(path); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function activate(candidate, previous) {
    const backup = join(packageRoot, '.dsh-canvas-vendor-backup');
    assert(!await exists(backup), `A previous vendor backup needs attention: ${backup}`);
    if (previous) await rename(vendor, backup);
    try { await rename(candidate, vendor); }
    catch (error) {
        if (previous) await rename(backup, vendor).catch(restoreError => {
            throw new AggregateError([error, restoreError], `Could not restore the old vendor directory. Its backup is at ${backup}.`);
        });
        throw error;
    }
    if (previous) await rm(backup, { recursive: true });
}

async function main(args) {
    if (args.length === 0 || (args.length === 1 && args[0] === '--check')) {
        const current = await checkVendor(vendor);
        console.log(`Verified ${current.files.length} DSH Image Gen ${current.version} originals at ${current.commit}.`);
        return;
    }
    if (args.length === 1 && args[0] === '--help') {
        console.log('Usage: node scripts/sync-upstream.mjs [--check | [--preview] --ref <GitHub tag or full SHA> | --preview]');
        return;
    }
    const preview = args[0] === '--preview';
    const source = preview ? args.slice(1) : args;
    const ref = preview && source.length === 0 ? pinnedCommit : source[1];
    assert((preview && !source.length) || (source.length === 2 && source[0] === '--ref' && typeof ref === 'string' && /^v?[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/.test(ref)), 'Expected --check, --preview, or --ref <GitHub tag or full SHA>');

    const lockDirectory = join(packageRoot, '.dsh-canvas-sync-lock');
    await mkdir(lockDirectory);
    try {
        const previous = await exists(vendor) ? await checkVendor(vendor) : null;
        const staging = await mkdtemp(join(lockDirectory, 'stage-'));
        const { candidate, lock: next } = await stageVendor(ref, staging);
        const unchanged = previous && JSON.stringify(previous) === JSON.stringify(next);
        if (!preview && !unchanged) await activate(candidate, previous);
        const action = unchanged ? 'Verified unchanged' : preview ? 'Verified candidate' : 'Activated';
        console.log(`${action}: DSH Image Gen ${next.version} (${next.commit}), ${next.files.length} original files.`);
    } finally {
        await rm(lockDirectory, { recursive: true });
    }
}

main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
