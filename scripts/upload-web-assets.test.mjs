import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./upload-web-assets.sh', import.meta.url));
const revision = '1234567890abcdef1234567890abcdef12345678';

async function createFixture(marker = revision) {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-upload-'));
    const dist = join(directory, 'dist');
    const fakeBin = join(directory, 'bin');
    const logPath = join(directory, 'aliyun.log');
    await mkdir(join(dist, '_expo', 'static'), { recursive: true });
    await mkdir(join(dist, 'assets', 'fonts'), { recursive: true });
    await mkdir(join(dist, '.well-known'), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await Promise.all([
        writeFile(join(dist, 'index.html'), '<html></html>'),
        writeFile(join(dist, '.paws-release-revision'), `${marker}\n`),
        writeFile(join(dist, '_expo', 'static', 'app.js'), 'app'),
        writeFile(join(dist, 'assets', 'fonts', 'Ionicons.abc.ttf'), 'font'),
        writeFile(join(dist, 'canvaskit.wasm'), 'wasm'),
        writeFile(join(dist, 'favicon.ico'), 'icon'),
        writeFile(join(dist, 'metadata.json'), '{}'),
        writeFile(join(dist, '.well-known', 'apple-app-site-association'), '{}'),
        writeFile(join(dist, '.well-known', 'assetlinks.json'), '[]'),
    ]);
    const fakeAliyun = join(fakeBin, 'aliyun');
    await writeFile(fakeAliyun, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_ALIYUN_LOG"\nexit 0\n`);
    await chmod(fakeAliyun, 0o755);
    return { directory, dist, fakeBin, logPath };
}

async function runUpload(marker = revision) {
    const fixture = await createFixture(marker);
    try {
        const result = spawnSync('bash', [scriptPath, fixture.dist], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixture.fakeBin}:${process.env.PATH}`,
                FAKE_ALIYUN_LOG: fixture.logPath,
                PAWS_WEB_OSS_BUCKET: 'test-web-bucket',
            },
        });
        const log = await readFile(fixture.logPath, 'utf8').catch(() => '');
        return { ...result, log };
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
}

test('uploads a complete immutable release without inspecting object ACLs', async () => {
    const result = await runUpload();

    assert.equal(result.status, 0, result.stderr);
    const releaseUpload = `ossutil cp -r`;
    const releaseDestination = `oss://test-web-bucket/web/releases/${revision}/`;
    const releasePosition = result.log.indexOf(releaseUpload);
    const expoPosition = result.log.indexOf('oss://test-web-bucket/_expo/');
    assert.ok(releasePosition >= 0, result.log);
    assert.ok(result.log.includes(releaseDestination), result.log);
    assert.ok(expoPosition > releasePosition, result.log);
    assert.match(result.log, /oss:\/\/test-web-bucket\/_expo\/.*--cache-control public,max-age=31536000,immutable/);
    assert.match(result.log, /oss:\/\/test-web-bucket\/assets\/.*--cache-control public,max-age=31536000,immutable/);
    assert.match(result.log, /oss:\/\/test-web-bucket\/metadata\.json.*--cache-control no-cache/);
    assert.match(result.log, /oss:\/\/test-web-bucket\/\.well-known\/.*--cache-control no-cache/);
    assert.doesNotMatch(result.log, /ossutil stat/);
});

test('rejects an invalid release marker before invoking OSS', async () => {
    const result = await runUpload('main');

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /40-character lowercase Git SHA/);
    assert.equal(result.log, '');
});
