import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./inject-staging-dreamskin-preload.mjs', import.meta.url));

test('preloads the exact staged WebP before the app scripts', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'paws-skin-preload-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const skinDirectory = join(root, 'desktop-skins', 'dreamskin');
    await mkdir(skinDirectory, { recursive: true });
    const bytes = Buffer.from('photo');
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const name = `background.${hash}.webp`;
    await writeFile(join(skinDirectory, name), bytes);
    const index = join(root, 'index.html');
    await writeFile(index, '<html><head></head><body><script src="/app.js"></script></body></html>');
    const result = spawnSync(process.execPath, [script, index], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const html = await readFile(index, 'utf8');
    assert.match(html, new RegExp(`rel="preload" as="image" href="/desktop-skins/dreamskin/${name}" fetchpriority="high"`));
    assert.ok(html.indexOf(name) < html.indexOf('/app.js'));
});
