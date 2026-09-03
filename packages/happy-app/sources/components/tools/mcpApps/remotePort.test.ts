import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type {
    McpAppResourceChunkRequest,
    McpAppResourceChunkResponse,
    McpAppResourceOpenRequest,
    McpAppResourceOpenResponse,
    McpAppResourceRpcClient,
    McpAppResourceReadRequest,
    McpAppToolCallRequest,
} from '@/sync/ops.mcpApps';
import { createMcpAppRemotePort } from './remotePort';

const validOpen: McpAppResourceOpenResponse = {
    resourceId: 'resource-1',
    uri: 'ui://demo/index.html',
    mimeType: 'text/html;profile=mcp-app',
    byteLength: 13,
    sha256: 'f2f0faeef71948b7d0a571dce2a067f5fc5b5080d986a0244e53ac8214d89282',
    encoding: 'utf8',
};

class InMemoryResourceRpc implements McpAppResourceRpcClient {
    readonly chunkRequests: McpAppResourceChunkRequest[] = [];
    readonly secondaryRequests: McpAppResourceReadRequest[] = [];
    readonly toolRequests: McpAppToolCallRequest[] = [];

    constructor(
        private readonly open: McpAppResourceOpenResponse,
        private readonly chunks: McpAppResourceChunkResponse[],
    ) {}

    async openResource(_sessionId: string, _input: McpAppResourceOpenRequest): Promise<McpAppResourceOpenResponse> {
        return this.open;
    }

    async readResourceChunk(
        _sessionId: string,
        input: McpAppResourceChunkRequest,
    ): Promise<McpAppResourceChunkResponse> {
        this.chunkRequests.push(input);
        const response = this.chunks.shift();
        if (!response) throw new Error('unexpected chunk read');
        return response;
    }

    async readSecondaryResource(
        _sessionId: string,
        input: McpAppResourceReadRequest,
    ): Promise<{ contents: unknown[] }> {
        this.secondaryRequests.push(input);
        return { contents: [{ uri: input.uri, text: 'detail' }] };
    }

    async callTool(
        _sessionId: string,
        input: McpAppToolCallRequest,
    ): Promise<{ content: unknown[]; _meta?: unknown }> {
        this.toolRequests.push(input);
        return { content: [{ type: 'text', text: 'done' }], _meta: null };
    }
}

function portFor(open: McpAppResourceOpenResponse, chunks: McpAppResourceChunkResponse[]) {
    return createMcpAppRemotePort({
        sessionId: 'session-1',
        rpc: new InMemoryResourceRpc(open, chunks),
        hashBytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
    });
}

