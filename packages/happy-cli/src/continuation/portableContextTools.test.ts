/** Exercise real MCP transport, forwarding and encrypted store together. */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PortableContextArchive, PortableContextDescriptor } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import { PortableContextStore } from './portableContextStore';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { registerHappyBridgeTools, HAPPY_MCP_BRIDGE_TOOL_NAMES } from '@/codex/happyMcpBridgeTools';

describe('portable history MCP tools', () => {
    it('advertises and reads committed history through HTTP and the actual bridge registrations', async () => {
        const directory = await fs.mkdtemp(join(tmpdir(), 'portable-mcp-test-'));
        let descriptor: PortableContextDescriptor | undefined;
        const store = new PortableContextStore({ directory, sessionId: 'target', serverUrl: 'http://localhost:1', token: 'token',
            encryptionKey: new Uint8Array(32).fill(2), descriptor: () => descriptor });
        const value: PortableContextArchive = { snapshot: { version: 1, id: randomUUID(), rootSessionId: 'source', sourceSessionId: 'source',
            heads: [{ sessionId: 'source', afterSeq: 0, throughSeq: 1 }], items: [{ id: 'first', sourceSessionId: 'source', seq: 1, role: 'user', text: 'complete historical evidence' }] }, blobKeys: {} };
        const raw = JSON.stringify(value);
        await store.upload({ action: 'append', snapshotId: value.snapshot.id, index: 0, chunk: raw });
        descriptor = (await store.upload({ action: 'commit', snapshotId: value.snapshot.id, chunks: 1, sha256: createHash('sha256').update(raw).digest('hex') })).descriptor;
        let enabled = false;
        const http = await startHappyServer({ sessionId: 'target', readPortableContext: input => store.read(input),
            readPortableContextAttachment: input => store.attachment(input), enablePortableContext: async () => { enabled = true; },
        } as ApiSessionClient);
        const httpClient = new Client({ name: 'http-history-test', version: '1' });
        const bridge = new McpServer({ name: 'history-bridge', version: '1' });
        const bridgeClient = new Client({ name: 'bridge-history-test', version: '1' });
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        try {
            expect(enabled).toBe(true);
            await httpClient.connect(new StreamableHTTPClientTransport(new URL(http.url)));
            expect((await httpClient.listTools()).tools.map(tool => tool.name)).toEqual(http.toolNames);
            registerHappyBridgeTools(bridge, async () => httpClient);
            await bridge.connect(serverTransport); await bridgeClient.connect(clientTransport);
            expect((await bridgeClient.listTools()).tools.map(tool => tool.name)).toEqual([...HAPPY_MCP_BRIDGE_TOOL_NAMES]);
            const result = await bridgeClient.callTool({ name: 'thread_read', arguments: { itemId: 'first', limit: 8 } });
            expect(JSON.stringify(result.content)).toContain('complete');
            const missing = await bridgeClient.callTool({ name: 'thread_attachment', arguments: { attachmentId: 'unknown' } });
            expect(missing.isError).toBe(true);
            await store.revoke();
            const cleared = await bridgeClient.callTool({ name: 'thread_read', arguments: {} });
            expect(cleared.isError).toBe(true);
        } finally {
            await bridgeClient.close(); await bridge.close(); await httpClient.close(); http.stop();
            await store.dispose(); await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
