import { describe, expect, it } from 'vitest';

import { extractCodexPassthroughArgs, extractCodexResumeFlag } from './cliArgs';

describe('extractCodexResumeFlag', () => {
    it('returns null and preserves args when resume flag is absent', () => {
        const parsed = extractCodexResumeFlag(['--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit resume thread ID', () => {
        const parsed = extractCodexResumeFlag(['--resume', 'thread-123', '--started-by', 'daemon']);

        expect(parsed.resumeThreadId).toBe('thread-123');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('supports equals syntax', () => {
        const parsed = extractCodexResumeFlag(['--resume=thread-456', '--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBe('thread-456');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('throws when resume flag is missing a thread ID', () => {
        expect(() => extractCodexResumeFlag(['--resume'])).toThrow(
            'Codex resume requires a thread ID: happy codex --resume <thread-id>',
        );
    });
});

describe('extractCodexPassthroughArgs', () => {
    it('preserves all args as Happy args when delimiter is absent', () => {
        const parsed = extractCodexPassthroughArgs(['--resume', 'thread-123', '--model', 'gpt-5.5']);

        expect(parsed).toEqual({
            happyArgs: ['--resume', 'thread-123', '--model', 'gpt-5.5'],
            codexArgs: [],
        });
    });

    it('splits Codex args after the first delimiter', () => {
        const parsed = extractCodexPassthroughArgs([
            '--started-by',
            'terminal',
            '--',
            '--dangerously-bypass-approvals-and-sandbox',
            '--config',
            'model="gpt-5.5"',
        ]);

        expect(parsed).toEqual({
            happyArgs: ['--started-by', 'terminal'],
            codexArgs: ['--dangerously-bypass-approvals-and-sandbox', '--config', 'model="gpt-5.5"'],
        });
    });

    it('keeps later delimiters in the Codex args', () => {
        const parsed = extractCodexPassthroughArgs(['--', '--config', 'foo=bar', '--', 'value']);

        expect(parsed).toEqual({
            happyArgs: [],
            codexArgs: ['--config', 'foo=bar', '--', 'value'],
        });
    });
});
