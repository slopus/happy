import { describe, expect, it } from 'vitest';
import { ToolCall } from '@/sync/typesMessage';
import { getTerminalToolCommand, isTerminalToolName, shouldRenderToolCardHeader } from './toolDisplay';

function tool(name: string, input: unknown): ToolCall {
    return {
        name,
        state: 'completed',
        input,
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
    };
}

describe('terminal tool display helpers', () => {
    it('detects command-like terminal tools', () => {
        expect(isTerminalToolName('Bash')).toBe(true);
        expect(isTerminalToolName('CodexBash')).toBe(true);
        expect(isTerminalToolName('GeminiBash')).toBe(true);
        expect(isTerminalToolName('execute')).toBe(true);
        expect(isTerminalToolName('Read')).toBe(false);
    });

    it('extracts one-line command summaries from shell tools', () => {
        expect(getTerminalToolCommand(tool('Bash', { command: 'pnpm test' }))).toBe('pnpm test');

        expect(getTerminalToolCommand(tool(
            'CodexBash',
            {
                command: ['/usr/bin/zsh', '-lc', 'git status --short'],
                parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
            },
        ))).toBe('git status --short');
    });

    it('extracts Gemini execute titles without cwd metadata', () => {
        expect(getTerminalToolCommand(tool(
            'execute',
            { toolCall: { title: 'rm tmp.txt [current working directory /repo] (cleanup)' } },
        ))).toBe('rm tmp.txt');
    });

    it('hides Codex patch card headers on web only', () => {
        expect(shouldRenderToolCardHeader('CodexPatch', 'web')).toBe(false);
        expect(shouldRenderToolCardHeader('CodexPatch', 'ios')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexPatch', 'android')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexBash', 'web')).toBe(true);
    });
});
