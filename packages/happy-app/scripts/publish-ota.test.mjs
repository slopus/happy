import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./publish-ota.js', import.meta.url));
const fakeAliyun = fileURLToPath(new URL('../../../scripts/test-helpers/fake-aliyun.cjs', import.meta.url));

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'paws-ota-upload-'));
    const dist = join(directory, 'dist');
    const bin = join(directory, 'aliyun');
    const statePath = join(directory, 'oss.json');
    const logPath = join(directory, 'aliyun.log');
    const outputPath = join(directory, 'github-output');
    await mkdir(join(dist, 'bundles'), { recursive: true });
    await mkdir(join(dist, 'assets'), { recursive: true });
    await Promise.all([
        writeFile(join(dist, 'bundles', 'main.js'), 'the same Android bundle'),
        writeFile(join(dist, 'assets', 'logo'), 'image bytes'),
        writeFile(join(dist, 'assets', 'logo-copy'), 'image bytes'),
        writeFile(join(dist, 'metadata.json'), JSON.stringify({ fileMetadata: { android: {
            bundle: 'bundles/main.js',
            assets: [
                { path: 'assets/logo', ext: 'png' },
                { path: 'assets/logo-copy', ext: 'png' },
            ],
        } } })),
        writeFile(statePath, '{}'), writeFile(outputPath, ''),
        copyFile(fakeAliyun, bin),
    ]);
    await chmod(bin, 0o755);
    return { directory, dist, bin, statePath, logPath, outputPath };
}

function publish(f, variant, extraEnv = {}) {
    return spawnSync(process.execPath, [script, '--variant', variant, '--channel', variant,
        '--platform', 'android', ...(variant === 'preview' ? ['--skip-latest'] : [])], {
        encoding: 'utf8',
        env: { ...process.env, APP_ENV: variant, ALIYUN_BIN: f.bin, OTA_DIST_DIR: f.dist,
            FAKE_OSS_STATE: f.statePath, FAKE_ALIYUN_LOG: f.logPath,
            GITHUB_OUTPUT: f.outputPath, GITHUB_EVENT_PATH: '',
            OTA_DISPLAY_TITLE: 'Upload reuse test', ...extraEnv },
    });
}

test('preview and production manifests reuse one uploaded bundle and one deduplicated asset', async () => {
    const f = await fixture();
    try {
        const preview = publish(f, 'preview');
        assert.equal(preview.status, 0, preview.stderr);
        const production = publish(f, 'production');
        assert.equal(production.status, 0, production.stderr);
        const state = JSON.parse(await readFile(f.statePath, 'utf8'));
        const shared = Object.keys(state).filter((key) => key.startsWith('updates/android/shared/'));
        assert.equal(shared.length, 2, shared.join('\n'));
        const previewKey = Object.keys(state).find((key) => key.startsWith('manifests/android/23/preview/') && !key.endsWith('latest.json'));
        const productionKey = Object.keys(state).find((key) => key.startsWith('manifests/android/24/production/') && !key.endsWith('latest.json'));
        const previewManifest = JSON.parse(state[previewKey].text);
        const productionManifest = JSON.parse(state[productionKey].text);
        assert.equal(previewManifest.runtimeVersion, '23');
        assert.equal(productionManifest.runtimeVersion, '24');
        assert.equal(previewManifest.launchAsset.url, productionManifest.launchAsset.url);
        assert.equal(previewManifest.assets[0].url, previewManifest.assets[1].url);
        assert.equal(previewManifest.assets[0].url, productionManifest.assets[0].url);
        const log = await readFile(f.logPath, 'utf8');
        assert.equal((log.match(/ossutil cp -r /g) || []).length, 2, log);
        assert.ok(log.indexOf('meta/android/24/production/') < log.indexOf('manifests/android/24/production/latest.json'));
        assert.match(production.stdout, /0 uploaded/);
    } finally {
        await rm(f.directory, { recursive: true, force: true });
    }
});

test('keeps production latest unchanged if version metadata upload fails', async () => {
    const f = await fixture();
    try {
        const result = publish(f, 'production', { FAKE_FAIL_DEST_PREFIX: 'meta/android/24/production/' });
        assert.notEqual(result.status, 0);
        const state = JSON.parse(await readFile(f.statePath, 'utf8'));
        assert.ok(Object.keys(state).some((key) => key.startsWith('manifests/android/24/production/') && !key.endsWith('latest.json')));
        assert.ok(!state['manifests/android/24/production/latest.json']);
    } finally {
        await rm(f.directory, { recursive: true, force: true });
    }
});

test('does not publish a manifest when a shared hash key has conflicting bytes', async () => {
    const f = await fixture();
    try {
        assert.equal(publish(f, 'preview').status, 0);
        const state = JSON.parse(await readFile(f.statePath, 'utf8'));
        const assetKey = Object.keys(state).find((key) => key.startsWith('updates/android/shared/assets/'));
        state[assetKey].md5 = '0'.repeat(32);
        await writeFile(f.statePath, JSON.stringify(state));
        const production = publish(f, 'production');
        assert.notEqual(production.status, 0);
        assert.match(production.stderr, /Immutable OSS object differs/);
        const nextState = JSON.parse(await readFile(f.statePath, 'utf8'));
        assert.ok(!Object.keys(nextState).some((key) => key.startsWith('manifests/android/24/production/')));
    } finally {
        await rm(f.directory, { recursive: true, force: true });
    }
});
