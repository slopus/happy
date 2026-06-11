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

    it('reports the styled Claude Code input prompt', () => {
        expect(classifyTerminalOutput('❯ Try "fix lint errors"')).toEqual({
            type: 'input_prompt_visible',
            message: 'Claude is ready for input.',
        });
    });

    it('does not treat Claude MCP status text as a terminal process error', () => {
        const output = [
            'Claude Code v2.1.153',
            '1 MCP server failed · /mcp',
            '────────────────────────────────────────────────────────────────────────────────',
            '❯ Try "how does activityUpdateAccumulator.test.ts work?"',
        ].join('\n');

        expect(classifyTerminalOutput(output)).toEqual({
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

    it('redacts spaced macOS paths from terminal error diagnostics', () => {
        const rawPath = '/Users/me/Library/Application Support/Claude/log.txt';
        const result = classifyTerminalOutput(`failed ${rawPath}`);

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path]',
        });
        expect(result?.message).toContain('[path]');
        expect(result?.message).not.toContain('Application Support');
        expect(result?.message).not.toContain('Claude/log.txt');
        expect(result?.message).not.toContain('Library/Application Support/Claude/log.txt');
    });

    it('redacts paths ending with spaced directory components from terminal error diagnostics', () => {
        const result = classifyTerminalOutput('failed /Users/me/Library/Application Support with ENOENT');

        expect(result?.type).toBe('terminal_process_error');
        expect(result?.message).toContain('[path]');
        expect(result?.message).toContain('ENOENT');
        expect(result?.message).not.toContain('Application');
        expect(result?.message).not.toContain('Support');
        expect(result?.message).not.toContain('/Users/me');
        expect(result?.message).not.toContain('/Users/me/Library/Application Support');
        expect(result?.message).not.toContain('Library/Application Support');
    });

    it('preserves diagnostic codes after redacting file paths', () => {
        const result = classifyTerminalOutput('failed /Users/me/file.txt with ENOENT');

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path] with ENOENT',
        });
        expect(result?.message).not.toContain('/Users/me');
        expect(result?.message).not.toContain('file.txt');
    });

    it('preserves diagnostic codes after redacting spaced directory paths', () => {
        const result = classifyTerminalOutput('failed /Users/me/Library/Application Support because ENOENT');

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path] because ENOENT',
        });
        expect(result?.message).not.toContain('/Users/me');
        expect(result?.message).not.toContain('Application');
        expect(result?.message).not.toContain('Support');
    });

    it('preserves colon diagnostic codes after redacting file paths', () => {
        const result = classifyTerminalOutput('failed /Users/me/file.txt: ENOENT');

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path]: ENOENT',
        });
        expect(result?.message).toContain('[path]');
        expect(result?.message).toContain('ENOENT');
        expect(result?.message).not.toContain('/Users/me');
        expect(result?.message).not.toContain('file.txt');
    });

    it('preserves permission diagnostics after redacting file paths', () => {
        const result = classifyTerminalOutput('failed /Users/me/file.txt with permission denied');

        expect(result).toEqual({
            type: 'terminal_process_error',
            message: 'Terminal reported an error. failed [path] with permission denied',
        });
        expect(result?.message).toContain('[path]');
        expect(result?.message).toContain('permission denied');
        expect(result?.message).not.toContain('/Users/me');
        expect(result?.message).not.toContain('file.txt');
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

    it('redacts paths ending with spaced directory components', () => {
        const result = sanitizeTerminalDiagnostic('failed /Users/me/Library/Application Support with ENOENT');

        expect(result).toContain('[path]');
        expect(result).toContain('ENOENT');
        expect(result).not.toContain('Application');
        expect(result).not.toContain('Support');
        expect(result).not.toContain('/Users/me');
        expect(result).not.toContain('/Users/me/Library/Application Support');
        expect(result).not.toContain('Library/Application Support');
    });

    it('preserves diagnostic codes after redacting file paths', () => {
        const result = sanitizeTerminalDiagnostic('failed /Users/me/file.txt with ENOENT');

        expect(result).toBe('failed [path] with ENOENT');
        expect(result).not.toContain('/Users/me');
        expect(result).not.toContain('file.txt');
    });

    it('preserves diagnostic codes after redacting spaced directory paths', () => {
        const result = sanitizeTerminalDiagnostic('failed /Users/me/Library/Application Support because ENOENT');

        expect(result).toBe('failed [path] because ENOENT');
        expect(result).not.toContain('/Users/me');
        expect(result).not.toContain('Application');
        expect(result).not.toContain('Support');
    });

    it('preserves colon diagnostic codes after redacting file paths', () => {
        const result = sanitizeTerminalDiagnostic('failed /Users/me/file.txt: ENOENT');

        expect(result).toBe('failed [path]: ENOENT');
        expect(result).toContain('[path]');
        expect(result).toContain('ENOENT');
        expect(result).not.toContain('/Users/me');
        expect(result).not.toContain('file.txt');
    });

    it('preserves permission diagnostics after redacting file paths', () => {
        const result = sanitizeTerminalDiagnostic('failed /Users/me/file.txt with permission denied');

        expect(result).toBe('failed [path] with permission denied');
        expect(result).toContain('[path]');
        expect(result).toContain('permission denied');
        expect(result).not.toContain('/Users/me');
        expect(result).not.toContain('file.txt');
    });
});
