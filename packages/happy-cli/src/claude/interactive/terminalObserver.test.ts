import { describe, expect, it } from 'vitest';
import { classifyTerminalOutput, sanitizeTerminalDiagnostic } from './terminalObserver';

describe('classifyTerminalOutput', () => {
    it('reports usage or auth errors without returning raw terminal text', () => {
        expect(classifyTerminalOutput('Claude AI usage limit reached|1799999999')).toEqual({
            type: 'usage_or_auth_error',
            message: 'Claude reported a usage or authentication problem.',
        });
    });

    it('reports permission prompts without returning raw terminal text', () => {
        expect(classifyTerminalOutput('Do you want to allow Bash?')).toEqual({
            type: 'permission_prompt_visible',
            message: 'Claude is asking for permission.',
        });
    });

    it('ignores ordinary output', () => {
        expect(classifyTerminalOutput('Working on it...')).toBeNull();
    });

    it('reports spinner output when only token progress is visible', () => {
        expect(classifyTerminalOutput('12 tokens remaining')).toEqual({
            type: 'spinner_without_transcript',
            message: 'Claude appears to be running but has not emitted transcript output yet.',
        });
    });

    it('reports spinner output when thinking text is visible', () => {
        expect(classifyTerminalOutput('thinking...')).toEqual({
            type: 'spinner_without_transcript',
            message: 'Claude appears to be running but has not emitted transcript output yet.',
        });
    });

    it('reports the input prompt when a bare prompt is visible', () => {
        expect(classifyTerminalOutput('>')).toEqual({
            type: 'input_prompt_visible',
            message: 'Claude is ready for input.',
        });
    });

    it('reports terminal errors with sanitized diagnostics', () => {
        const result = classifyTerminalOutput('failed /Users/me/secret sk-ant-api03-abc https://example.com/x');

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path] [secret] [url]',
        });
        expect(result?.message).not.toContain('/Users/me/secret');
        expect(result?.message).not.toContain('sk-ant-api03-abc');
        expect(result?.message).not.toContain('https://example.com/x');
    });

    it('prioritizes terminal errors over token progress output', () => {
        expect(classifyTerminalOutput('Error: failed to spawn Claude; 12 tokens remaining')).toMatchObject({
            type: 'terminal_process_error',
        });
    });

    it('prioritizes terminal errors over visible input prompts', () => {
        expect(classifyTerminalOutput('permission denied\n>')).toMatchObject({
            type: 'terminal_process_error',
        });
    });

    it('redacts macOS application paths from terminal error diagnostics', () => {
        const result = classifyTerminalOutput('failed /Applications/Claude.app/Contents/MacOS/Claude');

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path]',
        });
        expect(result?.message).toContain('[path]');
        expect(result?.message).not.toContain('/Applications/Claude.app/Contents/MacOS/Claude');
    });
});

describe('sanitizeTerminalDiagnostic', () => {
    it('redacts paths secrets and urls', () => {
        expect(sanitizeTerminalDiagnostic('failed /Users/me/secret sk-ant-api03-abc https://example.com/x')).toBe(
            'failed [path] [secret] [url]',
        );
    });

    it('bounds sanitized diagnostics to 240 characters', () => {
        const result = sanitizeTerminalDiagnostic('detail '.repeat(80));

        expect(result.length).toBeLessThanOrEqual(240);
        expect(result).toMatch(/\.\.\.$/);
    });
});
