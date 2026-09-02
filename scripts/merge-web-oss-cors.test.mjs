import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeWebOssCors } from './merge-web-oss-cors.mjs';

const canonicalOrigin = 'https://47.115.228.20:8443';
const scriptPath = fileURLToPath(new URL('./merge-web-oss-cors.mjs', import.meta.url));

test('reuses an existing wildcard GET and HEAD rule without rewriting it', () => {
    const current = {
        CORSRule: {
            AllowedHeader: '*',
            AllowedMethod: ['GET', 'HEAD'],
            AllowedOrigin: '*',
            ExposeHeader: 'ETag',
            MaxAgeSeconds: '600',
        },
        ResponseVary: 'false',
    };

    const result = mergeWebOssCors(current, canonicalOrigin);

    assert.equal(result.changed, false);
    assert.deepEqual(result.configuration, current);
});

test('preserves unrelated rules and adds one narrowly scoped Web rule', () => {
    const privateUploadRule = {
        AllowedHeader: ['Content-Type'],
        AllowedMethod: ['PUT'],
        AllowedOrigin: ['https://uploader.example.com'],
        ExposeHeader: ['x-oss-request-id'],
        MaxAgeSeconds: 120,
    };
    const current = { CORSRule: [privateUploadRule], ResponseVary: true };

    const result = mergeWebOssCors(current, canonicalOrigin);

    assert.equal(result.changed, true);
    assert.deepEqual(result.configuration.CORSRule[0], privateUploadRule);
    assert.deepEqual(result.configuration.CORSRule[1], {
        AllowedOrigin: [canonicalOrigin],
        AllowedMethod: ['GET', 'HEAD'],
        AllowedHeader: '*',
        ExposeHeader: ['ETag'],
        MaxAgeSeconds: 600,
    });
    assert.equal(result.configuration.ResponseVary, true);
});

test('creates a valid configuration when no CORS rules exist', () => {
    const result = mergeWebOssCors({}, canonicalOrigin);

    assert.equal(result.changed, true);
    assert.deepEqual(result.configuration.CORSRule, {
        AllowedOrigin: [canonicalOrigin],
        AllowedMethod: ['GET', 'HEAD'],
        AllowedHeader: '*',
        ExposeHeader: ['ETag'],
        MaxAgeSeconds: 600,
    });
});

test('CLI writes the merged union and reports whether OSS must be updated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-cors-'));
    const inputPath = join(directory, 'current.json');
    const outputPath = join(directory, 'merged.json');
    await writeFile(inputPath, JSON.stringify({ CORSRule: { AllowedOrigin: '*', AllowedMethod: ['GET', 'HEAD'] } }));
    try {
        const result = spawnSync(process.execPath, [scriptPath, inputPath, outputPath, canonicalOrigin], { encoding: 'utf8' });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'unchanged\n');
        assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), {
            CORSRule: { AllowedOrigin: '*', AllowedMethod: ['GET', 'HEAD'] },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
