import { afterEach, describe, expect, it, vi } from 'vitest';
import * as highlighter from '../engine/highlight';
import { codeSyntaxSpans, MAX_CODE_SYNTAX_SPANS, planCodeSyntax } from './code';
import { MAX_SYNTAX_CHARACTERS, MAX_SYNTAX_LINE, MAX_SYNTAX_LINES } from './protocol';
import { tokenize } from './tokenize';

afterEach(() => vi.restoreAllMocks());

describe('terminal/code syntax preparation', () => {
    it('uses the shared content/language cache key, independent of the screen and theme', () => {
        const first = planCodeSyntax('echo "$HOME"\n', 'bash')[0];
        expect(planCodeSyntax('echo "$HOME"\n', 'bash')[0].key).toBe(first.key);
        expect(planCodeSyntax('echo "$HOME"\n', 'shell-session')[0].key).not.toBe(first.key);
        expect(first.input.lines.every((line) => line.type === 'ctx')).toBe(true);
    });

    it.each([
        ['', 'bash'], ['echo hi', null],
        ['x'.repeat(MAX_SYNTAX_LINE + 1), 'bash'],
        ['\n'.repeat(MAX_SYNTAX_LINES), 'bash'],
        ['x'.repeat(MAX_SYNTAX_CHARACTERS + 1), 'bash'],
    ])('does not enqueue empty, disabled or oversized code (%#)', (code, language) => {
        expect(planCodeSyntax(code!, language)).toEqual([]);
    });

    it('tokenizes a contiguous code block once, preserving CRLF, Unicode and trailing whitespace', () => {
        const code = '# comment\r\nprintf "%s\\n" "🙂"  \r\n\r\n';
        const { input } = planCodeSyntax(code, 'bash')[0];
        const highlight = vi.spyOn(highlighter, 'highlightLines');
        const result = tokenize(input);
        expect(highlight).toHaveBeenCalledTimes(1);
        expect(highlight).toHaveBeenCalledWith(code, 'bash');
        const spans = codeSyntaxSpans(input, { status: result.status, result });
        expect(spans?.map((span) => span.t).join('')).toBe(code);
        expect(spans?.some((span) => span.k !== 'plain')).toBe(true);
    });

    it('keeps multiline shell context instead of tokenizing each line independently', () => {
        const { input } = planCodeSyntax('cat <<EOF\nhello $USER\nEOF\n', 'bash')[0];
        const result = tokenize(input);
        const spans = codeSyntaxSpans(input, { status: result.status, result });
        expect(result.runs[1].some((run) => run.k === 'string')).toBe(true);
        expect(spans?.map((span) => span.t).join('')).toBe('cat <<EOF\nhello $USER\nEOF\n');
    });

    it('uses shell-session grammar for output, without painting ordinary logs as commands', () => {
        const { input } = planCodeSyntax('$ echo "hello"\nhello\nif 123 true\n', 'shell-session')[0];
        const result = tokenize(input);
        expect(result.runs[0].some((run) => run.k === 'string')).toBe(true);
        expect(result.runs.slice(1).flat().every((run) => run.k === 'plain')).toBe(true);
        expect(codeSyntaxSpans(input, { status: result.status, result })?.map((span) => span.t).join(''))
            .toBe(input.lines.map((line) => line.text).join('\n'));
    });

    it('falls back to one plain Text for unsupported output and excessive native span counts', () => {
        const { input } = planCodeSyntax('ordinary output\n', 'shell-session')[0];
        const result = tokenize(input);
        expect(codeSyntaxSpans(input, { status: result.status, result })).toBeNull();
        expect(codeSyntaxSpans(input, { status: 'timeout' })).toBeNull();
        const lines = Array.from({ length: MAX_CODE_SYNTAX_SPANS }, () => ({ text: 'x', type: 'ctx' as const }));
        expect(codeSyntaxSpans({ language: 'bash', lines }, {
            status: 'highlighted', result: {
                status: 'highlighted', computeMs: 1,
                runs: lines.map(() => [{ k: 'keyword', n: 1 }]),
            },
        })).toBeNull();
    });
});