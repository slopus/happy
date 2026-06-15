import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions: vi.fn() },
}));

describe('spawn session ops', () => {
    beforeEach(() => {
        machineRPC.mockReset();
    });

    it('forwards environment variables to the machine spawn RPC', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'session-1' });

        const { machineSpawnNewSession } = await import('./ops');
        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp/project',
            agent: 'claude',
            environmentVariables: {
                TMUX_SESSION_NAME: 'happy-dev',
            },
        });

        expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                type: 'spawn-in-directory',
                directory: '/tmp/project',
                agent: 'claude',
                environmentVariables: {
                    TMUX_SESSION_NAME: 'happy-dev',
                },
            }),
        );
    });
});
