import { describe, expect, it } from 'vitest';
import { normalizeDaemonAgent, shouldSpawnHappyControllerInTmux } from './run';

describe('normalizeDaemonAgent', () => {
    it('normalizes undefined agent to Claude', () => {
        expect(normalizeDaemonAgent(undefined)).toBe('claude');
    });

    it.each(['codex', 'gemini', 'openclaw'] as const)('preserves %s agent', (agent) => {
        expect(normalizeDaemonAgent(agent)).toBe(agent);
    });

    it('rejects unsupported runtime agent values', () => {
        expect(normalizeDaemonAgent('unknown' as any)).toBeNull();
    });
});

describe('shouldSpawnHappyControllerInTmux', () => {
    it('does not spawn the Happy controller inside tmux for Claude interactive remote', () => {
        expect(shouldSpawnHappyControllerInTmux({
            agent: 'claude',
            tmuxAvailable: true,
            tmuxSessionName: 'happy',
        })).toBe(false);
    });

    it.each(['codex', 'gemini', 'openclaw'] as const)('keeps tmux behavior for %s when tmux is configured', (agent) => {
        expect(shouldSpawnHappyControllerInTmux({
            agent,
            tmuxAvailable: true,
            tmuxSessionName: 'happy',
        })).toBe(true);
    });

    it.each(['codex', 'gemini', 'openclaw'] as const)('disables tmux for %s when tmux is unavailable', (agent) => {
        expect(shouldSpawnHappyControllerInTmux({
            agent,
            tmuxAvailable: false,
            tmuxSessionName: 'happy',
        })).toBe(false);
    });

    it.each(['codex', 'gemini', 'openclaw'] as const)('disables tmux for %s when no session name is configured', (agent) => {
        expect(shouldSpawnHappyControllerInTmux({
            agent,
            tmuxAvailable: true,
            tmuxSessionName: undefined,
        })).toBe(false);
    });
});
