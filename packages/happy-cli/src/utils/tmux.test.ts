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

describe('TmuxUtilities command compatibility', () => {
    it('should not append duplicate -t when command already includes target', async () => {
        const utils = new TmuxUtilities();
        const runSpy = vi.spyOn(utils as any, 'runCommand').mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: ''
        });

        await utils.executeTmuxCommand(
            ['new-window', '-t', 'happy', '-n', 'win-1', 'echo ok'],
            'ignored-session'
        );

        expect(runSpy).toHaveBeenCalledTimes(1);
        const fullCmd = runSpy.mock.calls[0][0] as string[];
        expect(fullCmd.filter((part) => part === '-t')).toHaveLength(1);
        runSpy.mockRestore();
    });

    it('should pass -e env values without embedding shell quotes', async () => {
        const utils = new TmuxUtilities();
        const calls: string[][] = [];
        const execSpy = vi.spyOn(utils as any, 'executeTmuxCommand').mockImplementation(
            async (...mockArgs: unknown[]) => {
                const cmd = mockArgs[0] as string[];
                calls.push(cmd);
                if (cmd[0] === 'list-sessions') {
                    return { returncode: 0, stdout: 'happy\n', stderr: '', command: cmd };
                }
                if (cmd[0] === 'has-session') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }
                if (cmd[0] === 'new-window') {
                    return { returncode: 0, stdout: '123\n', stderr: '', command: cmd };
                }
                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        );

        const result = await utils.spawnInTmux(
            ['echo hi'],
            { sessionName: 'happy', windowName: 'win-1' },
            { HOME: '/Users/test user' }
        );

        expect(result.success).toBe(true);
        expect(result.pid).toBe(123);

        const newWindowCall = calls.find((cmd) => cmd[0] === 'new-window');
        expect(newWindowCall).toBeDefined();
        expect(newWindowCall?.some((part) => part.startsWith('HOME=/Users/test user'))).toBe(true);
        expect(newWindowCall?.some((part) => part.includes('HOME="'))).toBe(false);

        execSpy.mockRestore();
    });

    it('should target new-window with session: form to avoid index collisions', async () => {
        const utils = new TmuxUtilities();
        const calls: string[][] = [];
        const execSpy = vi.spyOn(utils as any, 'executeTmuxCommand').mockImplementation(
            async (...mockArgs: unknown[]) => {
                const cmd = mockArgs[0] as string[];
                calls.push(cmd);
                if (cmd[0] === 'list-sessions') {
                    return { returncode: 0, stdout: 'happy\n', stderr: '', command: cmd };
                }
                if (cmd[0] === 'has-session') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }
                if (cmd[0] === 'new-window') {
                    return { returncode: 0, stdout: '321\n', stderr: '', command: cmd };
                }
                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        );

        const result = await utils.spawnInTmux(
            ['echo hi'],
            { sessionName: 'happy', windowName: 'win-target' }
        );

        expect(result.success).toBe(true);
        expect(result.pid).toBe(321);

        const newWindowCall = calls.find((cmd) => cmd[0] === 'new-window');
        expect(newWindowCall).toBeDefined();
        const targetIndex = newWindowCall!.indexOf('-t');
        expect(targetIndex).toBeGreaterThanOrEqual(0);
        expect(newWindowCall![targetIndex + 1]).toBe('happy:');

        execSpy.mockRestore();
    });

    it('should fall back to list-panes when new-window does not output pane pid', async () => {
        const utils = new TmuxUtilities();
        const execSpy = vi.spyOn(utils as any, 'executeTmuxCommand').mockImplementation(
            async (...mockArgs: unknown[]) => {
                const cmd = mockArgs[0] as string[];
                if (cmd[0] === 'list-sessions') {
                    return { returncode: 0, stdout: 'happy\n', stderr: '', command: cmd };
                }
                if (cmd[0] === 'has-session') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }
                if (cmd[0] === 'new-window') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }
                if (cmd[0] === 'list-panes') {
                    return { returncode: 0, stdout: '456\n', stderr: '', command: cmd };
                }
                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        );

        const result = await utils.spawnInTmux(
            ['echo hi'],
            { sessionName: 'happy', windowName: 'win-2' }
        );

        expect(result.success).toBe(true);
        expect(result.pid).toBe(456);
        execSpy.mockRestore();
    });

    it('should fall back to session-level env injection when new-window -e is unsupported', async () => {
        const utils = new TmuxUtilities();
        const calls: string[][] = [];
        const execSpy = vi.spyOn(utils as any, 'executeTmuxCommand').mockImplementation(
            async (...mockArgs: unknown[]) => {
                const cmd = mockArgs[0] as string[];
                calls.push(cmd);

                if (cmd[0] === 'list-sessions') {
                    return { returncode: 0, stdout: 'happy\n', stderr: '', command: cmd };
                }
                if (cmd[0] === 'has-session') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }
                if (cmd[0] === 'new-window') {
                    // Simulate older tmux that doesn't support -e
                    if (cmd.includes('-e')) {
                        return { returncode: 1, stdout: '', stderr: 'unknown option -- e', command: cmd };
                    }
                    return { returncode: 0, stdout: '789\n', stderr: '', command: cmd };
                }
                if (cmd[0] === 'show-environment') {
                    return { returncode: 0, stdout: '-HOME\n', stderr: '', command: cmd };
                }
                if (cmd[0] === 'set-environment') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }
                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        );

        const result = await utils.spawnInTmux(
            ['echo hi'],
            { sessionName: 'happy', windowName: 'legacy-win' },
            { HOME: '/Users/test' }
        );

        expect(result.success).toBe(true);
        expect(result.pid).toBe(789);

        const newWindowCalls = calls.filter((cmd) => cmd[0] === 'new-window');
        expect(newWindowCalls.length).toBeGreaterThanOrEqual(3);
        expect(newWindowCalls[0].includes('-e')).toBe(true);
        expect(newWindowCalls[1].includes('-e')).toBe(true);
        expect(newWindowCalls[newWindowCalls.length - 1].includes('-e')).toBe(false);
        expect(calls.some((cmd) => cmd[0] === 'set-environment')).toBe(true);

        execSpy.mockRestore();
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
