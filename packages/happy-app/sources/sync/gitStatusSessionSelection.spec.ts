import { describe, expect, it } from 'vitest';

import { selectPreferredGitStatusSession } from './gitStatusSessionSelection';
import type { Session } from './storageTypes';

function createSession(id: string, active: boolean, activeAt: number, path: string = '/repo'): Session {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: activeAt,
        active,
        activeAt,
        metadata: {
            path,
            host: 'test-host',
            machineId: 'machine-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: activeAt,
        presence: active ? 'online' : activeAt,
    };
}

describe('gitStatusSessionSelection', () => {
    it('prefers an active session over an older offline session in the same project', () => {
        const offline = createSession('offline', false, 100);
        const active = createSession('active', true, 200);

        const selected = selectPreferredGitStatusSession([
            { sessionId: offline.id, session: offline },
            { sessionId: active.id, session: active },
        ], 'machine-1:/repo');

        expect(selected?.sessionId).toBe('active');
    });

    it('prefers the most recently active session when multiple sessions are online', () => {
        const olderActive = createSession('older-active', true, 100);
        const newerActive = createSession('newer-active', true, 200);

        const selected = selectPreferredGitStatusSession([
            { sessionId: olderActive.id, session: olderActive },
            { sessionId: newerActive.id, session: newerActive },
        ], 'machine-1:/repo');

        expect(selected?.sessionId).toBe('newer-active');
    });

    it('falls back to the most recent offline session when no active session exists', () => {
        const olderOffline = createSession('older-offline', false, 100);
        const newerOffline = createSession('newer-offline', false, 200);

        const selected = selectPreferredGitStatusSession([
            { sessionId: olderOffline.id, session: olderOffline },
            { sessionId: newerOffline.id, session: newerOffline },
        ], 'machine-1:/repo');

        expect(selected?.sessionId).toBe('newer-offline');
    });
});
