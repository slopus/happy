import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ sessions: {} as Record<string, any>, read: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '9efc1c63-e694-44c6-b14e-3b1e6fae0706',
    CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async () => '0'.repeat(64) }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: () => {} }));
vi.mock('./storage', () => ({ storage: { getState: () => mock } }));
vi.mock('./sync', () => ({ sync: { readPortableContextSegment: mock.read } }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: vi.fn() } }));
vi.mock('./ops', () => ({ sessionUpdateMetadata: vi.fn() }));

import { prepareSessionContinuationContext } from './sessionContextHandoff';

const boundary = { id: '9efc1c63-e694-44c6-b14e-3b1e6fae0706', afterSeq: 9 };
function source(id: string, metadata: object = {}) {
    mock.sessions[id] = { id, metadata: { machineId: 'machine', path: '/project', ...metadata } };
}
beforeEach(() => {
    mock.sessions = {};
    mock.read.mockReset().mockImplementation(async (id: string) => ({
        head: { sessionId: id, afterSeq: mock.sessions[id]?.metadata.portableContextBoundary?.afterSeq ?? 0, throughSeq: 10 },
        items: [], boundary: mock.sessions[id]?.metadata.portableContextBoundary,
        assertCurrent: () => {}, verifyCurrent: async () => {},
    }));
});

describe('portable source fork preflight', () => {
    it('rejects an explicit unverified fork before reading history', async () => {
        source('fork', { parentSessionId: 'parent', forkedFromMessageId: 'selected' });
        await expect(prepareSessionContinuationContext('fork')).rejects.toThrow('portable-context-fork-boundary-unverified');
        expect(mock.read).not.toHaveBeenCalled();
    });

    it('checks admitted predecessor segments and never follows the unverified fork parent', async () => {
        source('current', { continuationOfSessionId: 'fork', conversationRootSessionId: 'fork' });
        source('fork', { parentSessionId: 'parent', forkedFromMessageId: 'selected', conversationActiveSessionId: 'current' });
        await expect(prepareSessionContinuationContext('current')).rejects.toThrow('portable-context-fork-boundary-unverified');
        expect(mock.read.mock.calls.map(([id]) => id)).toEqual(['current', 'fork']);
    });

    it('admits a reset fork without opening its former parent or predecessors', async () => {
        source('fork', { parentSessionId: 'parent', forkedFromMessageId: 'selected',
            continuationOfSessionId: 'older', portableContextBoundary: boundary });
        const prepared = await prepareSessionContinuationContext('fork');
        expect(prepared.archive.snapshot.heads.map(head => head.sessionId)).toEqual(['fork']);
        expect(mock.read).toHaveBeenCalledExactlyOnceWith('fork');
    });

    it('admits an ordinary independent child without treating its parent as inherited history', async () => {
        source('child', { parentSessionId: 'independent-parent' });
        const prepared = await prepareSessionContinuationContext('child');
        expect(prepared.archive.snapshot.heads.map(head => head.sessionId)).toEqual(['child']);
        expect(mock.read).toHaveBeenCalledExactlyOnceWith('child');
    });
});
