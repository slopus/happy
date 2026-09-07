import { describe, expect, it } from 'vitest';
import { codexMcpListEntriesToThreadConfig } from './codexMcpConfig';

describe('codexMcpListEntriesToThreadConfig', () => {
    it('converts enabled HTTP MCP servers', () => {
        expect(codexMcpListEntriesToThreadConfig([
            {
                name: 'paper',
                enabled: true,
                transport: {
                    type: 'streamable_http',
                    url: 'http://127.0.0.1:29979/mcp',
                    bearer_token_env_var: null,
                    http_headers: null,
                    env_http_headers: null,
                },
                startup_timeout_sec: 3,
                tool_timeout_sec: 30,
            },
        ])).toEqual({
            paper: {
                url: 'http://127.0.0.1:29979/mcp',
                startup_timeout_sec: 3,
                tool_timeout_sec: 30,
            },
        });
    });

    it('converts stdio MCP servers and skips disabled servers', () => {
        expect(codexMcpListEntriesToThreadConfig([
            {
                name: 'local',
                enabled: true,
                transport: {
                    type: 'stdio',
                    command: 'node',
                    args: ['server.mjs'],
                    env: { TOKEN: 'x' },
                },
            },
            {
                name: 'off',
                enabled: false,
                transport: {
                    type: 'stdio',
                    command: 'node',
                },
            },
        ])).toEqual({
            local: {
                command: 'node',
                args: ['server.mjs'],
                env: { TOKEN: 'x' },
            },
        });
    });
});
