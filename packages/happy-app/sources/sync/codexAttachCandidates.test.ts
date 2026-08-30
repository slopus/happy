import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, refreshSessions } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: { refreshSessions } }));

import {
    attachCodexCandidate,
    dismissCodexCandidate,
    filterCodexAttachCandidates,
    listCodexAttachCandidates,
} from './codexAttachCandidates';

describe('Codex attach candidate operations', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        refreshSessions.mockReset();
    });

    it('lists candidates with existing mappings so the daemon can de-duplicate', async () => {
        machineRPC.mockResolvedValue({ candidates: [] });

        await listCodexAttachCandidates('machine-1', ['thread-already-synced']);

        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'codex-list-attach-candidates', {
            existingThreadIds: ['thread-already-synced'],
        });
    });

    it('attaches and dismisses through machine-scoped RPCs', async () => {
        machineRPC.mockResolvedValueOnce({ type: 'success', sessionId: 'paws-session' });
        machineRPC.mockResolvedValueOnce({ type: 'success' });

        await expect(attachCodexCandidate('machine-1', 'thread-1')).resolves.toEqual({
            type: 'success',
            sessionId: 'paws-session',
        });
        expect(refreshSessions).toHaveBeenCalledTimes(1);

        await dismissCodexCandidate('machine-1', 'thread-2');
        expect(machineRPC).toHaveBeenLastCalledWith('machine-1', 'codex-dismiss-attach-candidate', {
            threadId: 'thread-2',
        });
    });

    it('filters candidates by title, directory, or machine name without case sensitivity', () => {
        const candidates = [
            {
                threadId: 'title-match',
                title: 'Investigate Chrome freeze',
                directory: '/Users/test/browser',
                createdAt: 1,
                updatedAt: 3,
                machineId: 'machine-1',
                machineName: 'Mac mini',
            },
            {
                threadId: 'path-match',
                title: 'Prepare release',
                directory: '/Users/test/Photo Wall',
                createdAt: 1,
                updatedAt: 2,
                machineId: 'machine-2',
                machineName: 'MacBook Air',
            },
        ];

        expect(filterCodexAttachCandidates(candidates, 'CHROME').map((candidate) => candidate.threadId)).toEqual([
            'title-match',
        ]);
        expect(filterCodexAttachCandidates(candidates, 'photo wall').map((candidate) => candidate.threadId)).toEqual([
            'path-match',
        ]);
        expect(filterCodexAttachCandidates(candidates, 'macbook').map((candidate) => candidate.threadId)).toEqual([
            'path-match',
        ]);
        expect(filterCodexAttachCandidates(candidates, '   ')).toEqual(candidates);
    });
});
