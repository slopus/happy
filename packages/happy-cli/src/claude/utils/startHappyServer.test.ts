/**
 * Tests for Happy MCP server
 * Verifies that the per-request transport pattern works correctly,
 * especially with @modelcontextprotocol/sdk >= 1.26.0 which forbids
 * reusing a stateless StreamableHTTPServerTransport across requests.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { startHappyServer } from './startHappyServer'
import http from 'node:http'

function createMockClient() {
    const messages: unknown[] = [];
    return {
        sessionId: 'test-session-123',
        sendClaudeSessionMessage: (msg: unknown) => {
            messages.push(msg);
        },
        _messages: messages,
    } as any;
}

function postJSON(url: string, body: object): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const MCP_INITIALIZE = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
    },
    id: 1,
};

describe('startHappyServer', () => {
    let server: Awaited<ReturnType<typeof startHappyServer>> | null = null;

    afterEach(() => {
        server?.stop();
        server = null;
    });

    it('should start and return a url and tool names', async () => {
        const client = createMockClient();
        server = await startHappyServer(client);

        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
        expect(server.toolNames).toEqual(['change_title']);
    });

    it('should respond to a single MCP initialize request', async () => {
        const client = createMockClient();
        server = await startHappyServer(client);

        const res = await postJSON(server.url, MCP_INITIALIZE);
        expect(res.status).toBe(200);
    });

    it('should handle multiple sequential requests without 500 errors', async () => {
        const client = createMockClient();
        server = await startHappyServer(client);

        // This is the core regression test: SDK >= 1.26.0 throws
        // "Stateless transport cannot be reused across requests"
        // if a single transport handles more than one request.
        const res1 = await postJSON(server.url, MCP_INITIALIZE);
        expect(res1.status).toBe(200);

        const res2 = await postJSON(server.url, MCP_INITIALIZE);
        expect(res2.status).toBe(200);

        const res3 = await postJSON(server.url, MCP_INITIALIZE);
        expect(res3.status).toBe(200);
    });
});
