import type { AuthCredentials } from '@/auth/tokenStorage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    fetchActiveSessionSnapshots,
    fetchSessionSnapshot,
    fetchSessionSnapshotPage,
} from './apiSessions';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test',
}));

vi.mock('./apiSocket', () => ({
    getHappyClientId: () => 'test-client',
}));

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

function sessionSnapshot(id: string) {
    return {
        id,
        seq: 3,
        metadata: 'encrypted-metadata',
        metadataVersion: 4,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: 'encrypted-key',
        active: true,
        activeAt: 1_700_000_000_001,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
    };
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('session snapshot API readers', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches and validates one encoded session id', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
            session: sessionSnapshot('session/with spaces'),
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchSessionSnapshot(credentials, 'session/with spaces'))
            .resolves.toEqual(sessionSnapshot('session/with spaces'));
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test/v2/sessions/session%2Fwith%20spaces',
            {
                headers: {
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                    'X-Happy-Client': 'test-client',
                },
            },
        );
    });

    it('returns null when the single-session endpoint returns 404', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            error: 'Session not found',
        }, 404)));

        await expect(fetchSessionSnapshot(credentials, 'missing-session')).resolves.toBeNull();
    });

    it('fetches active snapshots with the requested limit', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
            sessions: [sessionSnapshot('active-session')],
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchActiveSessionSnapshots(credentials, 25)).resolves.toEqual([
            sessionSnapshot('active-session'),
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test/v2/sessions/active?limit=25',
            { headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) },
        );
    });

    it('fetches and validates a cursor page', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
            sessions: [sessionSnapshot('historical-session')],
            nextCursor: 'cursor_v1_next',
            hasNext: true,
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchSessionSnapshotPage(credentials, {
            cursor: 'cursor_v1_current',
            limit: 50,
            changedSince: 1_700_000_000_000,
        })).resolves.toEqual({
            sessions: [sessionSnapshot('historical-session')],
            nextCursor: 'cursor_v1_next',
            hasNext: true,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.test/v2/sessions?cursor=cursor_v1_current&limit=50&changedSince=1700000000000',
            { headers: expect.objectContaining({ 'X-Happy-Client': 'test-client' }) },
        );
    });

    it('rejects a response that omits an encrypted snapshot field', async () => {
        const malformed = sessionSnapshot('malformed-session');
        const { metadata: _metadata, ...withoutMetadata } = malformed;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ session: withoutMetadata })));

        await expect(fetchSessionSnapshot(credentials, 'malformed-session')).rejects.toThrow();
    });
});
