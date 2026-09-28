import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./write-staging-web-checksums.mjs', import.meta.url));

test('checksums every extracted release file with stable relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paws-staging-checksums-'));
    try {
        await mkdir(join(root, '_expo'));
        await writeFile(join(root, 'index.html'), 'html');
        await writeFile(join(root, '_expo', 'app.js'), 'js');
        const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const manifest = await readFile(join(root, '.paws-staging-checksums.sha256'), 'utf8');
        assert.match(manifest, /  \.\/_expo\/app\.js/);
        assert.match(manifest, /  \.\/index\.html/);
        assert.equal(manifest.trim().split('\n').length, 2);
        assert.equal(spawnSync('shasum', ['-a', '256', '-c', '.paws-staging-checksums.sha256'], { cwd: root }).status, 0);
        await writeFile(join(root, '_expo', 'app.js'), 'corrupted');
        assert.notEqual(spawnSync('shasum', ['-a', '256', '-c', '.paws-staging-checksums.sha256'], { cwd: root }).status, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});
