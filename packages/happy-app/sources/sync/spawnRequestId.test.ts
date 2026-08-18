import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ uuidCount: 0 }));

vi.mock('expo-crypto', () => ({
    randomUUID: () => `request-${++mocks.uuidCount}`,
}));

import {
    buildSpawnRequestSignature,
    completeSpawnRequest,
    PENDING_SPAWN_REQUEST_TTL_MS,
    resolveSpawnRequestId,
} from './spawnRequestId';

const baseInput = {
    machineId: 'machine-1',
    agent: 'rig',
    directory: '~/project',
    worktree: '__none__',
    newWorktreeName: null,
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

    it('keeps a new worktree retry together, but separates a renamed worktree', () => {
        const firstRequest = {
            ...baseInput,
            worktree: '__new__',
            newWorktreeName: 'quiet-harbor',
        };

        expect(resolveSpawnRequestId(buildSpawnRequestSignature(firstRequest))).toBe('request-1');
        expect(resolveSpawnRequestId(buildSpawnRequestSignature(firstRequest))).toBe('request-1');
        expect(resolveSpawnRequestId(buildSpawnRequestSignature({
            ...firstRequest,
            newWorktreeName: 'bright-forest',
        }))).toBe('request-2');
    });

    it('mints a new key after the bounded pending retry window', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const signature = buildSpawnRequestSignature(baseInput);

        expect(resolveSpawnRequestId(signature)).toBe('request-1');
        now.mockReturnValue(1_000 + PENDING_SPAWN_REQUEST_TTL_MS - 1);
        expect(resolveSpawnRequestId(signature)).toBe('request-1');
        now.mockReturnValue(1_000 + PENDING_SPAWN_REQUEST_TTL_MS);
        expect(resolveSpawnRequestId(signature)).toBe('request-2');

        now.mockRestore();
    });
});
