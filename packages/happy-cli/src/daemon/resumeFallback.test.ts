import { describe, expect, it } from 'vitest';
import { buildResumeFallbackSpawnOptions } from './resumeFallback';

describe('buildResumeFallbackSpawnOptions', () => {
    it('continues an untracked Claude conversation as a fresh Happy session', () => {
        expect(buildResumeFallbackSpawnOptions({
            model: 'opus',
            permissionMode: 'acceptEdits',
            effort: 'high',
            fallback: {
                directory: '/tmp/project',
                agent: 'claude',
                agentSessionId: 'claude-session',
            },
        })).toEqual({
            directory: '/tmp/project',
            approvedNewDirectoryCreation: false,
            agent: 'claude',
            modelMode: 'opus',
            permissionMode: 'acceptEdits',
            effortLevel: 'high',
            resumeClaudeSessionId: 'claude-session',
        });
    });

    it('uses the Codex thread resume field for Codex conversations', () => {
        expect(buildResumeFallbackSpawnOptions({
            fallback: {
                directory: '/tmp/project',
                agent: 'codex',
                agentSessionId: 'thread-1',
            },
        })).toEqual(expect.objectContaining({
            agent: 'codex',
            resumeCodexThreadId: 'thread-1',
        }));
    });

    it('does not invent a fallback without app-provided provider metadata', () => {
        expect(buildResumeFallbackSpawnOptions(undefined)).toBeNull();
        expect(buildResumeFallbackSpawnOptions({ model: 'opus' })).toBeNull();
    });
});
