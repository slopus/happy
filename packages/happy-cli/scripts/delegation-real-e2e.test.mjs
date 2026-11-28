import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as harness from './delegation-real-e2e.mjs';

function fixture() {
    assert.equal(typeof harness.createDelegatedSessionTracker, 'function');
    const knownSessions = new Set(['parent']);
    const parentSessionIds = new Set(['parent']);
    const createdSessionIds = ['parent'];
    const revisions = [];
    const tracker = harness.createDelegatedSessionTracker({ knownSessions, parentSessionIds, createdSessionIds, revisions });
    return { knownSessions, createdSessionIds, revisions, tracker };
}
const summary = (version, childSessionId = `child-${version}`) => ({ id: 'task', parentSessionId: 'parent', version, childSessionId });

test('tracks every fresh revision as soon as its scoped summary is observed, without duplicate evidence', () => {
    const f = fixture();
    f.tracker.observe('parent', [{ ...summary(1), status: 'running' }]);
    f.tracker.observe('parent', [summary(1), summary(2), summary(3), summary(4)]);
    assert.deepEqual(f.createdSessionIds, ['parent', 'child-1', 'child-2', 'child-3', 'child-4']);
    assert.deepEqual([...f.knownSessions], f.createdSessionIds);
    assert.deepEqual(f.revisions.map(value => [value.version, value.childSessionId]), [[1, 'child-1'], [2, 'child-2'], [3, 'child-3'], [4, 'child-4']]);
});

test('retains earlier child identities when later task summaries replace them and ignores unspawned revisions', () => {
    const f = fixture();
    for (const version of [1, 2, 3, 4]) f.tracker.observe('parent', [summary(version)]);
    f.tracker.observe('parent', [{ ...summary(5), childSessionId: undefined }]);
    assert.deepEqual(f.createdSessionIds, ['parent', 'child-1', 'child-2', 'child-3', 'child-4']);
    assert.equal(f.revisions.length, 4);
});

test('rejects reused workers and changed revision identity while retaining already observed children', () => {
    for (const invalid of [summary(2, 'child-1'), summary(1, 'changed-child'), summary(1, 'parent')]) {
        const f = fixture(); f.tracker.observe('parent', [summary(1)]);
        assert.throws(() => f.tracker.observe('parent', [invalid]), /fresh|changed/);
        assert.deepEqual(f.createdSessionIds, ['parent', 'child-1']);
    }
});

test('rejects out-of-run parents or parent/task binding mismatches before adding a child', () => {
    const f = fixture();
    assert.throws(() => f.tracker.observe('foreign-parent', [summary(1)]), /outside this run/);
    assert.throws(() => f.tracker.observe('parent', [{ ...summary(1), parentSessionId: 'foreign-parent' }]), /parent binding/);
    assert.deepEqual(f.createdSessionIds, ['parent']);
});

test('archive confirmation accepts an already archived child and removes event listeners', async () => {
    assert.equal(typeof harness.waitForHarnessEvent, 'function');
    const changes = new EventEmitter();
    assert.equal(await harness.waitForHarnessEvent(changes, () => true, 'already archived', { timeout: 100 }), true);
    assert.equal(changes.listenerCount('change'), 0);
});

test('archive confirmation waits only for a metadata event and then removes its listener', async () => {
    assert.equal(typeof harness.waitForHarnessEvent, 'function');
    const changes = new EventEmitter();
    let metadata = { lifecycleState: 'running' }, inspections = 0;
    const archived = harness.waitForHarnessEvent(changes, () => { inspections++; return metadata.lifecycleState === 'archived'; }, 'child archived', { timeout: 100 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inspections, 1, 'An idle wait must not query session state again');
    metadata = { lifecycleState: 'archived' }; changes.emit('change');
    assert.equal(await archived, true);
    assert.equal(inspections, 2);
    assert.equal(changes.listenerCount('change'), 0);
});

test('archive wait times out or fails a connection check without leaving listeners or retrying', async () => {
    assert.equal(typeof harness.waitForHarnessEvent, 'function');
    const changes = new EventEmitter(); let inspections = 0;
    await assert.rejects(harness.waitForHarnessEvent(changes, () => { inspections++; return false; }, 'child archived', { timeout: 5 }), /timed out/);
    assert.equal(inspections, 1);
    assert.equal(changes.listenerCount('change'), 0);
    const failure = new Error('scoped connection failed');
    await assert.rejects(harness.waitForHarnessEvent(changes, () => { throw new Error('Must not inspect after disconnect'); }, 'child archived', { failure: () => failure }), failure);
    assert.equal(changes.listenerCount('change'), 0);
});

test('dry-run advertises fresh revision children, retained task history and terminal archive checks', () => {
    const script = fileURLToPath(new URL('./delegation-real-e2e.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.connects, false); assert.equal(plan.startsWorkers, false);
    assert(plan.checks.includes('same task revision creates a fresh child'));
    assert(plan.checks.includes('prior revision results remain in parent task history'));
    assert(plan.checks.includes('terminal delegated children archive through metadata events'));
});
