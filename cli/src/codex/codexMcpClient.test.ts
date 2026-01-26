import { describe, it, expect, vi } from 'vitest';
import { getCodexElicitationToolCallId, getCodexEventToolCallId } from './codexMcpClient';

// NOTE: This test suite uses mocks because the real Codex CLI / MCP transport
// is not guaranteed to be available in CI or local test environments.
vi.mock('child_process', () => ({
    execFileSync: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', async () => {
    const { z } = await import('zod');
    return {
        RequestSchema: z.object({}).passthrough(),
        ElicitRequestParamsSchema: z.object({}).passthrough(),
        ElicitRequestSchema: z.object({}).passthrough(),
    };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
    const instances: any[] = [];

    class StdioClientTransport {
        public command: string;
        public args: string[];
        public env: Record<string, string>;

        constructor(opts: { command: string; args: string[]; env: Record<string, string> }) {
            this.command = opts.command;
            this.args = opts.args;
            this.env = opts.env;
            instances.push(this);
        }
    }

    return { StdioClientTransport, __transportInstances: instances };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
    class Client {
        setNotificationHandler() { }
        setRequestHandler() { }
        async connect() { }
        async close() { }
    }

    return { Client };
});

describe('CodexMcpClient elicitation ids', () => {
    it('prefers codex_call_id over codex_mcp_tool_call_id', () => {
        expect(getCodexElicitationToolCallId({
            codex_mcp_tool_call_id: 'mcp-1',
            codex_call_id: 'call-1',
        })).toBe('call-1');
    });

    it('falls back to codex_mcp_tool_call_id when codex_call_id is missing', () => {
        expect(getCodexElicitationToolCallId({
            codex_mcp_tool_call_id: 'mcp-1',
        })).toBe('mcp-1');
    });
});

describe('CodexMcpClient event ids', () => {
    it('prefers call_id over mcp_tool_call_id', () => {
        expect(getCodexEventToolCallId({
            mcp_tool_call_id: 'mcp-1',
            call_id: 'call-1',
        })).toBe('call-1');
    });

    it('falls back to mcp_tool_call_id when call_id is missing', () => {
        expect(getCodexEventToolCallId({
            mcp_tool_call_id: 'mcp-1',
        })).toBe('mcp-1');
    });
});

describe('CodexMcpClient command detection', () => {
    it('does not treat "codex <version>" output as "not installed"', async () => {
        vi.resetModules();

        const { execFileSync } = await import('child_process');
        (execFileSync as any).mockReturnValue('codex 0.43.0-alpha.5\n');

        const stdioModule = (await import('@modelcontextprotocol/sdk/client/stdio.js')) as any;
        const __transportInstances = stdioModule.__transportInstances as any[];
        __transportInstances.length = 0;

        const mod = await import('./codexMcpClient');

        const client = new (mod as any).CodexMcpClient();
        await expect(client.connect()).resolves.toBeUndefined();

        expect(__transportInstances.length).toBe(1);
        expect(__transportInstances[0].command).toBe('codex');
        expect(__transportInstances[0].args).toEqual(['mcp-server']);
    });
});
