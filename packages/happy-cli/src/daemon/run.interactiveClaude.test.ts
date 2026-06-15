import { describe, expect, it } from 'vitest';
import {
    getHappyControllerTmuxAvailabilityProbeEnv,
    normalizeDaemonAgent,
    shouldProbeHappyControllerTmuxAvailability,
    shouldSpawnHappyControllerInTmux,
} from './run';

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

describe('shouldProbeHappyControllerTmuxAvailability', () => {
    it('does not probe tmux availability for Claude interactive remote even when tmux is configured', () => {
        expect(shouldProbeHappyControllerTmuxAvailability({
            agent: 'claude',
            tmuxSessionName: 'happy',
        })).toBe(false);
    });

    it.each(['codex', 'gemini', 'openclaw'] as const)('probes tmux availability for %s when tmux is configured', (agent) => {
        expect(shouldProbeHappyControllerTmuxAvailability({
            agent,
            tmuxSessionName: 'happy',
        })).toBe(true);
    });

    it.each(['claude', 'codex', 'gemini', 'openclaw'] as const)('does not probe tmux availability for %s when no session name is configured', (agent) => {
        expect(shouldProbeHappyControllerTmuxAvailability({
            agent,
            tmuxSessionName: undefined,
        })).toBe(false);
    });
});

describe('getHappyControllerTmuxAvailabilityProbeEnv', () => {
    it('keeps only sanitized tmux client environment for availability probing', () => {
        const sanitized = getHappyControllerTmuxAvailabilityProbeEnv({
            ANTHROPIC_API_KEY: 'anthropic-key',
            ANTHROPIC_BASE_URL: 'https://anthropic.example',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            CUSTOM_SECRET: 'custom-secret',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'reconnect-key',
            HAPPY_SERVER_URL: 'https://happy.example',
            HOME: '/Users/devdvlive',
            MCP_CONNECTION_NONBLOCKING: '1',
            PATH: '/opt/bin:/usr/bin',
            TMUX: '/tmp/tmux-501/default,123,0',
        });

        expect(sanitized).toEqual({
            HOME: '/Users/devdvlive',
            PATH: '/opt/bin:/usr/bin',
            TMUX: '/tmp/tmux-501/default,123,0',
        });
    });
});
