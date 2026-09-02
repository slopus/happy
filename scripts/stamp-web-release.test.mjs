import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./stamp-web-release.mjs', import.meta.url));
const revision = '1234567890abcdef1234567890abcdef12345678';

async function withFixture(run) {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-stamp-'));
    const indexPath = join(directory, 'index.html');
    const markerPath = join(directory, '.paws-release-revision');
    await writeFile(indexPath, '<!doctype html><html><head><title>Paws</title></head><body></body></html>');
    try {
        await run({ directory, indexPath, markerPath });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('stamps the same validated revision into HTML and the marker', async () => {
    await withFixture(async ({ indexPath, markerPath }) => {
        const result = spawnSync(process.execPath, [scriptPath, indexPath, markerPath, revision], { encoding: 'utf8' });

        assert.equal(result.status, 0, result.stderr);
        const html = await readFile(indexPath, 'utf8');
        assert.match(html, new RegExp(`<meta name="paws-release-revision" content="${revision}">`));
        assert.ok(html.indexOf('paws-release-revision') < html.indexOf('</head>'));
        assert.equal(await readFile(markerPath, 'utf8'), `${revision}\n`);
    });
});

test('is idempotent and keeps exactly one managed revision meta tag', async () => {
    await withFixture(async ({ indexPath, markerPath }) => {
        for (let run = 0; run < 2; run += 1) {
            const result = spawnSync(process.execPath, [scriptPath, indexPath, markerPath, revision], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }

        const html = await readFile(indexPath, 'utf8');
        assert.equal(html.match(/name="paws-release-revision"/g)?.length, 1);
    });
});

test('rejects a malformed revision without changing either artifact', async () => {
    await withFixture(async ({ indexPath, markerPath }) => {
        const before = await readFile(indexPath, 'utf8');
        const result = spawnSync(process.execPath, [scriptPath, indexPath, markerPath, 'main'], { encoding: 'utf8' });

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /40-character lowercase Git SHA/);
        assert.equal(await readFile(indexPath, 'utf8'), before);
        await assert.rejects(readFile(markerPath, 'utf8'), /ENOENT/);
    });
});
