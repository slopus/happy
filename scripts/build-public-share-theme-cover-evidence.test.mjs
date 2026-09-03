import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceScript = resolve(repositoryRoot, 'scripts/build-public-share-theme-cover-evidence.mjs');

async function writePng(path, width, height, color) {
    await sharp({
        create: {
            background: color,
            channels: 4,
            height,
            width,
        },
    }).png().toFile(path);
}

async function createFixture() {
    const root = await mkdtemp(resolve(repositoryRoot, '.public-share-evidence-test-'));
    const scriptsRoot = resolve(root, 'scripts');
    const evidenceRoot = resolve(root, 'docs/pr-evidence/public-share-theme-cover');
    const beforeRoot = resolve(evidenceRoot, 'raw/before');
    const currentRoot = resolve(evidenceRoot, 'raw/current');
    await mkdir(scriptsRoot, { recursive: true });
    await mkdir(beforeRoot, { recursive: true });
    await mkdir(resolve(currentRoot, 'supplemental'), { recursive: true });
    await copyFile(sourceScript, resolve(scriptsRoot, 'build-public-share-theme-cover-evidence.mjs'));

    await Promise.all([
        writePng(resolve(beforeRoot, 'case-1-share-dialog-before.png'), 1440, 900, '#111111'),
        writePng(resolve(beforeRoot, 'anonymous-read-only-share-before.png'), 1440, 900, '#222222'),
        writePng(resolve(beforeRoot, 'case-4-copy-before.png'), 900, 240, '#333333'),
        writePng(resolve(currentRoot, 'case-1-share-dialog-after.png'), 1440, 900, '#444444'),
        writePng(resolve(currentRoot, 'case-2-public-cover-after.png'), 1440, 900, '#555555'),
        writePng(resolve(currentRoot, 'case-3-no-cover-after.png'), 1440, 900, '#666666'),
        writePng(resolve(currentRoot, 'case-4-gingham-dark-after.png'), 1440, 900, '#777777'),
        writePng(resolve(currentRoot, 'supplemental/case-3-no-cover-390x844.png'), 390, 844, '#888888'),
    ]);
    return { evidenceRoot, root };
}

async function runScript(root, mode) {
    return execFileAsync(process.execPath, [resolve(root, 'scripts/build-public-share-theme-cover-evidence.mjs'), mode], {
        cwd: root,
    });
}

test('verify compares generated evidence without modifying committed artifacts or manifest', { timeout: 120_000 }, async () => {
    const fixture = await createFixture();
    try {
        await runScript(fixture.root, '--refresh-manifest');
        await writePng(
            resolve(fixture.evidenceRoot, 'raw/current/case-1-share-dialog-after.png'),
            1440,
            900,
            '#999999',
        );
        const trackedFiles = [
            'case-1-share-dialog-before.png',
            'case-1-share-dialog-after.png',
            'case-2-public-cover-before.png',
            'case-2-public-cover-after.png',
            'case-3-no-cover-before.png',
            'case-3-no-cover-after.png',
            'case-4-gingham-dark-before.png',
            'case-4-gingham-dark-after.png',
            'supplemental/case-3-no-cover-390x844.png',
            'evidence-manifest.json',
            'raw/before/case-1-share-dialog-before.png',
            'raw/before/anonymous-read-only-share-before.png',
            'raw/before/case-4-copy-before.png',
            'raw/current/case-1-share-dialog-after.png',
            'raw/current/case-2-public-cover-after.png',
            'raw/current/case-3-no-cover-after.png',
            'raw/current/case-4-gingham-dark-after.png',
            'raw/current/supplemental/case-3-no-cover-390x844.png',
        ];
        const beforeVerify = new Map(await Promise.all(trackedFiles.map(async (file) => (
            [file, await readFile(resolve(fixture.evidenceRoot, file))]
        ))));

        await assert.rejects(
            runScript(fixture.root, '--verify'),
            /Generated evidence does not match evidence-manifest\.json/,
        );

        for (const [file, expected] of beforeVerify) {
            assert.deepEqual(await readFile(resolve(fixture.evidenceRoot, file)), expected, `${file} was modified`);
        }
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});
