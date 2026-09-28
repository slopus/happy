import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./upload-web-assets.sh', import.meta.url));
const revision = '1234567890abcdef1234567890abcdef12345678';

async function createFixture(marker = revision, skinName = 'background.55c64d0fcd6f9d5f.webp') {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-upload-'));
    const dist = join(directory, 'dist');
    const fakeBin = join(directory, 'bin');
    const logPath = join(directory, 'aliyun.log');
    const statePath = join(directory, 'oss.json');
    await mkdir(join(dist, '_expo', 'static'), { recursive: true });
    await mkdir(join(dist, 'assets', 'fonts'), { recursive: true });
    await mkdir(join(dist, 'desktop-skins', 'dreamskin'), { recursive: true });
    await mkdir(join(dist, 'desktop-skins', 'warm-night'), { recursive: true });
    await mkdir(join(dist, '.well-known'), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await Promise.all([
        writeFile(join(dist, 'index.html'), '<html></html>'),
        writeFile(join(dist, '.paws-release-revision'), `${marker}\n`),
        writeFile(join(dist, '_expo', 'static', 'app.js'), 'app'),
        writeFile(join(dist, 'assets', 'fonts', 'Ionicons.abc.ttf'), 'font'),
        writeFile(join(dist, 'desktop-skins', 'dreamskin', skinName), 'photo'),
        writeFile(join(dist, 'desktop-skins', 'warm-night', 'background.55c64d0fcd6f9d5f.webp'), 'photo'),
        writeFile(join(dist, 'canvaskit.wasm'), 'wasm'),
        writeFile(join(dist, 'favicon.ico'), 'icon'),
        writeFile(join(dist, 'metadata.json'), '{}'),
        writeFile(join(dist, '.well-known', 'apple-app-site-association'), '{}'),
        writeFile(join(dist, '.well-known', 'assetlinks.json'), '[]'),
        writeFile(statePath, '{}'),
    ]);
    const fakeAliyun = join(fakeBin, 'aliyun');
    await copyFile(fileURLToPath(new URL('./test-helpers/fake-aliyun.cjs', import.meta.url)), fakeAliyun);
    await chmod(fakeAliyun, 0o755);
    return { directory, dist, fakeBin, logPath, statePath };
}

async function runUpload(fixture, extraEnv = {}) {
    const result = spawnSync('bash', [scriptPath, fixture.dist], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fixture.fakeBin}:${process.env.PATH}`,
            FAKE_ALIYUN_LOG: fixture.logPath, FAKE_OSS_STATE: fixture.statePath,
            PAWS_WEB_OSS_BUCKET: 'test-web-bucket', ...extraEnv },
    });
    return { ...result, log: await readFile(fixture.logPath, 'utf8').catch(() => '') };
}

test('uploads immutable release once, then copies live assets inside OSS', async () => {
    const fixture = await createFixture();
    try {
        const result = await runUpload(fixture);
        assert.equal(result.status, 0, result.stderr);
        const releasePrefix = `web/releases/${revision}/`;
        const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        assert.ok(state[`${releasePrefix}index.html`]);
        assert.deepEqual(state['_expo/static/app.js'], state[`${releasePrefix}_expo/static/app.js`]);
        assert.deepEqual(state['assets/fonts/Ionicons.abc.ttf'], state[`${releasePrefix}assets/fonts/Ionicons.abc.ttf`]);
        assert.equal(state['desktop-skins/dreamskin/background.55c64d0fcd6f9d5f.webp'].cacheControl, 'public,max-age=31536000,immutable');
        assert.equal(state['desktop-skins/dreamskin/background.55c64d0fcd6f9d5f.webp'].contentType, 'image/webp');
        assert.equal(state['desktop-skins/warm-night/background.55c64d0fcd6f9d5f.webp'].cacheControl, 'public,max-age=31536000,immutable');
        assert.equal(state['desktop-skins/warm-night/background.55c64d0fcd6f9d5f.webp'].contentType, 'image/webp');
        assert.equal(state['canvaskit.wasm'].md5, state[`${releasePrefix}canvaskit.wasm`].md5);
        assert.equal(state['canvaskit.wasm'].cacheControl, 'no-cache');
        assert.equal(state['canvaskit.wasm'].contentType, 'application/wasm');
        assert.match(result.log, /ossutil cp -r .*web\/releases\/.*--checksum/);
        assert.match(result.log, /canvaskit\.wasm.*--copy-props none.*--content-type application\/wasm/);
        assert.match(result.log, /ossutil set-props .*canvaskit\.wasm.*--cache-control no-cache.*--metadata-directive update/);
        assert.match(result.log, /metadata\.json.*--cache-control no-cache/);
        assert.match(result.log, /\.well-known\/.*--cache-control no-cache/);
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('retry reuses an already verified immutable release', async () => {
    const fixture = await createFixture();
    try {
        const first = await runUpload(fixture);
        assert.equal(first.status, 0, first.stderr);
        await writeFile(fixture.logPath, '');
        const retry = await runUpload(fixture);
        assert.equal(retry.status, 0, retry.stderr);
        assert.match(retry.stdout, /0 uploaded/);
        assert.doesNotMatch(retry.log, /ossutil cp -r \/tmp\/paws-oss-upload-/);
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('retry uploads only files missing after an interrupted batch', async () => {
    const fixture = await createFixture();
    try {
        const interrupted = await runUpload(fixture, { FAKE_FAIL_AFTER: '2' });
        assert.notEqual(interrupted.status, 0);
        const partial = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        assert.equal(Object.keys(partial).length, 2);
        const retry = await runUpload(fixture);
        assert.equal(retry.status, 0, retry.stderr);
        assert.match(retry.stdout, /2 reused/);
        const completed = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        assert.ok(completed[`web/releases/${revision}/index.html`]);
        assert.ok(completed['_expo/static/app.js']);
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('checks every page when an immutable release has more than 1000 objects', async () => {
    const fixture = await createFixture();
    try {
        const state = {};
        for (let index = 0; index < 1001; index++) {
            state[`web/releases/${revision}/extra-${String(index).padStart(4, '0')}`] = {
                size: 1, md5: '0'.repeat(32),
            };
        }
        await writeFile(fixture.statePath, JSON.stringify(state));
        const result = await runUpload(fixture);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.log, /--continuation-token 1000/);
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('rejects a different object under the same immutable revision', async () => {
    const fixture = await createFixture();
    try {
        assert.equal((await runUpload(fixture)).status, 0);
        const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        state[`web/releases/${revision}/index.html`].md5 = '0'.repeat(32);
        await writeFile(fixture.statePath, JSON.stringify(state));
        const retry = await runUpload(fixture);
        assert.notEqual(retry.status, 0);
        assert.match(retry.stderr, /Immutable OSS object differs/);
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('rejects an invalid release marker before invoking OSS', async () => {
    const fixture = await createFixture('main');
    try {
        const result = await runUpload(fixture);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /40-character lowercase Git SHA/);
        assert.equal(result.log, '');
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('rejects a stale DreamSkin hash before invoking OSS', async () => {
    const fixture = await createFixture(revision, 'background.0000000000000000.webp');
    try {
        const result = await runUpload(fixture);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /SHA-256 不一致/);
        assert.equal(result.log, '');
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('rejects a missing second desktop skin before invoking OSS', async () => {
    const fixture = await createFixture();
    try {
        await rm(join(fixture.dist, 'desktop-skins', 'warm-night'), { recursive: true, force: true });
        const result = await runUpload(fixture);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /背景资源数量不正确/);
        assert.equal(result.log, '');
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});
