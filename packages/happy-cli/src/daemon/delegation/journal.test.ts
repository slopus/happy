import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { createDelegationReporter, DELEGATION_RESULT_TEXT_LIMIT, delegationLocalId, readDelegationReports, writeDelegationBinding,
    readDelegationReady, waitForDelegationReady, writeDelegationReady } from './journal';
import { writeDelegationJson } from './store';
import * as journal from './journal';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'paws-delegation-reporter-')); directories.push(directory);
    const descriptor = { directory, taskId: 'task-one', parentSessionId: 'parent-one', nonce: 'a'.repeat(64) };
    const binding = { taskId: descriptor.taskId, parentSessionId: descriptor.parentSessionId, nonce: descriptor.nonce, requestId: 'request-one', version: 1 };
    const localId = delegationLocalId(binding);
    writeDelegationBinding(directory, { ...binding, childSessionId: 'child-one', localId });
    const reporter = createDelegationReporter({ descriptor, sessionId: 'child-one' });
    return { directory, descriptor, binding, localId, reporter, report: () => readDelegationReports(directory)[0] };
}
describe('delegation worker journal', () => {
    it('bounds an unacknowledged retirement step once and still closes every execution resource with a failure outcome', async () => {
        expect(typeof (journal as any).finishDelegationRetirement).toBe('function');
        vi.useFakeTimers();
        try {
            const closed: string[] = [], errors: string[] = [];
            const result = (journal as any).finishDelegationRetirement([
                { name: 'archive', run: () => new Promise<void>(() => {}) },
                { name: 'backend', run: () => { closed.push('backend'); } },
                { name: 'bridge', run: () => { closed.push('bridge'); } },
                { name: 'session', run: () => { closed.push('session'); } },
            ], (name: string) => { errors.push(name); }, 100);
            await vi.advanceTimersByTimeAsync(100);
            expect(await result).toBe(false);
            expect(closed).toEqual(['backend', 'bridge', 'session']);
            expect(errors).toEqual(['archive']);
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });
    it.each(['completed', 'failed', 'cancelled'] as const)('permits retirement only after the exact %s root report is durable', status => {
        const f = fixture();
        expect(typeof (f.reporter as any).canRetire).toBe('function');
        const canRetire = (turnId?: string, localId = f.localId) => (f.reporter as any).canRetire({ localId, expectedTurnId: turnId });
        expect(canRetire()).toBe(true);
        expect(canRetire(undefined, 'delegation:other-task:1:request-one')).toBe(false);
        f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        expect(canRetire()).toBe(false);
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        f.reporter.waitingForInput(true, 'root-one');
        expect(canRetire('root-one')).toBe(false);
        f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status }, { turn: 'root-one' }));
        expect(canRetire('other-root')).toBe(false);
        expect(canRetire('root-one')).toBe(true);
        expect(f.report()).toMatchObject({ status, turnId: 'root-one' });
    });

    it('does not permit retirement from an interrupted root or a failed protected write', () => {
        const f = fixture();
        expect(typeof (f.reporter as any).canRetire).toBe('function');
        f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        f.reporter.processorStartupFailed();
        expect((f.reporter as any).canRetire({ localId: f.localId, expectedTurnId: 'root-one' })).toBe(false);
        const path = join(f.directory, 'report-task-one-1.json'); rmSync(path); mkdirSync(path);
        expect(() => f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'root-one' }))).toThrow();
        expect((f.reporter as any).canRetire({ localId: f.localId, expectedTurnId: 'root-one' })).toBe(false);
    });

    it('does not mistake a restarted reporter with an existing root receipt for a never-used worker', () => {
        const f = fixture(); f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'old-root' }));
        f.reporter.processorStartupFailed();
        const restarted = createDelegationReporter({ descriptor: f.descriptor, sessionId: 'child-one' });
        expect(restarted.canRetire({ localId: f.localId })).toBe(false);
    });

    it('locks a bound terminal worker synchronously before acknowledging retirement, including a native completion still unwinding', () => {
        const f = fixture();
        expect(typeof (journal as any).createDelegationRetireHandler).toBe('function');
        f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'root-one' }));
        let retiring = false;
        const handler = (journal as any).createDelegationRetireHandler({
            launch: f.descriptor, state: () => ({ metadata: { hostPid: process.pid, parentSessionId: 'parent-one',
                delegatedTask: { taskId: 'task-one', parentSessionId: 'parent-one' } }, queueSize: 0, pendingInputs: false,
                activeRootTurnId: 'root-one', thinking: true }),
            canRetire: (input: any) => (f.reporter as any).canRetire(input), retire: () => { retiring = true; },
        });
        expect(handler({ hostPid: process.pid, localId: f.localId, expectedTurnId: 'root-one' })).toEqual({ retiring: true });
        expect(retiring).toBe(true);
    });

    it.each(['unbound', 'pid', 'parent', 'task', 'application', 'sandbox', 'queue', 'pending', 'new-root', 'unconfirmed'] as const)(
        'refuses unsafe retirement for %s without stopping a worker', condition => {
            const f = fixture();
            expect(typeof (journal as any).createDelegationRetireHandler).toBe('function');
            let retired = false;
            const state = { metadata: { hostPid: process.pid, parentSessionId: 'parent-one',
                delegatedTask: { taskId: condition === 'task' ? 'other' : 'task-one', parentSessionId: condition === 'parent' ? 'other' : 'parent-one' },
                ...(condition === 'application' ? { application: {} } : {}), ...(condition === 'sandbox' ? { sandbox: { enabled: true } } : {}) },
                queueSize: condition === 'queue' ? 1 : 0, pendingInputs: condition === 'pending',
                activeRootTurnId: condition === 'new-root' ? 'another-root' : null, thinking: false };
            const handler = (journal as any).createDelegationRetireHandler({ launch: condition === 'unbound' ? null : f.descriptor,
                state: () => state, canRetire: () => condition !== 'unconfirmed', retire: () => { retired = true; } });
            expect(() => handler({ hostPid: condition === 'pid' ? process.pid + 1 : process.pid,
                localId: f.localId, expectedTurnId: 'root-one' })).toThrow();
            expect(retired).toBe(false);
        });
    it('accepts only its protected task binding and exact delegated local ID', () => {
        const f = fixture();
        expect(f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: { ...f.binding, nonce: 'b'.repeat(64) } } })).toBe(false);
        expect(f.reporter.acceptMessage({ localId: 'other-message', meta: { delegation: f.binding } })).toBe(false);
        expect(f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: { ...f.binding, version: 2 } } })).toBe(false);
        expect(f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } })).toBe(true);
        expect(f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } })).toBe(true);
        expect(f.report().sequence).toBe(1);
        expect(statSync(join(f.directory, 'report-task-one-1.json')).mode & 0o777).toBe(0o600);
    });

    it('collects only visible text of the matched root turn and freezes its terminal result', () => {
        const f = fixture(); f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: ['unrelated'] }, { turn: 'wrong-root' }));
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        f.reporter.observe(createEnvelope('agent', { t: 'text', text: 'hidden', thinking: true }, { turn: 'root-one' }));
        f.reporter.observe({ ...createEnvelope('agent', { t: 'text', text: 'native child output' }, { turn: 'root-one' }), subagent: 'native-child' });
        f.reporter.observe(createEnvelope('agent', { t: 'text', text: 'other turn' }, { turn: 'wrong-root' }));
        const text = createEnvelope('agent', { t: 'text', text: '# README' }, { turn: 'root-one' });
        f.reporter.observe(text); f.reporter.observe(text);
        f.reporter.observe(createEnvelope('agent', { t: 'text', text: 'Verified instructions.' }, { turn: 'root-one' }));
        expect(f.report().status).toBe('running');
        f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'wrong-root' }));
        expect(f.report().status).toBe('running');
        f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'root-one' }));
        f.reporter.observe(createEnvelope('agent', { t: 'text', text: 'late output' }, { turn: 'root-one' }));
        f.reporter.processorStartupFailed();
        expect(f.report()).toMatchObject({ status: 'completed', turnId: 'root-one', text: '# README\n\nVerified instructions.', truncated: false });
    });

    it('returns explicit truncation and refuses combined user/delegation turns', () => {
        const f = fixture(); f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId, 'other-input'] }, { turn: 'combined' }));
        expect(f.report().status).toBe('interrupted');
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        f.reporter.observe(createEnvelope('agent', { t: 'text', text: 'x'.repeat(DELEGATION_RESULT_TEXT_LIMIT + 1) }, { turn: 'root-one' }));
        f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'root-one' }));
        expect(f.report().text).toHaveLength(DELEGATION_RESULT_TEXT_LIMIT);
        expect(f.report().truncated).toBe(true);
    });

    it('reports discarded input and waiting for input without pretending that ready means success', () => {
        const f = fixture(); f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.rejectMessage(f.localId);
        expect(f.report().status).toBe('interrupted');
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        f.reporter.waitingForInput(true, 'other-root'); expect(f.report().status).toBe('running');
        f.reporter.waitingForInput(true, 'root-one'); expect(f.report().status).toBe('waiting-for-input');
        f.reporter.observe({ ...createEnvelope('agent', { t: 'turn-start' }), ev: { t: 'ready' } } as unknown as SessionEnvelope);
        expect(f.report().status).toBe('waiting-for-input');
        f.reporter.waitingForInput(false, 'root-one');
        f.reporter.observe(createEnvelope('agent', { t: 'turn-end', status: 'cancelled' }, { turn: 'root-one' }));
        expect(f.report().status).toBe('cancelled');
    });

    it('rejects malformed reports and bindings with a mismatched stored revision', () => {
        const f = fixture();
        writeDelegationJson(f.directory, 'binding-task-one-1.json', { ...f.binding, childSessionId: 'child-one', localId: f.localId, version: 2 });
        expect(f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } })).toBe(false);
        writeDelegationBinding(f.directory, { ...f.binding, childSessionId: 'child-one', localId: f.localId });
        expect(f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } })).toBe(true);
        const valid = f.report();
        writeDelegationJson(f.directory, 'report-task-one-1.json', { ...valid, error: { unexpected: 'object' } });
        expect(readDelegationReports(f.directory)).toEqual([]);
        const restarted = createDelegationReporter({ descriptor: f.descriptor, sessionId: 'child-one' });
        expect(restarted.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } })).toBe(false);
        writeDelegationJson(f.directory, 'report-task-one-1.json', { ...valid, version: 2 });
        expect(readDelegationReports(f.directory)).toEqual([]);
    });

    it('resumes the same root journal without duplicating already persisted text', () => {
        const f = fixture(); f.reporter.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } });
        f.reporter.observe(createEnvelope('agent', { t: 'turn-start', localIds: [f.localId] }, { turn: 'root-one' }));
        const text = createEnvelope('agent', { t: 'text', text: 'Persisted paragraph' }, { turn: 'root-one' });
        f.reporter.observe(text); const previousSequence = f.report().sequence;
        const resumed = createDelegationReporter({ descriptor: f.descriptor, sessionId: 'child-one' });
        expect(resumed.acceptMessage({ localId: f.localId, meta: { delegation: f.binding } })).toBe(true);
        resumed.observe(text);
        expect(f.report().sequence).toBe(previousSequence);
        resumed.observe(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: 'root-one' }));
        expect(f.report()).toMatchObject({ status: 'completed', text: 'Persisted paragraph' });
    });

    it('writes a protected native readiness receipt only after an explicit catalog-ready event', async () => {
        const f = fixture();
        expect(readDelegationReady(f.directory, f.binding.taskId)).toBeNull();
        f.reporter.ready();
        const receipt = readDelegationReady(f.directory, f.binding.taskId);
        expect(receipt).toMatchObject({ taskId: f.binding.taskId, parentSessionId: f.binding.parentSessionId,
            nonce: f.binding.nonce, childSessionId: 'child-one', hostPid: process.pid });
        expect(statSync(join(f.directory, 'ready-task-one.json')).mode & 0o777).toBe(0o600);
        f.reporter.ready();
        expect(readDelegationReady(f.directory, f.binding.taskId)).toEqual(receipt);
        await expect(waitForDelegationReady({ descriptor: f.descriptor, sessionId: 'child-one', hostPid: process.pid })).resolves.toEqual(receipt);
    });

    it.each(['nonce', 'parent', 'child', 'pid'])('ignores a stale or forged %s readiness receipt and resolves on the exact worker event', async condition => {
        const f = fixture();
        writeDelegationReady(f.directory, { taskId: f.binding.taskId, parentSessionId: condition === 'parent' ? 'wrong-parent' : f.binding.parentSessionId,
            nonce: condition === 'nonce' ? 'b'.repeat(64) : f.binding.nonce, childSessionId: condition === 'child' ? 'wrong-child' : 'child-one',
            hostPid: condition === 'pid' ? process.pid + 1 : process.pid, readyAt: Date.now() });
        let resolved = false;
        const waiting = waitForDelegationReady({ descriptor: f.descriptor, sessionId: 'child-one', hostPid: process.pid, timeoutMs: 1000 }).then(value => { resolved = true; return value; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(resolved).toBe(false);
        f.reporter.ready();
        await expect(waiting).resolves.toMatchObject({ nonce: f.binding.nonce, parentSessionId: f.binding.parentSessionId, childSessionId: 'child-one', hostPid: process.pid });
    });

    it('uses one readiness deadline and does not fabricate a native-ready receipt on timeout', async () => {
        const f = fixture();
        await expect(waitForDelegationReady({ descriptor: f.descriptor, sessionId: 'child-one', hostPid: process.pid, timeoutMs: 10 })).rejects.toThrow('Timed out waiting');
        expect(readDelegationReady(f.directory, f.binding.taskId)).toBeNull();
    });
});
