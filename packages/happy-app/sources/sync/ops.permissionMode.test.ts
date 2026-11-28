import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC, refreshSessions } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { sessionRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions },
}));

describe('session permission mode ops', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        refreshSessions.mockReset();
    });

    it('forwards an immediate permission-mode RPC to the running session', async () => {
        sessionRPC.mockResolvedValue(true);

        const { sessionSetPermissionMode } = await import('./ops');
        const result = await sessionSetPermissionMode('session-1', 'yolo');

        expect(result).toBe(true);
        expect(sessionRPC).toHaveBeenCalledWith(
            'session-1',
            'setPermissionMode',
            { mode: 'yolo' },
        );
    });

    it.each([false, undefined, null, {}, { success: true }, 'true', 1])(
        'does not treat a malformed or negative reply as a permission acknowledgement: %j',
        async (reply) => {
            sessionRPC.mockResolvedValue(reply);
            const { sessionSetPermissionMode } = await import('./ops');
            expect(await sessionSetPermissionMode('session-1', 'default')).toBe(false);
        },
    );

    it('surfaces a worker error instead of acknowledging its truthy envelope', async () => {
        sessionRPC.mockResolvedValue({ error: 'This permission mode is not supported by this Codex runtime.' });
        const { sessionSetPermissionMode } = await import('./ops');
        await expect(sessionSetPermissionMode('session-1', 'safe-yolo')).rejects.toThrow(
            'This permission mode is not supported by this Codex runtime.',
        );
    });
});
