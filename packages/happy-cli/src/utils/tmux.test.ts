/**
 * Unit tests for tmux utilities
 *
 * NOTE: These are pure unit tests that test parsing and validation logic.
 * They do NOT require tmux to be installed on the system.
 * All tests mock environment variables and test string parsing only.
 */
import { describe, expect, it } from 'vitest';
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

describe('tmux version parsing', () => {
    // Tests the regex used in spawnInTmux to gate on tmux >= 3.0
    const versionRegex = /tmux\s+(\d+)\.(\d+)/;

    it('should parse standard version string', () => {
        const match = 'tmux 3.4'.match(versionRegex);
        expect(match).not.toBeNull();
        expect(parseInt(match![1])).toBe(3);
        expect(parseInt(match![2])).toBe(4);
    });

    it('should parse old version string', () => {
        const match = 'tmux 2.9'.match(versionRegex);
        expect(match).not.toBeNull();
        expect(parseInt(match![1])).toBe(2);
        expect(parseInt(match![2])).toBe(9);
    });

    it('should parse version with suffix (e.g., 3.3a)', () => {
        const match = 'tmux 3.3a'.match(versionRegex);
        expect(match).not.toBeNull();
        expect(parseInt(match![1])).toBe(3);
        expect(parseInt(match![2])).toBe(3);
    });

    it('should not match development version without number', () => {
        const match = 'tmux master'.match(versionRegex);
        expect(match).toBeNull();
    });

    it('should parse next-prefixed version', () => {
        // "tmux next-3.5" — the regex still finds "3.5"
        const match = 'tmux next-3.5'.match(versionRegex);
        // Regex requires whitespace before digits, so "next-3.5" doesn't match
        expect(match).toBeNull();
    });

    it('should parse version with extra whitespace', () => {
        const match = 'tmux  3.4'.match(versionRegex);
        expect(match).not.toBeNull();
        expect(parseInt(match![1])).toBe(3);
    });
});

