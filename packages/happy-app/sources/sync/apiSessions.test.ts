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
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([
        ['headers', 'active'], ['body', 'active'], ['body', 'page'],
    ])('settles a stalled %s %s request, aborts resources, and permits retry', async (stage, reader) => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            signal = options.signal;
            if (stage === 'headers') return new Promise(() => {});
            return { ok: true, json: () => new Promise(() => {}) };
        }));
        let outcome = 'pending';
        const read = () => reader === 'page' ? fetchSessionSnapshotPage(credentials, { limit: 25 })
            : fetchActiveSessionSnapshots(credentials, 25);
        const request = read().then(
            () => { outcome = 'success'; }, error => { outcome = error.kind; },
        );
        await vi.advanceTimersByTimeAsync(20_000);
        expect(outcome).toBe('timeout');
        await request;
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        const body = { sessions: [sessionSnapshot('retried')], nextCursor: null, hasNext: false };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
        await expect(read()).resolves.toEqual(reader === 'page' ? body : body.sessions);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([[401, false], [403, false], [429, true], [503, true]])(
        'classifies HTTP %s without exposing response contents', async (status, retryable) => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ secret: 'private-response' }, status)));
            const error = await fetchActiveSessionSnapshots(credentials, 25).catch(error => error);
            expect(error).toMatchObject({ kind: 'http', status, retryable });
            expect(error.message).not.toContain('private-response');
        },
    );

    it('classifies malformed response separately from a transient network failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ sessions: [{}] })));
        await expect(fetchActiveSessionSnapshots(credentials, 25)).rejects.toMatchObject({ kind: 'invalid-response', retryable: false });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private request URL')));
        const error = await fetchActiveSessionSnapshots(credentials, 25).catch(error => error);
        expect(error).toMatchObject({ kind: 'network', retryable: true });
        expect(error.message).not.toContain('private request URL');
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
                signal: expect.any(AbortSignal),
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
            { headers: expect.objectContaining({ Authorization: 'Bearer test-token' }), signal: expect.any(AbortSignal) },
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
            { headers: expect.objectContaining({ 'X-Happy-Client': 'test-client' }), signal: expect.any(AbortSignal) },
        );
    });

    it('rejects a response that omits an encrypted snapshot field', async () => {
        const malformed = sessionSnapshot('malformed-session');
        const { metadata: _metadata, ...withoutMetadata } = malformed;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ session: withoutMetadata })));

        await expect(fetchSessionSnapshot(credentials, 'malformed-session')).rejects.toThrow();
    });
});
