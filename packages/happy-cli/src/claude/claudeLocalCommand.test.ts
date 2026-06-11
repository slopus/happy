import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { buildClaudeLocalCommand, claudeCliPath } from './claudeLocalCommand';

const {
    mockEnsureLocalProxyBypass,
    mockInitializeSandbox,
    mockWrapCommand,
    mockSandboxCleanup,
} = vi.hoisted(() => ({
    mockEnsureLocalProxyBypass: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapCommand: vi.fn(),
    mockSandboxCleanup: vi.fn(),
}));

vi.mock('./utils/systemPrompt', () => ({
    systemPrompt: 'test-system-prompt',
}));

vi.mock('./utils/proxyBypass', () => ({
    ensureLocalProxyBypass: mockEnsureLocalProxyBypass,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapCommand: mockWrapCommand,
}));

vi.mock('@/projectPath', () => ({
    projectPath: () => '/repo',
}));

vi.mock('node:fs', () => ({
    existsSync: vi.fn(() => true),
}));

describe('buildClaudeLocalCommand', () => {
    const sandboxConfig: SandboxConfig = {
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
    };

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.HAPPY_COMMAND_TEST_PARENT;
        process.env.HAPPY_COMMAND_TEST_PARENT = 'from-process';
        mockEnsureLocalProxyBypass.mockImplementation((env: Record<string, string | undefined>) => {
            env.NO_PROXY = 'localhost';
            env.no_proxy = 'localhost';
        });
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapCommand.mockResolvedValue('sandbox wrapped claude command');
    });

    afterEach(() => {
        delete process.env.HAPPY_COMMAND_TEST_PARENT;
    });

    it('builds the local launcher command with session args, prompt, MCP, tools, settings, cwd, and env', async () => {
        const mcpServers = {
            happy: {
                command: 'node',
                args: ['server.js'],
            },
        };

        const command = await buildClaudeLocalCommand({
            path: '/tmp/workspace',
            sessionArgs: ['--resume', 'session-123'],
            claudeArgs: ['--model', 'claude-opus-4-1'],
            mcpServers,
            allowedTools: ['Read', 'mcp__happy__change_title'],
            claudeEnvVars: {
                HAPPY_COMMAND_TEST_PARENT: 'from-claude-env',
                CLAUDE_CODE_OAUTH_TOKEN: 'token',
            },
            hookSettingsPath: '/tmp/settings.json',
        });

        expect(command.command).toBe('node');
        expect(command.args).toEqual([
            claudeCliPath,
            '--resume',
            'session-123',
            '--append-system-prompt',
            'test-system-prompt',
            '--mcp-config',
            JSON.stringify({ mcpServers }),
            '--allowedTools',
            'Read,mcp__happy__change_title',
            '--model',
            'claude-opus-4-1',
            '--settings',
            '/tmp/settings.json',
        ]);
        expect(command.cwd).toBe('/tmp/workspace');
        expect(command.shell).toBe(false);
        expect(command.cleanupSandbox).toBeNull();
        expect(command.env.HAPPY_COMMAND_TEST_PARENT).toBe('from-claude-env');
        expect(command.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token');
        expect(command.env.NO_PROXY).toBe('localhost');
        expect(command.env.no_proxy).toBe('localhost');
        expect(mockEnsureLocalProxyBypass).toHaveBeenCalledWith(command.env);
    });

    it('wraps sandboxed launches and adds dangerous skip permissions exactly once', async () => {
        const command = await buildClaudeLocalCommand({
            path: '/tmp/workspace',
            sessionArgs: ['--session-id', 'new-session'],
            claudeArgs: [],
            sandboxConfig,
        });

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, '/tmp/workspace');
        expect(mockWrapCommand).toHaveBeenCalledTimes(1);
        const wrappedInput = mockWrapCommand.mock.calls[0][0] as string;
        expect(wrappedInput.startsWith('node ')).toBe(true);
        expect(wrappedInput).toContain(`'${claudeCliPath}'`);
        expect((wrappedInput.match(/--dangerously-skip-permissions/g) ?? []).length).toBe(1);
        expect(command).toEqual({
            command: 'sandbox wrapped claude command',
            args: [],
            cwd: '/tmp/workspace',
            env: expect.any(Object),
            shell: true,
            cleanupSandbox: mockSandboxCleanup,
        });
    });

    it('falls back to the non-sandbox command when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox failed'));

        const command = await buildClaudeLocalCommand({
            path: '/tmp/workspace',
            sessionArgs: ['--session-id', 'new-session'],
            claudeArgs: [],
            sandboxConfig,
        });

        expect(mockWrapCommand).not.toHaveBeenCalled();
        expect(command.command).toBe('node');
        expect(command.args).toContain(claudeCliPath);
        expect(command.args).not.toContain('--dangerously-skip-permissions');
        expect(command.shell).toBe(false);
        expect(command.cleanupSandbox).toBeNull();
    });

    it('cleans up initialized sandbox when command wrapping fails before falling back', async () => {
        mockWrapCommand.mockRejectedValue(new Error('wrap failed'));

        const command = await buildClaudeLocalCommand({
            path: '/tmp/workspace',
            sessionArgs: ['--session-id', 'new-session'],
            claudeArgs: [],
            sandboxConfig,
        });

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(command.command).toBe('node');
        expect(command.args).toContain(claudeCliPath);
        expect(command.args).not.toContain('--dangerously-skip-permissions');
        expect(command.shell).toBe(false);
        expect(command.cleanupSandbox).toBeNull();
    });
});
