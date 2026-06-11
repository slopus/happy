/**
 * Unit tests for tmux utilities
 *
 * NOTE: These are pure unit tests that test parsing and validation logic.
 * They do NOT require tmux to be installed on the system.
 * All tests mock environment variables and test string parsing only.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    parseTmuxSessionIdentifier,
    formatTmuxSessionIdentifier,
    validateTmuxSessionIdentifier,
    buildTmuxSessionIdentifier,
    TmuxSessionIdentifierError,
    TmuxUtilities,
    type TmuxSessionIdentifier,
} from './tmux';

describe('parseTmuxSessionIdentifier', () => {
    it('should parse session-only identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session');
        expect(result).toEqual({
            session: 'my-session'
        });
    });

    it('should parse session:window identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1'
        });
    });

    it('should parse session:window.pane identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
    });

    it('should handle session names with dots, hyphens, and underscores', () => {
        const result = parseTmuxSessionIdentifier('my.test_session-1');
        expect(result).toEqual({
            session: 'my.test_session-1'
        });
    });

    it('should handle window names with hyphens and underscores', () => {
        const result = parseTmuxSessionIdentifier('session:my_test-window-1');
        expect(result).toEqual({
            session: 'session',
            window: 'my_test-window-1'
        });
    });

    it('should throw on empty string', () => {
        expect(() => parseTmuxSessionIdentifier('')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('')).toThrow('Session identifier must be a non-empty string');
    });

    it('should throw on null/undefined', () => {
        expect(() => parseTmuxSessionIdentifier(null as any)).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier(undefined as any)).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid session name characters', () => {
        expect(() => parseTmuxSessionIdentifier('invalid session')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('invalid session')).toThrow('Only alphanumeric characters, dots, hyphens, and underscores are allowed');
    });

    it('should throw on special characters in session name', () => {
        expect(() => parseTmuxSessionIdentifier('session@name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session#name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session$name')).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid window name characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:invalid window')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:invalid window')).toThrow('Only alphanumeric characters, dots, hyphens, and underscores are allowed');
    });

    it('should throw on non-numeric pane identifier', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow('Only numeric values are allowed');
    });

    it('should throw on pane identifier with special characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.1a')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.-1')).toThrow(TmuxSessionIdentifierError);
    });

    it('should trim whitespace from components', () => {
        const result = parseTmuxSessionIdentifier('session : window . 2');
        expect(result).toEqual({
            session: 'session',
            window: 'window',
            pane: '2'
        });
    });
});

describe('formatTmuxSessionIdentifier', () => {
    it('should format session-only identifier', () => {
        const identifier: TmuxSessionIdentifier = { session: 'my-session' };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should format session:window identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1');
    });

    it('should format session:window.pane identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1.2');
    });

    it('should ignore pane when window is not provided', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should throw when session is missing', () => {
        const identifier: TmuxSessionIdentifier = { session: '' };
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow(TmuxSessionIdentifierError);
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow('Session identifier must have a session name');
    });

    it('should handle complex valid names', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my.test_session-1:my_test-window-2.3');
    });
});

describe('validateTmuxSessionIdentifier', () => {
    it('should return valid:true for valid session-only identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window.pane identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:false for empty string', () => {
        const result = validateTmuxSessionIdentifier('');
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('should return valid:false for invalid session characters', () => {
        const result = validateTmuxSessionIdentifier('invalid session');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid window characters', () => {
        const result = validateTmuxSessionIdentifier('session:invalid window');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid pane identifier', () => {
        const result = validateTmuxSessionIdentifier('session:window.abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only numeric values are allowed');
    });

    it('should handle complex valid identifiers', () => {
        const result = validateTmuxSessionIdentifier('my.test_session-1:my_test-window-2.3');
        expect(result).toEqual({ valid: true });
    });

    it('should not throw exceptions', () => {
        expect(() => validateTmuxSessionIdentifier('')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier('invalid session')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier(null as any)).not.toThrow();
    });
});

describe('buildTmuxSessionIdentifier', () => {
    it('should build session-only identifier', () => {
        const result = buildTmuxSessionIdentifier({ session: 'my-session' });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session'
        });
    });

    it('should build session:window identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1'
        });
    });

    it('should build session:window.pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1.2'
        });
    });

    it('should return error for empty session name', () => {
        const result = buildTmuxSessionIdentifier({ session: '' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid session characters', () => {
        const result = buildTmuxSessionIdentifier({ session: 'invalid session' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid window characters', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'invalid window'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid window name');
    });

    it('should return error for invalid pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'window',
            pane: 'abc'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid pane identifier');
    });

    it('should handle complex valid inputs', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my.test_session-1:my_test-window-2.3'
        });
    });

    it('should not throw exceptions for invalid inputs', () => {
        expect(() => buildTmuxSessionIdentifier({ session: '' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: 'invalid session' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: null as any })).not.toThrow();
    });
});

describe('TmuxUtilities.detectTmuxEnvironment', () => {
    const originalTmuxEnv = process.env.TMUX;

    // Helper to set and restore environment
    const withTmuxEnv = (value: string | undefined, fn: () => void) => {
        process.env.TMUX = value;
        try {
            fn();
        } finally {
            if (originalTmuxEnv !== undefined) {
                process.env.TMUX = originalTmuxEnv;
            } else {
                delete process.env.TMUX;
            }
        }
    };

    it('should return null when TMUX env is not set', () => {
        withTmuxEnv(undefined, () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should parse valid TMUX environment variable', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: '4219',
                window: '0',
                pane: '0',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should parse TMUX env with session.window format', () => {
        withTmuxEnv('/tmp/tmux-1000/default,mysession.mywindow,2', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'mysession',
                window: 'mywindow',
                pane: '2',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle TMUX env without session.window format', () => {
        withTmuxEnv('/tmp/tmux-1000/default,session123,1', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'session123',
                window: '0',
                pane: '1',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle complex socket paths correctly', () => {
        // CRITICAL: Test that path parsing works with the fixed array indexing
        withTmuxEnv('/tmp/tmux-1000/my-socket,5678,3', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: '5678',
                window: '0',
                pane: '3',
                socket_path: '/tmp/tmux-1000/my-socket'
            });
        });
    });

    it('should handle socket path with multiple slashes', () => {
        // Test the array indexing fix - ensure we get the last component correctly
        withTmuxEnv('/var/run/tmux/1000/default,session.window,0', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'session',
                window: 'window',
                pane: '0',
                socket_path: '/var/run/tmux/1000/default'
            });
        });
    });

    it('should return null for malformed TMUX env (too few parts)', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should return null for malformed TMUX env (empty string)', () => {
        withTmuxEnv('', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should handle TMUX env with extra parts (more than 3 comma-separated values)', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0,extra', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            // Should still parse the first 3 parts correctly
            expect(result).toEqual({
                session: '4219',
                window: '0',
                pane: '0',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle edge case with dots in session identifier', () => {
        withTmuxEnv('/tmp/tmux-1000/default,my.session.name.5,2', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            // Split on dot, so my.session becomes session=my, window=session
            expect(result).toEqual({
                session: 'my',
                window: 'session',
                pane: '2',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });
});

describe('Round-trip consistency', () => {
    it('should parse and format consistently for session-only', () => {
        const original = 'my-session';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window', () => {
        const original = 'my-session:window-1';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window.pane', () => {
        const original = 'my-session:window-1.2';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should build and parse consistently', () => {
        const params = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        const built = buildTmuxSessionIdentifier(params);
        expect(built.success).toBe(true);
        const parsed = parseTmuxSessionIdentifier(built.identifier!);
        expect(parsed).toEqual(params);
    });
});

describe('TmuxUtilities terminal helpers', () => {
    it('returns stable tmux ids when spawning a new window', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockImplementation(async (cmd) => {
            const tmuxCommand = cmd as string[];
            if (tmuxCommand.includes('new-window')) {
                return {
                    returncode: 0,
                    stdout: '123\t@42\t%7\n',
                    stderr: '',
                    command: tmuxCommand,
                };
            }

            return {
                returncode: 0,
                stdout: '',
                stderr: '',
                command: tmuxCommand,
            };
        });

        const result = await utils.spawnInTmux(['claude'], {
            cwd: '/tmp/project',
            sessionName: 'happy',
            windowName: 'happy-claude-test',
        });
        const calls = executeCommand.mock.calls.map(([cmd]) => cmd as string[]);
        const newWindowCall = calls.find((cmd) => cmd.includes('new-window'));

        expect(result).toEqual({
            success: true,
            sessionId: 'happy:happy-claude-test',
            pid: 123,
            windowId: '@42',
            paneId: '%7',
        });
        expect(newWindowCall).toContain('-P');
        expect(newWindowCall).toContain('-F');
        expect(newWindowCall).toContain('#{pane_pid}\t#{window_id}\t#{pane_id}');

        const printIndex = newWindowCall!.indexOf('-P');
        const formatIndex = newWindowCall!.indexOf('-F');
        const commandIndex = newWindowCall!.indexOf('claude');
        expect(printIndex).toBeLessThan(commandIndex);
        expect(formatIndex).toBeLessThan(commandIndex);
    });

    it('pastes text through a tmux buffer instead of send-keys', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockResolvedValue({
            returncode: 0,
            stdout: '',
            stderr: '',
            command: [],
        });

        const text = 'first line\nsecond line';
        const result = await utils.pasteText(text, 'session', 'window', '2');
        const calls = executeCommand.mock.calls.map(([cmd]) => cmd as string[]);
        const bufferName = calls[0][3];

        expect(result).toBe(true);
        expect(bufferName).toMatch(/^happy-paste-/);
        expect(calls).toEqual([
            ['tmux', 'set-buffer', '-b', bufferName, text],
            ['tmux', 'paste-buffer', '-b', bufferName, '-t', 'session:window.2'],
            ['tmux', 'delete-buffer', '-b', bufferName],
        ]);
        expect(calls.flat()).not.toContain('send-keys');
    });

    it('uses raw pane ids directly for pane operations', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockResolvedValue({
            returncode: 0,
            stdout: '',
            stderr: '',
            command: [],
        });

        const result = await utils.pasteText('hello', undefined, undefined, '%7');
        const calls = executeCommand.mock.calls.map(([cmd]) => cmd as string[]);
        const bufferName = calls[0][3];

        expect(result).toBe(true);
        expect(calls).toEqual([
            ['tmux', 'set-buffer', '-b', bufferName, 'hello'],
            ['tmux', 'paste-buffer', '-b', bufferName, '-t', '%7'],
            ['tmux', 'delete-buffer', '-b', bufferName],
        ]);
    });

    it('targets resize-pane with the requested dimensions', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockResolvedValue({
            returncode: 0,
            stdout: '',
            stderr: '',
            command: [],
        });

        const result = await utils.resizePane(120, 40, 'session', 'window', '2');

        expect(result).toBe(true);
        expect(executeCommand).toHaveBeenCalledWith([
            'tmux',
            'resize-pane',
            '-x',
            '120',
            '-y',
            '40',
            '-t',
            'session:window.2',
        ]);
    });

    it('checks pane liveness with display-message against the requested target', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockResolvedValue({
            returncode: 0,
            stdout: '%1\n',
            stderr: '',
            command: [],
        });

        const result = await utils.isPaneAlive('session', 'window', '2');

        expect(result).toBe(true);
        expect(executeCommand).toHaveBeenCalledWith([
            'tmux',
            'display-message',
            '-p',
            '#{pane_id}',
            '-t',
            'session:window.2',
        ]);
    });

    it('targets a full session:window identifier when killing a window', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockResolvedValue({
            returncode: 0,
            stdout: '',
            stderr: '',
            command: [],
        });

        const result = await utils.killWindow('happy:claude');

        expect(result).toBe(true);
        expect(executeCommand).toHaveBeenCalledWith([
            'tmux',
            'kill-window',
            '-t',
            'happy:claude',
        ]);
    });

    it('uses raw window ids directly when killing a window', async () => {
        const utils = new TmuxUtilities('happy');
        const executeCommand = vi.spyOn(utils as any, 'executeCommand').mockResolvedValue({
            returncode: 0,
            stdout: '',
            stderr: '',
            command: [],
        });

        const result = await utils.killWindow('@42');

        expect(result).toBe(true);
        expect(executeCommand).toHaveBeenCalledWith([
            'tmux',
            'kill-window',
            '-t',
            '@42',
        ]);
    });
});
