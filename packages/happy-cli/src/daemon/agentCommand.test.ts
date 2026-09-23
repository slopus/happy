import { describe, expect, it } from 'vitest';
import { resolveDaemonAgentCommand, UnsupportedAgentError } from './agentCommand';

describe('resolveDaemonAgentCommand', () => {
    it('maps every spawnable agent to its subcommand', () => {
        expect(resolveDaemonAgentCommand('claude')).toBe('claude');
        expect(resolveDaemonAgentCommand('codex')).toBe('codex');
        expect(resolveDaemonAgentCommand('gemini')).toBe('gemini');
        expect(resolveDaemonAgentCommand('opencode')).toBe('opencode');
        expect(resolveDaemonAgentCommand('openclaw')).toBe('openclaw');
        expect(resolveDaemonAgentCommand('agy')).toBe('agy');
    });

    it('treats an absent agent as Claude, as both spawn paths always have', () => {
        expect(resolveDaemonAgentCommand(undefined)).toBe('claude');
    });

    it('refuses an unknown agent instead of quietly starting Claude', () => {
        // The tmux spawn path used to end a ternary chain with 'claude', so a
        // newer app asking for an agent this CLI does not know started the
        // wrong agent with no error. Both paths now fail loudly and alike.
        expect(() => resolveDaemonAgentCommand('nope-agent' as never)).toThrow(UnsupportedAgentError);
        expect(() => resolveDaemonAgentCommand('' as never)).toThrow(UnsupportedAgentError);
    });

    it('names the agent and the remedy in the error', () => {
        expect(() => resolveDaemonAgentCommand('nope' as never))
            .toThrow("Unsupported agent type: 'nope'. Please update your CLI to the latest version.");
    });
});
