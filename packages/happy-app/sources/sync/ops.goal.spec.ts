import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        sessionRPC: mocks.sessionRPC,
    },
}));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: {} }));
vi.mock('./agentModesPending', () => ({
    markAgentModePushPending: vi.fn(),
    clearAgentModePushPending: vi.fn(),
}));

import { sessionGoalAction } from './ops';

describe('sessionGoalAction', () => {
    beforeEach(() => {
        mocks.sessionRPC.mockReset();
    });

    it.each(['pause', 'resume'] as const)('sends %s and requires an explicit ok response', async (action) => {
        mocks.sessionRPC.mockResolvedValue({ ok: true });

        await sessionGoalAction('session-1', action);

        expect(mocks.sessionRPC).toHaveBeenCalledWith(
            'session-1',
            'goal-action',
            { action },
        );
    });

    it('sends the edited objective', async () => {
        mocks.sessionRPC.mockResolvedValue({ ok: true });

        await sessionGoalAction('session-1', 'edit', 'ship the fix');

        expect(mocks.sessionRPC).toHaveBeenCalledWith(
            'session-1',
            'goal-action',
            { action: 'edit', objective: 'ship the fix' },
        );
    });

    it('throws the decrypted CLI error payload', async () => {
        mocks.sessionRPC.mockResolvedValue({ error: 'No active goal' });

        await expect(sessionGoalAction('session-1', 'resume')).rejects.toThrow('No active goal');
    });

    it('does not ignore an error in an otherwise malformed ok response', async () => {
        mocks.sessionRPC.mockResolvedValue({ ok: true, error: 'Goal update failed' });

        await expect(sessionGoalAction('session-1', 'pause')).rejects.toThrow('Goal update failed');
    });

    it('rejects malformed non-ok responses', async () => {
        mocks.sessionRPC.mockResolvedValue({});

        await expect(sessionGoalAction('session-1', 'pause')).rejects.toThrow('Goal action failed');
    });
});
