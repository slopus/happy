import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ uuidCount: 0 }));

vi.mock('expo-crypto', () => ({
    randomUUID: () => `request-${++mocks.uuidCount}`,
}));

import {
    buildSpawnRequestSignature,
    completeSpawnRequest,
    getSpawnedSessionId,
    rememberSpawnedSession,
    releaseSpawnedSession,
    resolveSpawnRequestId,
} from './spawnRequestId';

const baseInput = {
    machineId: 'machine-1',
    agent: 'rig',
    directory: '~/project',
    worktree: '__none__',
    modelKey: 'codex/gpt-5.6-sol',
    permissionMode: 'auto',
    effort: 'high',
};

describe('spawn request id', () => {
    beforeEach(() => {
        mocks.uuidCount = 0;
        completeSpawnRequest();
    });

    it('reuses the key while the user retries the same request', () => {
        const signature = buildSpawnRequestSignature(baseInput);

        expect(resolveSpawnRequestId(signature)).toBe('request-1');
        expect(resolveSpawnRequestId(signature)).toBe('request-1');
        expect(resolveSpawnRequestId(buildSpawnRequestSignature(baseInput))).toBe('request-1');
    });

    it('mints a new key once a spawn succeeded', () => {
        const signature = buildSpawnRequestSignature(baseInput);

        expect(resolveSpawnRequestId(signature)).toBe('request-1');
        completeSpawnRequest();
        expect(resolveSpawnRequestId(signature)).toBe('request-2');
    });

    it('mints a new key when the user changes what they asked for', () => {
        expect(resolveSpawnRequestId(buildSpawnRequestSignature(baseInput))).toBe('request-1');
        expect(resolveSpawnRequestId(buildSpawnRequestSignature({
            ...baseInput,
            permissionMode: 'read_only',
        }))).toBe('request-2');
        expect(resolveSpawnRequestId(buildSpawnRequestSignature({
            ...baseInput,
            directory: '~/other',
        }))).toBe('request-3');
    });

    it('retains a created session for the same attempt, and abandons it only on configuration change', () => {
        const id = resolveSpawnRequestId(buildSpawnRequestSignature(baseInput));
        const abandon = vi.fn();
        rememberSpawnedSession(id, 'created-session', abandon);
        expect(resolveSpawnRequestId(buildSpawnRequestSignature(baseInput))).toBe(id);
        expect(getSpawnedSessionId(id)).toBe('created-session');
        expect(abandon).not.toHaveBeenCalled();
        const replacement = resolveSpawnRequestId(buildSpawnRequestSignature({ ...baseInput, machineId: 'other' }));
        expect(abandon).toHaveBeenCalledOnce();
        expect(getSpawnedSessionId(replacement)).toBeUndefined();
        completeSpawnRequest(id); // Late completion cannot erase the newer attempt.
        expect(resolveSpawnRequestId(buildSpawnRequestSignature({ ...baseInput, machineId: 'other' }))).toBe(replacement);
    });

    it('never abandons an accepted session when the next request changes', () => {
        const id = resolveSpawnRequestId(buildSpawnRequestSignature(baseInput));
        const abandon = vi.fn();
        rememberSpawnedSession(id, 'accepted-session', abandon);
        completeSpawnRequest(id);
        resolveSpawnRequestId(buildSpawnRequestSignature({ ...baseInput, directory: '/different' }));
        expect(abandon).not.toHaveBeenCalled();
    });

    it('never stops a retained session the user has adopted from the session list', () => {
        const id = resolveSpawnRequestId(buildSpawnRequestSignature(baseInput));
        const abandon = vi.fn();
        rememberSpawnedSession(id, 'adopted-session', abandon);
        releaseSpawnedSession('adopted-session');
        resolveSpawnRequestId(buildSpawnRequestSignature({ ...baseInput, directory: '/different' }));
        expect(abandon).not.toHaveBeenCalled();
    });
});
