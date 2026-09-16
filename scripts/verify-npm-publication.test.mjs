import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { verifyNpmPublication } from './verify-npm-publication.mjs';

test('waits through an eight-minute npm processing delay for both the exact version and dist-tag', async () => {
    let nowMs = 0;
    const observations = [];

    const result = await verifyNpmPublication({
        packageName: '@wangjs-jacky/paws',
        expectedVersion: '1.3.12',
        tag: 'latest',
        timeoutMs: 15 * 60_000,
        intervalMs: 10_000,
        now: () => nowMs,
        sleep: async (durationMs) => { nowMs += durationMs; },
        lookupExactVersion: async () => nowMs >= 470_000 ? '1.3.12' : null,
        lookupTagVersion: async () => nowMs >= 480_000 ? '1.3.12' : '1.3.11',
        log: (message) => observations.push(message),
    });

    assert.deepEqual(result, {
        exactVersion: '1.3.12',
        taggedVersion: '1.3.12',
        elapsedMs: 480_000,
        attempts: 49,
    });
    assert.ok(observations.some((message) => message.includes('exact version is not visible')));
    assert.ok(observations.some((message) => (
        message.includes('exact version is 1.3.12') && message.includes('latest is 1.3.11')
    )));
});

test('workflow still verifies registry state when the immutable version already exists', async () => {
    const workflow = await readFile(
        new URL('../.github/workflows/cli-npm-publish.yml', import.meta.url),
        'utf8',
    );
    const verifyStep = workflow.match(
        /      - name: Verify published package\n([\s\S]*?)(?=\n      - name:)/,
    )?.[1];

    assert.ok(verifyStep, 'Verify published package step must exist');
    assert.doesNotMatch(
        verifyStep,
        /if:\s*steps\.npm\.outputs\.exists == 'false'/,
        'a rerun must verify both the immutable version and latest tag after skipping upload',
    );
});

test('reports the last exact-version and dist-tag observations on timeout', async () => {
    let nowMs = 0;

    await assert.rejects(
        verifyNpmPublication({
            packageName: '@wangjs-jacky/paws',
            expectedVersion: '1.3.12',
            tag: 'latest',
            timeoutMs: 20_000,
            intervalMs: 10_000,
            now: () => nowMs,
            sleep: async (durationMs) => { nowMs += durationMs; },
            lookupExactVersion: async () => null,
            lookupTagVersion: async () => '1.3.11',
            log: () => {},
        }),
        /timed out after 20000ms.*exact version: missing.*latest: 1\.3\.11/,
    );
});
