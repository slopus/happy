import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApiSessionClient } from '@/api/apiSession';
import { describe, expect, it, vi } from 'vitest';
import { launchIndependentDaemonSession } from '@/daemon/controlClient';
import { startHappyServer } from './startHappyServer';
vi.mock('@/daemon/controlClient', () => ({ launchIndependentDaemonSession: vi.fn() }));

describe('independent-session MCP tool', () => {
    it('advertises the tool, binds the parent, forwards context and returns a navigable card', async () => {
        vi.mocked(launchIndependentDaemonSession).mockResolvedValue({ success: true, sessionId: 'child', title: 'Task' });
        const server = await startHappyServer({ sessionId: 'parent' } as ApiSessionClient, {
            delegationContext: () => ({ permissionMode: 'plan', appendSystemPrompt: 'Custom rules' }),
        });
        const client = new Client({ name: 'delegation-test', version: '1' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            expect((await client.listTools()).tools.some(tool => tool.name === 'start_session')).toBe(true);
            expect(server.toolNames).toContain('start_session');
            const task = { requestId: 'task-1', title: 'Task', prompt: 'Inspect sources' };
            const result = await client.callTool({ name: 'start_session', arguments: task });
            expect(result.isError).toBe(false);
            expect(launchIndependentDaemonSession).toHaveBeenCalledWith('parent', task, { permissionMode: 'plan', appendSystemPrompt: 'Custom rules' });
            expect(JSON.stringify(result.content)).toContain('<happy-session>');
            expect(JSON.stringify(result.content)).toContain('child');
        } finally { await client.close(); server.stop(); }
    });
});
