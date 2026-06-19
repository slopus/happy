import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHappyServer } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';

describe('startHappyServer MCP tools', () => {
    let server: Awaited<ReturnType<typeof startHappyServer>> | null = null;
    let client: Client | null = null;

    afterEach(async () => {
        try { await client?.close(); } catch { /* ignore */ }
        client = null;
        server?.stop();
        server = null;
    });

    function fakeSession(summaries: string[], sessionId = 'self-session'): ApiSessionClient {
        return {
            sessionId,
            getMetadata: () => ({ path: '/tmp/fake-project' }),
            sendClaudeSessionMessage: (message: unknown) => {
                if (message && typeof message === 'object' && (message as { type?: string }).type === 'summary') {
                    summaries.push(String((message as { summary?: string }).summary ?? ''));
                }
            },
        } as unknown as ApiSessionClient;
    }

    async function connect(url: string): Promise<Client> {
        const c = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
        await c.connect(new StreamableHTTPClientTransport(new URL(url)));
        return c;
    }

    it('registers change_title, open_session, archive_session', async () => {
        server = await startHappyServer(fakeSession([]));
        expect(server.toolNames).toEqual(['change_title', 'open_session', 'archive_session']);

        client = await connect(server.url);
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual(['archive_session', 'change_title', 'open_session']);
    });

    it('change_title still works after the refactor', async () => {
        const summaries: string[] = [];
        server = await startHappyServer(fakeSession(summaries));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'change_title', arguments: { title: 'Hello world' } });
        expect(res.isError).toBeFalsy();
        expect(JSON.stringify(res.content)).toContain('Hello world');
        expect(summaries).toContain('Hello world');
    });

    it('archive_session refuses to archive the current session (keepalive self-revive guard)', async () => {
        server = await startHappyServer(fakeSession([], 'self-session'));
        client = await connect(server.url);

        const res = await client.callTool({ name: 'archive_session', arguments: { sessionId: 'self-session' } });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res.content)).toContain('Cannot archive the current session');
    });
});
