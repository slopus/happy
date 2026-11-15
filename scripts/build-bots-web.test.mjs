import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrateBotsAssets } from './build-bots-web.mjs';

test('release HTML pins its own immutable Bots assets across subsequent builds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paws-bots-release-'));
    const source = join(root, 'packages/paws-bots/apps/web/dist-embedded');
    const dist = join(root, 'packages/happy-app/dist');
    await mkdir(source, { recursive: true }); await mkdir(dist, { recursive: true });
    try {
        await writeFile(join(source, 'bots.js'), 'version one'); await writeFile(join(source, 'bots.css'), 'scoped css');
        await writeFile(join(dist, 'index.html'), '<html><head></head><body>Paws</body></html>');
        const first = integrateBotsAssets(root);
        const firstHtml = await readFile(join(dist, 'index.html'), 'utf8');
        assert.match(first.js, /^\/assets\/bots\/bots-[a-f0-9]{20}\.js$/);
        assert(firstHtml.includes(first.js)); assert(firstHtml.includes(first.css));
        await writeFile(join(source, 'bots.js'), 'version two');
        const second = integrateBotsAssets(root);
        const secondHtml = await readFile(join(dist, 'index.html'), 'utf8');
        assert.notEqual(second.js, first.js); assert.equal(second.css, first.css);
        assert.equal((secondHtml.match(/name="paws-bots-entry"/g) ?? []).length, 1);
        assert.equal(await readFile(join(dist, first.js), 'utf8'), 'version one');
        assert.equal(await readFile(join(dist, second.js), 'utf8'), 'version two');
        assert(firstHtml.includes(first.js)); assert(!firstHtml.includes(second.js));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Expo development avoids Metro reserved /assets and needs no release index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paws-bots-development-'));
    const source = join(root, 'packages/paws-bots/apps/web/dist-embedded');
    await mkdir(source, { recursive: true });
    try {
        await writeFile(join(source, 'bots.js'), 'test js'); await writeFile(join(source, 'bots.css'), 'test css');
        const files = integrateBotsAssets(root, true);
        assert(files.js.startsWith('/bots-assets/')); assert(files.css.startsWith('/bots-assets/'));
        const manifest = JSON.parse(await readFile(join(root, 'packages/happy-app/public/bots-assets/manifest.json'), 'utf8'));
        assert.deepEqual(manifest, files);
    } finally { await rm(root, { recursive: true, force: true }); }
});
