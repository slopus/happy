import { describe, expect, it, vi } from 'vitest';
import { createResumeSessionHandler } from './resumeSession';

function fallback(agent: 'claude' | 'codex') {
    return {
        fallback: {
            directory: '/tmp/project',
            agent,
            agentSessionId: agent === 'claude' ? 'claude-session' : 'codex-thread',
        },
    };
}

describe('createResumeSessionHandler', () => {
    it.each(['claude', 'codex'] as const)('falls back to a fresh Happy session for an untracked %s session', async (agent) => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-new' });
        const handler = createResumeSessionHandler({
            findTrackedSessionById: () => undefined,
            refreshMetadata: vi.fn(),
            resumeTrackedSession: vi.fn(),
            spawnSession,
        });

        await expect(handler('happy-old', fallback(agent))).resolves.toEqual({
            type: 'success',
            sessionId: 'happy-new',
        });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            agent,
            ...(agent === 'claude'
                ? { resumeClaudeSessionId: 'claude-session' }
                : { resumeCodexThreadId: 'codex-thread' }),
        }));
    });

    it('keeps the explicit error when no safe fallback metadata was supplied', async () => {
        const spawnSession = vi.fn();
        const handler = createResumeSessionHandler({
            findTrackedSessionById: () => undefined,
            refreshMetadata: vi.fn(),
            resumeTrackedSession: vi.fn(),
            spawnSession,
        });

        await expect(handler('happy-old')).resolves.toEqual({
            type: 'error',
            errorMessage: expect.stringContaining('not tracked by this daemon'),
        });
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
