import { describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { createCheckpointRestartQueue, restartCheckpointProtectedSession } from './checkpointProtectedRestart';

describe('checkpoint restart queue', () => {
    it('shares matching modes but serializes a disable after protected refresh', async () => {
        const restart = createCheckpointRestartQueue();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const order: string[] = [];
        const refresh = restart('session', true, async () => { order.push('refresh'); await gate; });
        const duplicate = restart('session', true, async () => { throw new Error('duplicate'); });
        const disable = restart('session', false, async () => { order.push('disable'); });
        expect(duplicate).toBe(refresh);
        expect(order).toEqual(['refresh']);
        release();
        await Promise.all([refresh, disable]);
        expect(order).toEqual(['refresh', 'disable']);
        await restart('session', true, async () => { order.push('fresh'); });
        expect(order.at(-1)).toBe('fresh');
    });

    it('does not start a different mode after an uncertain restart failure', async () => {
        const restart = createCheckpointRestartQueue();
        const disable = vi.fn(async () => {});
        const refresh = restart('session', true, async () => { throw new Error('unknown'); });
        const queued = restart('session', false, disable);
        await expect(refresh).rejects.toThrow('unknown');
        await expect(queued).rejects.toThrow('unknown');
        expect(disable).not.toHaveBeenCalled();
    });
});

describe('restartCheckpointProtectedSession', () => {
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
        projectPath: '/workspace/project',
    } as const;
    const sandboxConfig = SandboxConfigSchema.parse({
        checkpointProtection: {
            secretPatterns: ['.env*'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        },
        denyWritePaths: ['existing-deny'],
    });

    it('terminates the exact protected child before resuming without checkpoint protection', async () => {
        const order: string[] = [];
        let alive = true;
        const terminate = vi.fn(async () => {
            order.push('terminate');
            alive = false;
        });
        const resume = vi.fn(async () => {
            order.push('resume');
            return { type: 'success' as const, sessionId: binding.sessionId };
        });

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                pid: 123,
                active: true,
                knownStopped: false,
                sandboxConfig,
                terminate,
            }),
            isProcessAlive: () => alive,
            resume,
        })).resolves.toEqual({ sessionId: binding.sessionId });

        expect(order).toEqual(['terminate', 'resume']);
        expect(resume).toHaveBeenCalledWith(binding.sessionId, {
            HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({
                ...sandboxConfig,
                checkpointProtection: undefined,
            }),
        });
    });

    it('rejects a changed binding before terminating the child', async () => {
        const terminate = vi.fn(async () => {});

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                projectId: 'other-project',
                pid: 123,
                active: true,
                knownStopped: false,
                sandboxConfig,
                terminate,
            }),
            isProcessAlive: () => true,
            resume: vi.fn(),
        })).rejects.toThrow('binding mismatch');

        expect(terminate).not.toHaveBeenCalled();
    });

    it('preserves the exact checkpoint and sandbox policy during protected refresh', async () => {
        const resume = vi.fn(async () => ({ type: 'success', sessionId: binding.sessionId }));
        await restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({ ...binding, pid: 0, active: false, knownStopped: true,
                sandboxConfig, terminate: vi.fn() }),
            isProcessAlive: () => false,
            resume,
        }, { preserveProtection: true });
        expect(resume).toHaveBeenCalledWith(binding.sessionId, {
            HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(sandboxConfig),
        });
    });

    it('retries replacement spawn when the previous protected child is already stopped', async () => {
        const terminate = vi.fn(async () => {});
        const isProcessAlive = vi.fn(() => true);
        const resume = vi.fn(async () => ({
            type: 'success' as const,
            sessionId: binding.sessionId,
        }));

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                pid: 0,
                active: false,
                knownStopped: true,
                sandboxConfig,
                terminate,
            }),
            isProcessAlive,
            resume,
        })).resolves.toEqual({ sessionId: binding.sessionId });

        expect(terminate).not.toHaveBeenCalled();
        expect(isProcessAlive).not.toHaveBeenCalled();
        expect(resume).toHaveBeenCalledOnce();
    });

    it('refuses a persisted target when the daemon cannot prove the old provider stopped', async () => {
        const resume = vi.fn();

        await expect(restartCheckpointProtectedSession(binding, {
            resolveTarget: async () => ({
                ...binding,
                pid: 0,
                active: false,
                knownStopped: false,
                sandboxConfig,
                terminate: vi.fn(),
            }),
            isProcessAlive: vi.fn(),
            resume,
        })).rejects.toThrow('cannot prove the previous provider stopped');

        expect(resume).not.toHaveBeenCalled();
    });
});
