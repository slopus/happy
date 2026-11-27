import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: [fileURLToPath(new URL('../protocol.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node' });
const { readProjectCanvasSync } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const failure = { id: `asset-${'a'.repeat(64)}`, versionId: 'b'.repeat(64) };
const sync = { type: 'paws-project-canvas/sync', sessionKey: 'board', theme: 'light', assets: [] };

test('preview failures are optional, version-scoped and bounded protocol state', () => {
    assert.deepEqual(readProjectCanvasSync(sync, 'https://paws.test'), sync);
    const withFailures = { ...sync, previewRequestFailures: [failure] };
    assert.deepEqual(readProjectCanvasSync(withFailures, 'https://paws.test'), withFailures);
    const uniqueFailures = Array.from({ length: 161 }, (_, i) => ({ ...failure, id: `asset-${i.toString(16).padStart(64, '0')}` }));
    const maximum = { ...sync, previewRequestFailures: uniqueFailures.slice(0, 160) };
    assert.deepEqual(readProjectCanvasSync(maximum, 'https://paws.test'), maximum);
    for (const previewRequestFailures of [null, {}, [null], [{ id: failure.id }], [{ ...failure, versionId: 'bad' }],
        [{ ...failure, id: 'untrusted-id' }], [failure, failure], uniqueFailures]) {
        assert.equal(readProjectCanvasSync({ ...sync, previewRequestFailures }, 'https://paws.test'), undefined,
            'malformed or unbounded failure state must not enter the renderer');
    }
    const versions = { ...sync, previewRequestFailures: [failure, { ...failure, versionId: 'c'.repeat(64) }] };
    assert.deepEqual(readProjectCanvasSync(versions, 'https://paws.test'), versions);
});
