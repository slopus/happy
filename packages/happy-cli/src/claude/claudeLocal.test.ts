import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claudeLocal } from './claudeLocal';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const {
    mockSpawn,
    mockClaudeFindLastSession,
    mockInitializeSandbox,
    mockWrapCommand,
    mockSandboxCleanup,
} = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockClaudeFindLastSession: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapCommand: vi.fn(),
    mockSandboxCleanup: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: mockSpawn
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    }
}));

vi.mock('./utils/claudeFindLastSession', () => ({
    claudeFindLastSession: mockClaudeFindLastSession
}));

vi.mock('./utils/path', () => ({
    getProjectPath: vi.fn((path: string) => path)
}));

vi.mock('./utils/systemPrompt', () => ({
    systemPrompt: 'test-system-prompt'
}));

vi.mock('node:fs', () => ({
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true)
}));

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: vi.fn(() => true) // Always return true (session exists)
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapCommand: mockWrapCommand,
}));

describe('claudeLocal --continue handling', () => {
    let onSessionFound: any;

    beforeEach(() => {
        // Mock spawn to resolve immediately
        mockSpawn.mockReturnValue({
            stdio: [null, null, null, null],
            on: vi.fn((event, callback) => {
                // Immediately call the 'exit' callback
                if (event === 'exit') {
                    process.nextTick(() => callback(0));
                }
            }),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            kill: vi.fn(),
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            stdin: {
                on: vi.fn(),
                end: vi.fn()
            }
        });

        onSessionFound = vi.fn();

        // Reset mocks
        vi.clearAllMocks();
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapCommand.mockResolvedValue('wrapped claude command');
    });

    it('should convert --continue to --resume with last session ID', async () => {
        // Mock claudeFindLastSession to return a session ID
        mockClaudeFindLastSession.mockReturnValue('123e4567-e89b-12d3-a456-426614174000');

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue'] // User wants to continue last session
        });

        // Verify spawn was called
        expect(mockSpawn).toHaveBeenCalled();

        // Get the args passed to spawn (second argument is the array)
        const spawnArgs = mockSpawn.mock.calls[0][1];

        // Should NOT contain --continue (converted to --resume)
        expect(spawnArgs).not.toContain('--continue');

        // Should NOT contain --session-id (no conflict)
        expect(spawnArgs).not.toContain('--session-id');

        // Should contain --resume with the found session ID
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('123e4567-e89b-12d3-a456-426614174000');

        // Should notify about the session
        expect(onSessionFound).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000');
    });

    it('should create new session when --continue but no sessions exist', async () => {
        // Mock claudeFindLastSession to return null (no sessions)
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: ['--continue']
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];

        // Should contain --session-id for new session
        expect(spawnArgs).toContain('--session-id');

        // Should not contain --resume or --continue
        expect(spawnArgs).not.toContain('--resume');
        expect(spawnArgs).not.toContain('--continue');
    });

    it('should add --session-id for normal new sessions without --continue', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [] // No session flags - new session
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--session-id');
        expect(spawnArgs).not.toContain('--continue');
        expect(spawnArgs).not.toContain('--resume');
    });

    it('should handle --resume with specific session ID without conflict', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: 'existing-session-123',
            path: '/tmp',
            onSessionFound,
            claudeArgs: [] // No --continue
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('existing-session-123');
        expect(spawnArgs).not.toContain('--session-id');
    });

    it('should remove --continue from claudeArgs after conversion', async () => {
        mockClaudeFindLastSession.mockReturnValue('session-456');

        const claudeArgs = ['--continue', '--other-flag'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        // Verify spawn was called without --continue (it gets converted to --resume)
        const spawnArgs = mockSpawn.mock.calls[0][1];
        expect(spawnArgs).not.toContain('--continue');
        expect(spawnArgs).toContain('--other-flag');
    });

    it('should pass --resume to Claude when no session ID provided', async () => {
        const claudeArgs = ['--resume'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        // --resume should still be in spawn args (NOT extracted)
        const spawnArgs = mockSpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--resume');
        // Should NOT have auto-found session ID
        expect(spawnArgs).not.toContain('--session-id');
    });

    it('should extract and use --resume <id> when session ID is provided', async () => {
        mockClaudeFindLastSession.mockReturnValue(null);
        const claudeArgs = ['--resume', 'abc-123-def'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        // Should use provided ID in spawn args
        const spawnArgs = mockSpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('--resume');
        expect(spawnArgs).toContain('abc-123-def');
        // Should NOT add --session-id (resume takes precedence)
        expect(spawnArgs).not.toContain('--session-id');
        // Should notify about the session being resumed
        expect(onSessionFound).toHaveBeenCalledWith('abc-123-def');
    });

    it('should handle -r short flag same as --resume', async () => {
        const claudeArgs = ['-r'];

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs
        });

        const spawnArgs = mockSpawn.mock.calls[0][1];
        expect(spawnArgs).toContain('-r');
    });

    it('should initialize sandbox, wrap command, and cleanup on exit', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp/workspace',
            onSessionFound,
            claudeArgs: [],
            sandboxConfig: {
                enabled: true,
                workspaceRoot: '~/projects',
                sessionIsolation: 'workspace',
                customWritePaths: [],
                denyReadPaths: ['~/.ssh'],
                extraWritePaths: ['/tmp'],
                denyWritePaths: ['.env'],
                networkMode: 'allowed',
                allowedDomains: [],
                deniedDomains: [],
                allowLocalBinding: true,
            },
        });

        expect(mockInitializeSandbox).toHaveBeenCalledWith(
            expect.objectContaining({ enabled: true }),
            '/tmp/workspace',
        );
        expect(mockWrapCommand).toHaveBeenCalledWith(expect.stringContaining('--dangerously-skip-permissions'));
        expect(mockSpawn).toHaveBeenCalledWith(
            'wrapped claude command',
            [],
            expect.objectContaining({ shell: true, cwd: '/tmp/workspace' }),
        );
        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
    });

    it('should continue without sandbox when initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox failed'));

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [],
            sandboxConfig: {
                enabled: true,
                sessionIsolation: 'workspace',
                customWritePaths: [],
                denyReadPaths: ['~/.ssh'],
                extraWritePaths: ['/tmp'],
                denyWritePaths: ['.env'],
                networkMode: 'allowed',
                allowedDomains: [],
                deniedDomains: [],
                allowLocalBinding: true,
            },
        });

        expect(mockWrapCommand).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'node',
            expect.any(Array),
            expect.objectContaining({ shell: false }),
        );
        const spawnedArgs = mockSpawn.mock.calls[0][1];
        expect(spawnedArgs).not.toContain('--dangerously-skip-permissions');
    });
});