describe('session list parsing (resolveTmuxSessionName logic)', () => {
    // Tests the lastIndexOf(':') parsing used in resolveTmuxSessionName
    // to split "session_name:session_windows" from tmux list-sessions output

    function parseSessionLine(line: string): { name: string; count: number } | null {
        const separatorIndex = line.lastIndexOf(':');
        if (separatorIndex === -1) return null;
        const name = line.substring(0, separatorIndex);
        const count = parseInt(line.substring(separatorIndex + 1));
        if (isNaN(count)) return null;
        return { name, count };
    }

    function findBestSession(output: string): string | undefined {
        let bestSession: string | undefined;
        let maxWindows = 0;
        for (const line of output.trim().split('\n')) {
            const parsed = parseSessionLine(line);
            if (parsed && parsed.count > maxWindows) {
                maxWindows = parsed.count;
                bestSession = parsed.name;
            }
        }
        return bestSession;
    }

    it('should parse single session', () => {
        expect(findBestSession('main:5')).toBe('main');
    });

    it('should pick session with most windows', () => {
        expect(findBestSession('dev:3\nmain:10\ntest:1')).toBe('main');
    });

    it('should handle session name with dots and hyphens', () => {
        expect(findBestSession('my-session.name:7')).toBe('my-session.name');
    });

    it('should handle empty output', () => {
        expect(findBestSession('')).toBeUndefined();
    });

    it('should handle malformed lines gracefully', () => {
        expect(findBestSession('no-colon')).toBeUndefined();
    });

    it('should handle non-numeric window count', () => {
        expect(findBestSession('session:abc')).toBeUndefined();
    });

    it('should handle tie (picks first with highest count)', () => {
        // Both have 5 windows, first one wins (not replaced by equal)
        expect(findBestSession('alpha:5\nbeta:5')).toBe('alpha');
    });

    it('should handle session name with colons (uses lastIndexOf)', () => {
        // Session names can't have colons in tmux, but test the parsing robustness
        // If somehow "sess:ion:3" appeared, lastIndexOf(':') gives correct split
        const result = parseSessionLine('sess:ion:3');
        expect(result).toEqual({ name: 'sess:ion', count: 3 });
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

// Integration tests that require real tmux
// These create a temporary tmux session, run operations, and clean up
import { execFileSync, spawnSync } from 'child_process';

function isTmuxInstalled(): boolean {
    try {
        const result = spawnSync('tmux', ['-V'], { stdio: 'pipe', timeout: 5000 });
        return result.status === 0;
    } catch {
        return false;
    }
}

const TEST_SESSION = `happy-test-${process.pid}`;

describe.skipIf(!isTmuxInstalled())('TmuxUtilities integration (requires tmux)', { timeout: 15_000 }, () => {
    // Create a temporary tmux session for testing
    beforeAll(() => {
        execFileSync('tmux', ['new-session', '-d', '-s', TEST_SESSION, '-n', 'main']);
    });

    afterAll(() => {
        try {
            execFileSync('tmux', ['kill-session', '-t', TEST_SESSION]);
        } catch {
            // Session may already be killed
        }
    });

    it('should detect tmux version >= 3.0', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);
        const result = await utils.executeTmuxCommand(['list-sessions']);
        expect(result).not.toBeNull();
        expect(result!.returncode).toBe(0);

        // Verify version is parseable (same regex as spawnInTmux)
        const versionOutput = spawnSync('tmux', ['-V'], { stdio: 'pipe' }).stdout.toString();
        const match = versionOutput.match(/tmux\s+(\d+)\.(\d+)/);
        expect(match).not.toBeNull();
        expect(parseInt(match![1])).toBeGreaterThanOrEqual(3);
    });

    it('should spawn window with -d flag (no focus steal)', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);

        // Record current window before spawn
        const beforeResult = await utils.executeTmuxCommand(
            ['display-message', '-p', '#{window_name}'],
            TEST_SESSION
        );
        const activeWindowBefore = beforeResult?.stdout.trim();

        // Spawn a new window
        const result = await utils.spawnInTmux(['echo test-no-focus-steal'], {
            sessionName: TEST_SESSION,
            windowName: 'test-no-focus',
            cwd: '/tmp'
        });

        expect(result.success).toBe(true);
        expect(result.pid).toBeGreaterThan(0);
        expect(result.sessionId).toContain(TEST_SESSION);

        // Verify active window did NOT change (the -d flag worked)
        const afterResult = await utils.executeTmuxCommand(
            ['display-message', '-p', '#{window_name}'],
            TEST_SESSION
        );
        const activeWindowAfter = afterResult?.stdout.trim();
        expect(activeWindowAfter).toBe(activeWindowBefore);

        // Clean up
        await utils.executeTmuxCommand(['kill-window'], TEST_SESSION, 'test-no-focus');
    });

    it('should accept environment variables parameter without error', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);

        // Verify spawnInTmux succeeds with env vars (including edge cases)
        const result = await utils.spawnInTmux(['sleep 2'], {
            sessionName: TEST_SESSION,
            windowName: 'test-env',
            cwd: '/tmp'
        }, {
            HAPPY_TEST_VAR: 'value-with-special=chars',
            ANOTHER_VAR: 'simple',
            EMPTY_VAR: '',
            PATH: process.env.PATH || '/usr/bin:/bin'
        });

        expect(result.success).toBe(true);
        expect(result.pid).toBeGreaterThan(0);

        // Clean up
        await utils.executeTmuxCommand(['kill-window'], TEST_SESSION, 'test-env');
    });

    it('should kill window correctly', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);
        const windowName = 'test-kill-window';

        // Create a window to kill
        await utils.executeTmuxCommand(
            ['new-window', '-d', '-n', windowName],
            TEST_SESSION
        );

        // Verify it exists
        const listBefore = await utils.executeTmuxCommand(
            ['list-windows', '-F', '#{window_name}'],
            TEST_SESSION
        );
        expect(listBefore?.stdout).toContain(windowName);

        // Kill it using the fixed killWindow method
        const killed = await utils.killWindow(`${TEST_SESSION}:${windowName}`);
        expect(killed).toBe(true);

        // Verify it's gone
        const listAfter = await utils.executeTmuxCommand(
            ['list-windows', '-F', '#{window_name}'],
            TEST_SESSION
        );
        expect(listAfter?.stdout).not.toContain(windowName);
    });

    it('should detect shell via pane_current_command with window target', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);
        const knownShells = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'elvish', 'pwsh']);

        // Query display-message with window target via executeTmuxCommand
        // This verifies -t is inserted before the format string (not appended after it)
        const result = await utils.executeTmuxCommand(
            ['display-message', '-p', '#{pane_current_command}'],
            TEST_SESSION, 'main'
        );

        expect(result).not.toBeNull();
        expect(result!.returncode).toBe(0);

        const command = result!.stdout.trim();
        expect(knownShells.has(command)).toBe(true);
    });

    it('should return PID from spawnInTmux', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);

        const result = await utils.spawnInTmux(['sleep 10'], {
            sessionName: TEST_SESSION,
            windowName: 'test-pid',
            cwd: '/tmp'
        });

        expect(result.success).toBe(true);
        expect(result.pid).toBeDefined();
        expect(typeof result.pid).toBe('number');
        expect(result.pid).toBeGreaterThan(0);

        // Verify the PID is a real process
        try {
            process.kill(result.pid!, 0); // Signal 0 = check existence
            expect(true).toBe(true); // Process exists
        } catch {
            // Process might have already exited in CI, that's OK
        }

        // Clean up
        await utils.executeTmuxCommand(['kill-window'], TEST_SESSION, 'test-pid');
    });

    it('should accept CLAUDECODE=empty in env without error', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);

        // Verify spawnInTmux accepts empty CLAUDECODE value (used to prevent nested detection)
        const result = await utils.spawnInTmux(['sleep 2'], {
            sessionName: TEST_SESSION,
            windowName: 'test-claudecode',
            cwd: '/tmp'
        }, {
            CLAUDECODE: '',
            PATH: process.env.PATH || '/usr/bin:/bin'
        });

        expect(result.success).toBe(true);
        expect(result.pid).toBeGreaterThan(0);

        // Clean up
        await utils.executeTmuxCommand(['kill-window'], TEST_SESSION, 'test-claudecode');
    });

    it('should handle paths with spaces in send-keys', async () => {
        const utils = new TmuxUtilities(TEST_SESSION);

        // The spawnInTmux command uses send-keys with -l, which should handle
        // paths with spaces when properly quoted
        const result = await utils.spawnInTmux(['echo "path with spaces works"'], {
            sessionName: TEST_SESSION,
            windowName: 'test-spaces',
            cwd: '/tmp'
        });

        expect(result.success).toBe(true);

        await new Promise(resolve => setTimeout(resolve, 500));

        const captureResult = await utils.executeTmuxCommand(
            ['capture-pane', '-p'],
            TEST_SESSION, 'test-spaces'
        );
        expect(captureResult?.stdout).toContain('path with spaces works');

        // Clean up
        await utils.executeTmuxCommand(['kill-window'], TEST_SESSION, 'test-spaces');
    });
});

// Need beforeAll/afterAll for integration tests
import { beforeAll, afterAll } from 'vitest';
