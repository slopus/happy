import { describe, expect, it } from 'vitest';
import { isTerminalInputReady } from './inputReadiness';

describe('isTerminalInputReady', () => {
    it('accepts a bare prompt at the terminal tail', () => {
        expect(isTerminalInputReady('>')).toBe(true);
        expect(isTerminalInputReady('Claude Code v2.1.153\n>')).toBe(true);
    });

    it('accepts the styled Claude prompt at the terminal tail', () => {
        expect(isTerminalInputReady('Claude Code v2.1.153\n❯')).toBe(true);
        expect(isTerminalInputReady('Claude Code v2.1.153\n❯ Try "fix lint errors"')).toBe(true);
    });

    it('ignores stale prompt lines followed by later output', () => {
        expect(isTerminalInputReady('>\nWorking on it...')).toBe(false);
        expect(isTerminalInputReady('❯ Try "fix lint errors"\nThinking...')).toBe(false);
    });

    it('does not treat markdown quote lines as readiness', () => {
        expect(isTerminalInputReady('> quoted text')).toBe(false);
        expect(isTerminalInputReady('assistant output\n> quoted text')).toBe(false);
    });

    it('does not treat rendered diff or test fixtures as readiness', () => {
        const output = [
            'diff --git a/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts b/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts',
            '--- a/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts',
            '+++ b/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts',
            "+        expect(classifyTerminalOutput('>')).toEqual({",
            "+            type: 'input_prompt_visible',",
            '+        });',
        ].join('\n');

        expect(isTerminalInputReady(output)).toBe(false);
    });

    it('rejects prompt-looking output while progress is still visible at the tail', () => {
        expect(isTerminalInputReady('12 tokens remaining\n❯ Try "keep going"')).toBe(false);
        expect(isTerminalInputReady('thinking...\n>')).toBe(false);
    });

    it('strips ANSI escapes before checking the terminal tail', () => {
        expect(isTerminalInputReady('\x1b[32m❯\x1b[0m')).toBe(true);
    });
});
