import { describe, expect, it } from 'vitest';
import { getSessionResumeFallback } from './sessionResumeFallback';

describe('getSessionResumeFallback', () => {
    it('builds a Claude fallback from decrypted session metadata', () => {
        expect(getSessionResumeFallback({
            path: '/tmp/project',
            claudeSessionId: 'claude-session',
        } as any)).toEqual({
            directory: '/tmp/project',
            agent: 'claude',
            agentSessionId: 'claude-session',
        });
    });

    it('builds a Codex fallback from decrypted session metadata', () => {
        expect(getSessionResumeFallback({
            path: '/tmp/project',
            flavor: 'codex',
            codexThreadId: 'thread-1',
        } as any)).toEqual({
            directory: '/tmp/project',
            agent: 'codex',
            agentSessionId: 'thread-1',
        });
    });

    it('uses the Claude session ID when Claude metadata has both provider IDs', () => {
        expect(getSessionResumeFallback({
            path: '/tmp/project',
            flavor: 'claude',
            claudeSessionId: 'claude-session',
            codexThreadId: 'stale-codex-thread',
        } as any)).toEqual({
            directory: '/tmp/project',
            agent: 'claude',
            agentSessionId: 'claude-session',
        });
    });

    it.each(['codex', 'openai', 'gpt'])('uses the Codex thread ID for %s flavor', (flavor) => {
        expect(getSessionResumeFallback({
            path: '/tmp/project',
            flavor,
            codexThreadId: 'thread-1',
        } as any)).toEqual({
            directory: '/tmp/project',
            agent: 'codex',
            agentSessionId: 'thread-1',
        });
    });

    it('keeps supporting legacy Codex metadata without a flavor', () => {
        expect(getSessionResumeFallback({
            path: '/tmp/project',
            codexThreadId: 'legacy-thread',
        } as any)).toEqual({
            directory: '/tmp/project',
            agent: 'codex',
            agentSessionId: 'legacy-thread',
        });
    });

    it('requires both the working directory and a provider session ID', () => {
        expect(getSessionResumeFallback({ path: '/tmp/project' } as any)).toBeUndefined();
        expect(getSessionResumeFallback({ claudeSessionId: 'claude-session' } as any)).toBeUndefined();
    });
});
