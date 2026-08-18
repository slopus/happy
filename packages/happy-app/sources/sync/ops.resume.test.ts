import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({ machineRPC: vi.fn() }));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));

describe('machineResumeSession', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-new' });
    });

    it('forwards provider metadata for the untracked-session fallback', async () => {
        const { machineResumeSession } = await import('./ops');
        await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'happy-old',
            model: 'opus',
            permissionMode: 'acceptEdits',
            effort: 'high',
            fallback: {
                directory: '/tmp/project',
                agent: 'claude',
                agentSessionId: 'claude-session',
            },
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            {
                sessionId: 'happy-old',
                model: 'opus',
                permissionMode: 'acceptEdits',
                effort: 'high',
                fallback: {
                    directory: '/tmp/project',
                    agent: 'claude',
                    agentSessionId: 'claude-session',
                },
            },
        );
    });
});
