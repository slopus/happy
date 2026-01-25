import { describe, expect, it } from 'vitest';

import { extractShellCommand } from './shellCommand';

describe('extractShellCommand', () => {
    it('extracts a command from JSON-stringified ACP args', () => {
        const input = JSON.stringify({
            command: ['/bin/zsh', '-lc', 'echo hello'],
            cwd: '/tmp',
        });
        expect(extractShellCommand(input)).toBe('echo hello');
    });

    it('extracts a command from JSON-stringified simple args', () => {
        const input = JSON.stringify({ command: 'pwd' });
        expect(extractShellCommand(input)).toBe('pwd');
    });
});

