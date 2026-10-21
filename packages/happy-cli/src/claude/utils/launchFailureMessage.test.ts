import { describe, it, expect } from 'vitest';
import { launchFailureMessage, MAX_LAUNCH_FAILURE_DETAIL } from './launchFailureMessage';

describe('launchFailureMessage', () => {
    describe('without a usable detail it falls back to the bare notice', () => {
        it('handles a non-Error throwable', () => {
            expect(launchFailureMessage('boom')).toBe('Process exited unexpectedly');
        });

        it('handles undefined', () => {
            expect(launchFailureMessage(undefined)).toBe('Process exited unexpectedly');
        });

        it('handles an Error with an empty message', () => {
            expect(launchFailureMessage(new Error('   '))).toBe('Process exited unexpectedly');
        });
    });

    describe('with an Error it appends the message', () => {
        it('surfaces the SDK native-binary failure that is otherwise invisible', () => {
            const error = new Error(
                'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.'
            );
            expect(launchFailureMessage(error)).toBe(
                'Process exited unexpectedly: Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.'
            );
        });

        it('collapses newlines so the client renders a single line', () => {
            expect(launchFailureMessage(new Error('first line\n\n  second line'))).toBe(
                'Process exited unexpectedly: first line second line'
            );
        });

        it('strips ANSI colors and control characters from child-process output', () => {
            const error = new Error(
                '\u001b[31mError:\u001b[0m spawn failed\u0007\nsee \u001b[1mlogs\u001b[22m'
            );
            expect(launchFailureMessage(error)).toBe(
                'Process exited unexpectedly: Error: spawn failed see logs'
            );
        });

        it('falls back to the bare notice when the message is only ANSI noise', () => {
            expect(launchFailureMessage(new Error('\u001b[2J\u001b[H'))).toBe(
                'Process exited unexpectedly'
            );
        });
    });

    describe('a model the bundled Claude Code is too old for', () => {
        const hint = 'App sessions use the Claude Code bundled with Happy; update it with `npm i -g happy@latest`.';

        it('points at updating Happy, since `claude update` does not touch the bundled copy', () => {
            // Verbatim from the Agent SDK 0.3.260 remote path asked for claude-opus-5-5.
            const error = new Error(
                "Claude Code returned an error result: API Error: 400 Claude Code 2.1.260 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again."
            );
            expect(launchFailureMessage(error)).toBe(
                "Process exited unexpectedly: Claude Code returned an error result: API Error: 400 Claude Code 2.1.260 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again. " + hint
            );
        });

        it('keeps the hint when the detail itself is truncated', () => {
            const error = new Error(`version 2.1.280 or newer is required ${'z'.repeat(MAX_LAUNCH_FAILURE_DETAIL)}`);
            expect(launchFailureMessage(error).endsWith(`… ${hint}`)).toBe(true);
        });

        it('leaves unrelated failures without the hint', () => {
            expect(launchFailureMessage(new Error('spawn ENOENT'))).not.toContain('happy@latest');
        });
    });

    describe('long messages are truncated', () => {
        it('caps the detail and marks the cut', () => {
            const result = launchFailureMessage(new Error('x'.repeat(MAX_LAUNCH_FAILURE_DETAIL + 50)));
            expect(result).toBe(`Process exited unexpectedly: ${'x'.repeat(MAX_LAUNCH_FAILURE_DETAIL)}…`);
        });

        it('leaves a detail at exactly the cap untouched', () => {
            const detail = 'y'.repeat(MAX_LAUNCH_FAILURE_DETAIL);
            expect(launchFailureMessage(new Error(detail))).toBe(`Process exited unexpectedly: ${detail}`);
        });
    });
});
