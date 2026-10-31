import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({ machineRPC: vi.fn() }));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));

describe('happy-cli daemon spawn errors', () => {
    const request = {
        machineId: 'machine-1',
        directory: '/home/claude/project',
        agent: 'claude' as const,
    };

    beforeEach(() => {
        machineRPC.mockReset();
    });

    it('shows the error the daemon sent when its spawn handler threw', async () => {
        // RpcHandlerManager answers a handler that threw with `{ error }` and no `type`.
        machineRPC.mockResolvedValueOnce({ error: 'Session webhook timeout for PID 2870020' });
        const { machineSpawnNewSession } = await import('./ops');

        await expect(machineSpawnNewSession(request)).resolves.toEqual({
            type: 'error',
            errorMessage: 'Session webhook timeout for PID 2870020',
        });
    });

    it('still reports an answer it cannot read', async () => {
        const { machineSpawnNewSession } = await import('./ops');

        for (const answer of [null, 'ok', {}, { error: '' }, { error: 42 }]) {
            machineRPC.mockResolvedValueOnce(answer);
            await expect(machineSpawnNewSession(request)).resolves.toEqual({
                type: 'error',
                errorMessage: 'The machine answered with something Happy could not read.',
            });
        }
    });
});