describe('claudeLocal - environment variable stripping', () => {
    let onSessionFound: any;
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset process.env with test values
        process.env = {
            ...originalEnv,
            ANTHROPIC_API_KEY: 'inherited-api-key',
            ANTHROPIC_AUTH_TOKEN: 'inherited-auth-token',
            CLAUDE_CODE_OAUTH_TOKEN: 'inherited-oauth-token',
            PATH: '/usr/bin',
            HOME: '/home/user',
            CUSTOM_VAR: 'custom-value',
        };

        // Mock spawn to capture the env passed to it
        mockSpawn.mockReturnValue({
            stdio: [null, null, null, null],
            on: vi.fn((event, callback) => {
                if (event === 'exit') {
                    process.nextTick(() => callback(0));
                }
            }),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            kill: vi.fn(),
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            stdin: {
                on: vi.fn(),
                end: vi.fn()
            }
        });

        onSessionFound = vi.fn();
        vi.clearAllMocks();
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapCommand.mockResolvedValue('wrapped claude command');
    });

    afterEach(() => {
        // Restore original process.env
        process.env = originalEnv;
    });

    it('should strip inherited auth vars when not explicitly set in claudeEnvVars', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [],
            claudeEnvVars: { CUSTOM_OVERRIDE: 'override-value' }
        });

        const spawnCall = mockSpawn.mock.calls[0];
        const spawnedEnv = spawnCall[2].env;

        // Auth vars should be stripped
        expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(spawnedEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(spawnedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

        // Other vars should pass through
        expect(spawnedEnv.PATH).toBe('/usr/bin');
        expect(spawnedEnv.HOME).toBe('/home/user');
        expect(spawnedEnv.CUSTOM_VAR).toBe('custom-value');

        // Explicitly set vars should be present
        expect(spawnedEnv.CUSTOM_OVERRIDE).toBe('override-value');
    });

    it('should preserve auth vars when explicitly set in claudeEnvVars', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [],
            claudeEnvVars: {
                ANTHROPIC_API_KEY: 'explicit-api-key',
                ANTHROPIC_AUTH_TOKEN: 'explicit-auth-token'
            }
        });

        const spawnCall = mockSpawn.mock.calls[0];
        const spawnedEnv = spawnCall[2].env;

        // Explicitly set auth vars should be present (from claudeEnvVars)
        expect(spawnedEnv.ANTHROPIC_API_KEY).toBe('explicit-api-key');
        expect(spawnedEnv.ANTHROPIC_AUTH_TOKEN).toBe('explicit-auth-token');

        // Oauth token not explicitly set should still be stripped
        expect(spawnedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

        // Other vars should pass through
        expect(spawnedEnv.PATH).toBe('/usr/bin');
    });

    it('should handle empty claudeEnvVars gracefully', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [],
            claudeEnvVars: undefined
        });

        const spawnCall = mockSpawn.mock.calls[0];
        const spawnedEnv = spawnCall[2].env;

        // Auth vars should be stripped with undefined claudeEnvVars
        expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(spawnedEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(spawnedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

        // Other vars should pass through
        expect(spawnedEnv.PATH).toBe('/usr/bin');
        expect(spawnedEnv.CUSTOM_VAR).toBe('custom-value');
    });

    it('should strip only the auth vars, not others with similar names', async () => {
        process.env = {
            ...process.env,
            ANTHROPIC_API_KEY: 'should-be-stripped',
            ANTHROPIC_OTHER_VAR: 'should-remain',
            AUTH_TOKEN: 'should-remain',
            CLAUDE_OTHER: 'should-remain',
        };

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [],
        });

        const spawnCall = mockSpawn.mock.calls[0];
        const spawnedEnv = spawnCall[2].env;

        // Only exact matches should be stripped
        expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(spawnedEnv.ANTHROPIC_OTHER_VAR).toBe('should-remain');
        expect(spawnedEnv.AUTH_TOKEN).toBe('should-remain');
        expect(spawnedEnv.CLAUDE_OTHER).toBe('should-remain');
    });

    it('should log when stripping auth vars', async () => {
        const { logger } = await import('@/ui/logger');
        const debugSpy = vi.spyOn(logger, 'debug');

        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/tmp',
            onSessionFound,
            claudeArgs: [],
        });

        // Should have logged stripping of inherited auth vars
        const stripLogs = debugSpy.mock.calls.filter(
            (call: any[]) => call[0]?.includes('Stripping inherited') && call[0]?.includes('from env')
        );
        expect(stripLogs.length).toBeGreaterThan(0);
        expect(stripLogs.some((call: any[]) => call[0]?.includes('ANTHROPIC_API_KEY'))).toBe(true);
    });
});
