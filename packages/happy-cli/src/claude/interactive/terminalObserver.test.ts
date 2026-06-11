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
});

describe('sanitizeTerminalDiagnostic', () => {
    it('redacts paths secrets and urls', () => {
        expect(sanitizeTerminalDiagnostic('failed /Users/me/secret sk-ant-api03-abc https://example.com/x')).toBe(
            'failed [path] [secret] [url]',
        );
    });
});
