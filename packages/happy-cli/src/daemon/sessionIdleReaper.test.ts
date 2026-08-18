import { describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';
import { reapIdleDaemonSessions } from './sessionIdleReaper';

function daemonSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
    return {
        startedBy: 'daemon',
        pid: 123,
        happySessionId: 'session-1',
        startedAt: 1_000,
        ...overrides,
    };
}

describe('reapIdleDaemonSessions', () => {
    it('stops a daemon session whose newest message is past the timeout', async () => {
        const session = daemonSession();
        const stopSession = vi.fn(async () => true);

        const result = await reapIdleDaemonSessions({
            sessions: [session],
            timeoutMs: 5_000,
            fetchLatestMessageAt: vi.fn(async () => 2_000),
            isCurrent: (candidate) => candidate === session,
            deactivateSession: vi.fn(async () => true),
            stopSession,
            now: () => 10_000,
        });

        expect(stopSession).toHaveBeenCalledWith('session-1');
        expect(result.stopped).toBe(1);
    });

    it('uses spawn time when a session has no messages', async () => {
        const session = daemonSession({ happySessionId: undefined });
        const stopSession = vi.fn(async () => true);

        await reapIdleDaemonSessions({
            sessions: [session],
            timeoutMs: 5_000,
            fetchLatestMessageAt: vi.fn(),
            isCurrent: () => true,
            deactivateSession: vi.fn(async () => true),
            stopSession,
            now: () => 10_000,
        });

        expect(stopSession).toHaveBeenCalledWith('PID-123');
    });

    it('does not stop external, recently active, replaced, or unverifiable sessions', async () => {
        const external = daemonSession({ startedBy: 'happy directly', pid: 1 });
        const recent = daemonSession({ pid: 2, happySessionId: 'recent' });
        const replaced = daemonSession({ pid: 3, happySessionId: 'replaced' });
        const offline = daemonSession({ pid: 4, happySessionId: 'offline' });
        const stopSession = vi.fn(async () => true);

        const result = await reapIdleDaemonSessions({
            sessions: [external, recent, replaced, offline],
            timeoutMs: 5_000,
            fetchLatestMessageAt: vi.fn(async (id) => {
                if (id === 'recent') return 9_000;
                if (id === 'offline') throw new Error('network down');
                return 1_000;
            }),
            isCurrent: (session) => session !== replaced,
            deactivateSession: vi.fn(async () => true),
            stopSession,
            now: () => 10_000,
        });

        expect(stopSession).not.toHaveBeenCalled();
        expect(result.stopped).toBe(0);
        expect(result.errors).toEqual(['offline: network down']);
    });

    it('rechecks activity before stopping', async () => {
        const session = daemonSession();
        const fetchLatestMessageAt = vi.fn()
            .mockResolvedValueOnce(1_000)
            .mockResolvedValueOnce(9_000);
        const stopSession = vi.fn(async () => true);

        await reapIdleDaemonSessions({
            sessions: [session],
            timeoutMs: 5_000,
            fetchLatestMessageAt,
            isCurrent: () => true,
            deactivateSession: vi.fn(async () => true),
            stopSession,
            now: () => 10_000,
        });

        expect(fetchLatestMessageAt).toHaveBeenCalledTimes(2);
        expect(stopSession).not.toHaveBeenCalled();
    });

    it('marks a Happy session inactive before terminating its process tree', async () => {
        const session = daemonSession();
        const calls: string[] = [];

        await reapIdleDaemonSessions({
            sessions: [session],
            timeoutMs: 5_000,
            fetchLatestMessageAt: vi.fn(async () => 1_000),
            isCurrent: () => true,
            deactivateSession: vi.fn(async () => {
                calls.push('deactivate');
                return true;
            }),
            stopSession: vi.fn(async () => {
                calls.push('stop');
                return true;
            }),
            now: () => 10_000,
        });

        expect(calls).toEqual(['deactivate', 'stop']);
    });

    it.each([
        ['returns false', async () => false],
        ['throws', async () => { throw new Error('archive unavailable'); }],
    ])('fails open when deactivation %s', async (_label, deactivateSession) => {
        const stopSession = vi.fn(async () => true);

        const result = await reapIdleDaemonSessions({
            sessions: [daemonSession()],
            timeoutMs: 5_000,
            fetchLatestMessageAt: vi.fn(async () => 1_000),
            isCurrent: () => true,
            deactivateSession,
            stopSession,
            now: () => 10_000,
        });

        expect(stopSession).not.toHaveBeenCalled();
        expect(result.stopped).toBe(0);
        expect(result.errors).toHaveLength(1);
    });
});
