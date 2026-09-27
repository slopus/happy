import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: sdkQuery,
}));

import { query } from './query';

describe('query adapter', () => {
    let configDirectory: string;
    beforeEach(() => {
        sdkQuery.mockClear();
        configDirectory = mkdtempSync(join(tmpdir(), 'happy-plugin-config-'));
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDirectory);
        vi.stubEnv('HAPPY_CLAUDE_PATH', undefined);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(configDirectory, { recursive: true, force: true });
    });

    function lastOptions(): Record<string, unknown> {
        return (sdkQuery.mock.calls as unknown as [{ options: Record<string, unknown> }][]).at(-1)![0].options;
    }

    it('uses the SDK bundled executable unless a local path is explicitly configured', () => {
        query({ prompt: 'continue' });
        expect(lastOptions().pathToClaudeCodeExecutable).toBeUndefined();
    });

    it('resolves an explicit executable symlink and preserves resume and sandbox spawning', () => {
        const executable = join(configDirectory, 'claude');
        symlinkSync(process.execPath, executable);
        vi.stubEnv('HAPPY_CLAUDE_PATH', executable);
        const spawnClaudeCodeProcess = vi.fn();
        const sandbox = { enabled: true, failIfUnavailable: true };
        query({ prompt: 'continue', options: {
            resume: 'existing-session', model: 'claude-opus-5-5', effort: 'low',
            spawnClaudeCodeProcess, sandbox,
        } });
        const options = lastOptions();
        expect(options.pathToClaudeCodeExecutable).toBe(realpathSync(process.execPath));
        expect(options.resume).toBe('existing-session');
        expect(options.model).toBe('claude-opus-5-5');
        expect(options.effort).toBe('low');
        expect(options.spawnClaudeCodeProcess).toBe(spawnClaudeCodeProcess);
        expect(options.sandbox).toEqual(sandbox);
    });

    it('accepts a readable JavaScript CLI entrypoint without requiring native execute permissions', () => {
        const executable = join(configDirectory, 'cli.js');
        writeFileSync(executable, '// CLI entrypoint', { mode: 0o600 });
        vi.stubEnv('HAPPY_CLAUDE_PATH', executable);
        query({ prompt: 'continue' });
        expect(lastOptions().pathToClaudeCodeExecutable).toBe(realpathSync(executable));
    });

    it.each(['', 'claude', './claude', '/missing/claude', 'bad\0path'])(
        'rejects invalid explicit path %j without falling back or invoking the SDK', (path) => {
            vi.stubEnv('HAPPY_CLAUDE_PATH', path);
            expect(() => query({ prompt: 'continue' })).toThrow(/HAPPY_CLAUDE_PATH/);
            expect(sdkQuery.mock.calls.length).toBe(0);
        },
    );

    it('rejects directories and non-executable native files', () => {
        vi.stubEnv('HAPPY_CLAUDE_PATH', configDirectory);
        expect(() => query({ prompt: 'continue' })).toThrow(/HAPPY_CLAUDE_PATH/);
        if (process.platform !== 'win32') {
            const executable = join(configDirectory, 'claude');
            writeFileSync(executable, 'not executable', { mode: 0o600 });
            vi.stubEnv('HAPPY_CLAUDE_PATH', executable);
            expect(() => query({ prompt: 'continue' })).toThrow(/HAPPY_CLAUDE_PATH/);
        }
        expect(sdkQuery.mock.calls.length).toBe(0);
    });

    function writePlugin(servers: Record<string, unknown>, name = 'sales') {
        const directory = join(configDirectory, 'plugins', 'synced', 'account', name);
        mkdirSync(join(directory, '.claude-plugin'), { recursive: true });
        writeFileSync(join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
        const config = join(directory, '.mcp.json');
        writeFileSync(config, JSON.stringify({ mcpServers: servers }));
        return config;
    }

    function sdkSettings() {
        const calls = sdkQuery.mock.calls as unknown as Array<Array<any>>;
        return JSON.parse(calls.at(-1)![0].options.settings);
    }

    it('excludes only synced HTTP/SSE plugins with blank URLs before starting the SDK', () => {
        const config = writePlugin({
            gmail: { type: 'http', url: '' },
            calendar: { type: 'sse', url: '  \n' },
            configured: { type: 'http', url: 'https://example.com/mcp' },
            stdio: { command: 'node', args: ['server.js'] },
            missing: { type: 'http' },
        });
        const original = readFileSync(config, 'utf8');
        const mcpServers = { gmail: { type: 'http' as const, url: 'https://gateway.example/mcp' } };
        query({ prompt: 'continue', options: { mcpServers } });
        expect(sdkSettings().deniedMcpServers).toEqual([
            { serverName: 'plugin:sales:gmail' },
            { serverName: 'plugin:sales:calendar' },
        ]);
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ mcpServers }),
        }));
        expect(readFileSync(config, 'utf8')).toBe(original);
    });

    it('preserves hook settings, existing MCP exclusions and tool deny rules', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        const settingsPath = join(configDirectory, 'hooks.json');
        const hooks = { SessionStart: [{ matcher: '*' }] };
        writeFileSync(settingsPath, JSON.stringify({ hooks, deniedMcpServers: [{ serverName: 'blocked' }] }));
        query({ prompt: 'continue', options: { settingsPath, permissionsDeny: ['Read(/private/**)'] } });
        expect(sdkSettings()).toEqual({
            hooks,
            deniedMcpServers: [{ serverName: 'blocked' }, { serverName: 'plugin:sales:gmail' }],
            permissions: { deny: ['Read(/private/**)'] },
        });
    });

    it('allows a repaired plugin URL on the next query instead of persisting a disable flag', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        query({ prompt: 'continue' });
        expect(sdkSettings().deniedMcpServers).toHaveLength(1);
        writePlugin({ gmail: { type: 'http', url: 'https://example.com/mcp' } });
        query({ prompt: 'continue' });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('keeps usable definitions when another account caches the same server with a blank URL', () => {
        writePlugin({ gmail: { type: 'http', url: '' }, calendar: { type: 'http', url: '' } });
        const other = join(configDirectory, 'plugins', 'synced', 'other-account', 'sales');
        mkdirSync(join(other, '.claude-plugin'), { recursive: true });
        writeFileSync(join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sales' }));
        writeFileSync(join(other, '.mcp.json'), JSON.stringify({
            gmail: { type: 'http', url: 'https://example.com/mcp' },
            calendar: { type: 'http', url: '' },
        }));
        query({ prompt: 'continue' });
        expect(sdkSettings().deniedMcpServers).toEqual([{ serverName: 'plugin:sales:calendar' }]);
    });

    it('does not exclude explicitly supplied servers with the same name as a synced placeholder', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        query({ prompt: 'continue', options: { mcpServers: {
            'plugin:sales:gmail': { type: 'http', url: 'https://example.com/mcp' },
        } } });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('leaves an ambiguous plugin alone when another account has custom MCP definitions', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        const other = join(configDirectory, 'plugins', 'synced', 'other-account', 'sales', '.claude-plugin');
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, 'plugin.json'), JSON.stringify({ name: 'sales', mcpServers: './other.json' }));
        query({ prompt: 'continue' });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('does not guess exclusions from malformed files or custom manifest MCP definitions', () => {
        const malformed = writePlugin({ gmail: { type: 'http', url: '' } });
        writeFileSync(malformed, '{');
        const custom = writePlugin({ gmail: { type: 'http', url: '' } }, 'custom');
        writeFileSync(join(custom, '..', '.claude-plugin', 'plugin.json'), JSON.stringify({
            name: 'custom', mcpServers: './configured-mcp.json',
        }));
        query({ prompt: 'continue' });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('forwards the built-in tool allowance, including the empty list that disables them', () => {
        query({ prompt: 'continue', options: { tools: [] } });
        // 빈 배열은 "전부 끈다" 는 뜻이다. 여기서 흘리면 관리 실행의 도구 경계가
        // SDK 까지 도달하지 못한다.
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: [] }),
        }));

        sdkQuery.mockClear();
        query({ prompt: 'continue', options: { tools: ['Read'] } });
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: ['Read'] }),
        }));
    });

    it('forwards prompt suggestion enablement to the Claude Agent SDK', () => {
        query({
            prompt: 'continue',
            options: { promptSuggestions: true },
        });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                promptSuggestions: true,
            }),
        }));
    });

    it('enables partial assistant message streaming so the app can render tokens before a block completes', () => {
        query({ prompt: 'continue', options: {} });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ includePartialMessages: true }),
        }));
    });

    it('forwards additional directories to the Claude Agent SDK for new and resumed queries', () => {
        for (const resume of [undefined, 'claude-session-id']) {
            query({
                prompt: 'continue',
                options: {
                    additionalDirectories: ['/repo/frontend', '/repo/backend'],
                    resume,
                },
            });
        }

        expect(sdkQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: undefined,
            }),
        }));
        expect(sdkQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: 'claude-session-id',
            }),
        }));
    });

    it('forwards fail-closed sandbox settings to the Claude Agent SDK', () => {
        const sandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: ['/project/**/.env*'] },
        };

        query({ prompt: 'edit', options: { sandbox } });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ sandbox }),
        }));
    });

    it('inlines hook settings when sandbox settings must be merged by the SDK', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-settings-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        const sandbox = { enabled: true, failIfUnavailable: true };
        try {
            query({ prompt: 'edit', options: { settingsPath, sandbox } });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(typeof settings).toBe('string');
            expect(JSON.parse(settings as string)).toEqual(hooks);
            expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({ sandbox }),
            }));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // SDK 의 sandbox 는 주로 Bash 실행 경계다. Read/Edit 같은 도구는 CLI 의 권한
    // 규칙으로 막아야 하므로, 공유 머신에서는 두 층을 함께 내려보낸다.
    it('merges deny rules into the inlined settings so tool reads are blocked too', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        try {
            query({
                prompt: 'edit',
                options: {
                    settingsPath,
                    sandbox: { enabled: true, failIfUnavailable: true },
                    permissionsDeny: ['Read(/root/.happy/**)', 'Edit(/root/.happy/**)'],
                },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            const parsed = JSON.parse(settings as string);
            expect(parsed.hooks).toEqual(hooks.hooks);
            expect(parsed.permissions.deny).toEqual([
                'Read(/root/.happy/**)',
                'Edit(/root/.happy/**)',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // 규칙만 있고 sandbox 가 없어도 규칙은 반드시 내려가야 한다 — 경로로 넘기면
    // SDK 가 그 파일을 읽고 우리 규칙은 사라진다.
    it('inlines settings for deny rules even without sandbox settings', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-only-'));
        const settingsPath = join(directory, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({}));
        try {
            query({
                prompt: 'edit',
                options: { settingsPath, permissionsDeny: ['Read(/root/.happy/**)'] },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(JSON.parse(settings as string).permissions.deny).toEqual(['Read(/root/.happy/**)']);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps existing deny rules from the settings file', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-merge-'));
        const settingsPath = join(directory, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
        try {
            query({
                prompt: 'edit',
                options: { settingsPath, permissionsDeny: ['Read(/root/.happy/**)'] },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(JSON.parse(settings as string).permissions.deny).toEqual([
                'Bash(rm:*)',
                'Read(/root/.happy/**)',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