describe('MCP App verified remote port', () => {
    it('assembles contiguous chunks and exposes HTML only after digest verification', async () => {
        const rpc = new InMemoryResourceRpc(validOpen, [
            { offset: 0, dataBase64: 'aGVsbG8g', nextOffset: 6 },
            { offset: 6, dataBase64: 'TUNQIEFwcA==' },
        ]);
        const port = createMcpAppRemotePort({
            sessionId: 'session-1',
            rpc,
            hashBytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
        });

        const resource = await port.readResource({
            callId: 'call-1',
            expectedResourceUri: 'ui://demo/index.html',
        });

        expect(resource).toMatchObject({
            uri: 'ui://demo/index.html',
            byteLength: 13,
            html: 'hello MCP App',
        });
        expect(rpc.chunkRequests).toEqual([
            { resourceId: 'resource-1', offset: 0 },
            { resourceId: 'resource-1', offset: 6 },
        ]);
    });

    it('revalidates and preserves official UI metadata with non-inline App HTML', async () => {
        const html = '<link rel="stylesheet" href="https://cdn.example.test/app.css"><script src="https://cdn.example.test/app.js"></script>';
        const bytes = Buffer.from(html);
        const open: McpAppResourceOpenResponse = {
            ...validOpen,
            byteLength: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            ui: {
                csp: {
                    connectDomains: ['https://api.example.test'],
                    resourceDomains: ['https://cdn.example.test'],
                    frameDomains: ['https://frame.example.test'],
                },
                permissions: { camera: {}, clipboardWrite: {} },
                prefersBorder: true,
            },
        };

        await expect(portFor(open, [{ offset: 0, dataBase64: bytes.toString('base64') }])
            .readResource({ callId: 'call-1' })).resolves.toMatchObject({
            html,
            ui: open.ui,
        });
    });

    it.each([
        ['unknown CSP key', { csp: { resourceDomains: [], scriptDomains: [] } }],
        ['unsafe CSP origin', { csp: { resourceDomains: ['https://cdn.example.test/path'] } }],
        ['too many CSP origins', { csp: { resourceDomains: Array.from({ length: 33 }, (_, index) => `https://cdn-${index}.example.test`) } }],
        ['unknown permission key', { permissions: { camera: {}, filesystem: {} } }],
        ['non-empty permission marker', { permissions: { camera: { reason: 'secret' } } }],
        ['wrong border type', { prefersBorder: 'yes' }],
    ])('rejects %s at the App RPC trust boundary', async (_label, ui) => {
        const open = { ...validOpen, ui } as McpAppResourceOpenResponse;

        await expect(portFor(open, []).readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INVALID_RESOURCE', retryable: false,
        });
    });

    it.each([
        ['repeated', [
            { offset: 0, dataBase64: 'aGVsbG8g', nextOffset: 0 },
        ]],
        ['skipped', [
            { offset: 0, dataBase64: 'aGVsbG8g', nextOffset: 8 },
        ]],
        ['response', [
            { offset: 2, dataBase64: 'aGVsbG8g', nextOffset: 8 },
        ]],
    ] as const)('rejects a %s chunk offset', async (_name, chunks) => {
        const port = portFor(validOpen, [...chunks]);

        await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INVALID_RESOURCE',
            retryable: false,
        });
    });

    it('rejects a decoded byte length that differs from metadata', async () => {
        const port = portFor({ ...validOpen, byteLength: 14 }, [
            { offset: 0, dataBase64: 'aGVsbG8gTUNQIEFwcA==' },
        ]);

        await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INVALID_RESOURCE',
            retryable: false,
        });
    });

    it('rejects a SHA-256 mismatch', async () => {
        const port = portFor({ ...validOpen, sha256: '0'.repeat(64) }, [
            { offset: 0, dataBase64: 'aGVsbG8gTUNQIEFwcA==' },
        ]);

        await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INVALID_RESOURCE',
            retryable: false,
        });
    });

    it('rejects bytes that are not valid UTF-8', async () => {
        const port = portFor({
            ...validOpen,
            byteLength: 1,
            sha256: 'a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89',
        }, [
            { offset: 0, dataBase64: '/w==' },
        ]);

        await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INVALID_RESOURCE',
            retryable: false,
        });
    });

    it('rejects a substituted resource URI before returning HTML', async () => {
        const port = portFor(validOpen, [
            { offset: 0, dataBase64: 'aGVsbG8gTUNQIEFwcA==' },
        ]);

        await expect(port.readResource({
            callId: 'call-1',
            expectedResourceUri: 'ui://another/index.html',
        })).rejects.toMatchObject({ code: 'MCP_APP_INVALID_RESOURCE' });
    });

    it('preserves the specific resource-too-large failure at the verification boundary', async () => {
        const port = portFor({ ...validOpen, byteLength: 5 * 1024 * 1024 + 1 }, []);

        await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_RESOURCE_TOO_LARGE',
            retryable: false,
        });
    });

    it('normalizes a platform digest failure without exposing its details', async () => {
        const port = createMcpAppRemotePort({
            sessionId: 'session-1',
            rpc: new InMemoryResourceRpc(validOpen, [
                { offset: 0, dataBase64: 'aGVsbG8gTUNQIEFwcA==' },
            ]),
            hashBytes: async () => {
                throw new Error('SECRET platform digest failure');
            },
        });

        await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INTERNAL',
            retryable: true,
            summary: 'The App resource could not be verified.',
        });
    });

    it('forwards secondary resources and tool calls through the typed encrypted RPC only', async () => {
        const rpc = new InMemoryResourceRpc(validOpen, []);
        const port = createMcpAppRemotePort({
            sessionId: 'session-1',
            rpc,
            hashBytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
        });

        await expect(port.readSecondaryResource({
            callId: 'call-1',
            uri: 'ui://demo/detail',
        })).resolves.toEqual({
            contents: [{ uri: 'ui://demo/detail', text: 'detail' }],
        });
        await expect(port.callTool({
            callId: 'call-1',
            tool: 'refresh',
            arguments: { id: 1 },
        })).resolves.toEqual({
            content: [{ type: 'text', text: 'done' }],
        });
        expect(rpc.secondaryRequests).toEqual([{ callId: 'call-1', uri: 'ui://demo/detail' }]);
        expect(rpc.toolRequests).toEqual([{
            callId: 'call-1', tool: 'refresh', arguments: { id: 1 },
        }]);
    });
});
