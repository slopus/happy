import { describe, expect, it, vi } from 'vitest';
import {
    MCP_APP_CHUNK_INACTIVITY_TIMEOUT_MS,
    MCP_APP_INTERACTIVE_TIMEOUT_MS,
    MCP_APP_RESOURCE_START_TIMEOUT_MS,
    createMcpAppResourceRpcClient,
} from './ops.mcpApps';

describe('MCP App RPC operations', () => {
    it('uses the typed resource methods and approved timeout budgets', async () => {
        const calls: Array<{ sessionId: string; method: string; params: unknown; timeoutMs?: number }> = [];
        const client = createMcpAppResourceRpcClient(async (sessionId, method, params, options) => {
            calls.push({ sessionId, method, params, timeoutMs: options?.timeoutMs });
            if (method === 'mcpAppResourceOpen') {
                return {
                    ok: true,
                    value: {
                        resourceId: 'resource-1',
                        uri: 'ui://demo/index.html',
                        mimeType: 'text/html;profile=mcp-app',
                        byteLength: 1,
                        sha256: 'a'.repeat(64),
                        encoding: 'utf8',
                    },
                };
            }
            return { ok: true, value: { offset: 0, dataBase64: 'eA==' } };
        });

        await client.openResource('session-1', { callId: 'call-1' });
        await client.readResourceChunk('session-1', { resourceId: 'resource-1', offset: 0 });

        expect(calls).toEqual([
            {
                sessionId: 'session-1',
                method: 'mcpAppResourceOpen',
                params: { callId: 'call-1' },
                timeoutMs: MCP_APP_RESOURCE_START_TIMEOUT_MS,
            },
            {
                sessionId: 'session-1',
                method: 'mcpAppResourceChunk',
                params: { resourceId: 'resource-1', offset: 0 },
                timeoutMs: MCP_APP_CHUNK_INACTIVITY_TIMEOUT_MS,
            },
        ]);
        expect(MCP_APP_RESOURCE_START_TIMEOUT_MS).toBe(30_000);
        expect(MCP_APP_CHUNK_INACTIVITY_TIMEOUT_MS).toBe(15_000);
    });

    it('uses exact encrypted interactive RPC methods and immutable call authority', async () => {
        const calls: Array<{ sessionId: string; method: string; params: unknown; timeoutMs?: number }> = [];
        const operationIds = [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
        ];
        const client = createMcpAppResourceRpcClient(async (sessionId, method, params, options) => {
            calls.push({ sessionId, method, params, timeoutMs: options?.timeoutMs });
            if (method === 'mcpAppResourceRead') {
                return { ok: true, value: { contents: [{ uri: 'ui://demo/detail', text: 'detail' }] } };
            }
            return { ok: true, value: { content: [{ type: 'text', text: 'done' }] } };
        }, { createOperationId: () => operationIds.shift()! });

        await client.readSecondaryResource('session-1', {
            callId: 'call-1',
            uri: 'ui://demo/detail',
        });
        await client.callTool('session-1', {
            callId: 'call-1',
            tool: 'refresh',
            arguments: { id: 1 },
            _meta: { progressToken: 'view-token' },
        });

        expect(calls).toEqual([
            {
                sessionId: 'session-1',
                method: 'mcpAppResourceRead',
                params: {
                    callId: 'call-1',
                    operationId: '00000000-0000-4000-8000-000000000001',
                    uri: 'ui://demo/detail',
                },
                timeoutMs: MCP_APP_INTERACTIVE_TIMEOUT_MS,
            },
            {
                sessionId: 'session-1',
                method: 'mcpAppToolCall',
                params: {
                    callId: 'call-1',
                    operationId: '00000000-0000-4000-8000-000000000002',
                    tool: 'refresh',
                    arguments: { id: 1 },
                    _meta: { progressToken: 'view-token' },
                },
                timeoutMs: MCP_APP_INTERACTIVE_TIMEOUT_MS,
            },
        ]);
        for (const call of calls) {
            expect(call.params).not.toHaveProperty('threadId');
            expect(call.params).not.toHaveProperty('server');
            expect(call.params).not.toHaveProperty('connectorId');
            expect(call.params).not.toHaveProperty('originCallId');
        }
        expect(MCP_APP_INTERACTIVE_TIMEOUT_MS).toBe(30_000);
    });

    it('preserves permission denial as a stable display-safe error', async () => {
        const client = createMcpAppResourceRpcClient(async () => ({
            ok: false,
            error: {
                code: 'MCP_APP_PERMISSION_DENIED',
                retryable: false,
                summary: 'Permission was denied.',
            },
        }), { createOperationId: () => '00000000-0000-4000-8000-000000000003' });

        await expect(client.callTool('session-1', {
            callId: 'call-1',
            tool: 'delete_everything',
        })).rejects.toMatchObject({
            code: 'MCP_APP_PERMISSION_DENIED',
            retryable: false,
            summary: 'Permission was denied.',
        });
    });

    it('maps transport timeouts to a safe retryable timeout error', async () => {
        const client = createMcpAppResourceRpcClient(async () => {
            const error = new Error('private socket details');
            error.name = 'TimeoutError';
            throw error;
        });

        await expect(client.openResource('session-1', { callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_TIMEOUT',
            retryable: true,
            summary: 'The App request timed out.',
        });
    });

    it('rejects legacy and malformed envelopes without exposing their details', async () => {
        const client = createMcpAppResourceRpcClient(async () => ({ error: 'SECRET raw exception' }));

        await expect(client.openResource('session-1', { callId: 'call-1' })).rejects.toMatchObject({
            code: 'MCP_APP_INTERNAL',
            retryable: false,
            summary: 'The App request could not be completed.',
        });
    });

    it('normalizes operation ID generation failures without exposing runtime details', async () => {
        const client = createMcpAppResourceRpcClient(async () => ({ ok: true, value: {} }), {
            createOperationId: () => { throw new Error('SECRET native crypto detail'); },
        });

        await expect(client.callTool('session-1', {
            callId: 'call-1',
            tool: 'refresh',
        })).rejects.toMatchObject({
            code: 'MCP_APP_INTERNAL',
            retryable: false,
            summary: 'The App request could not be completed.',
        });
    });

    it('cancels a pending call and ignores its later transport completion', async () => {
        let settle!: (value: unknown) => void;
        const transport = new Promise<unknown>((resolve) => {
            settle = resolve;
        });
        const client = createMcpAppResourceRpcClient(async () => transport);
        const controller = new AbortController();
        const pending = client.openResource('session-1', { callId: 'call-1' }, controller.signal);

        controller.abort();

        await expect(pending).rejects.toMatchObject({
            code: 'MCP_APP_SESSION_OFFLINE',
            retryable: true,
        });
        settle({ ok: false, error: { code: 'MCP_APP_INTERNAL', retryable: false, summary: 'late' } });
        await Promise.resolve();
    });

    it('sends one authenticated cancellation for the exact interactive operation before settling abort', async () => {
        const calls: Array<{
            method: string;
            params: any;
            timeoutMs?: number;
            overallTimeoutMs?: number;
        }> = [];
        let settleOperation!: (value: unknown) => void;
        const operation = new Promise<unknown>((resolve) => { settleOperation = resolve; });
        const client = createMcpAppResourceRpcClient(async (_sessionId, method, params, options) => {
            calls.push({
                method,
                params,
                timeoutMs: options?.timeoutMs,
                ...(options?.overallTimeoutMs !== undefined
                    ? { overallTimeoutMs: options.overallTimeoutMs }
                    : {}),
            });
            if (method === 'mcpAppOperationCancel') return { ok: true, value: {} };
            return operation;
        }, { createOperationId: () => '00000000-0000-4000-8000-000000000007' });
        const controller = new AbortController();
        const pending = client.callTool('session-1', {
            callId: 'call-1',
            tool: 'mutate',
            arguments: { secret: 'CANARY_ARGUMENT' },
        }, controller.signal);
        await vi.waitFor(() => expect(calls).toHaveLength(1));

        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: 'MCP_APP_SESSION_OFFLINE' });
        expect(calls).toEqual([
            {
                method: 'mcpAppToolCall',
                params: {
                    callId: 'call-1',
                    operationId: '00000000-0000-4000-8000-000000000007',
                    tool: 'mutate',
                    arguments: { secret: 'CANARY_ARGUMENT' },
                },
                timeoutMs: MCP_APP_INTERACTIVE_TIMEOUT_MS,
            },
            {
                method: 'mcpAppOperationCancel',
                params: {
                    callId: 'call-1',
                    operationId: '00000000-0000-4000-8000-000000000007',
                },
                timeoutMs: 5_000,
                overallTimeoutMs: 5_000,
            },
        ]);
        settleOperation({ ok: true, value: { content: [{ type: 'text', text: 'CANARY_LATE' }] } });
        await Promise.resolve();
    });

    it('settles an authenticated cancellation at the five-second wall-clock deadline', async () => {
        vi.useFakeTimers();
        try {
            const calls: Array<{ method: string; options: unknown }> = [];
            const never = new Promise<unknown>(() => {});
            const client = createMcpAppResourceRpcClient(async (_sessionId, method, _params, options) => {
                calls.push({ method, options });
                return never;
            }, { createOperationId: () => '00000000-0000-4000-8000-000000000008' });
            const controller = new AbortController();
            const pending = client.callTool('session-1', {
                callId: 'call-1', tool: 'mutate', arguments: { id: 1 },
            }, controller.signal);
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            let rejection: unknown;
            void pending.catch((error) => { rejection = error; });

            controller.abort();
            await vi.advanceTimersByTimeAsync(4_999);
            expect(rejection).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);

            expect(rejection).toMatchObject({
                code: 'MCP_APP_SESSION_OFFLINE', retryable: true,
            });
            expect(calls).toEqual([
                { method: 'mcpAppToolCall', options: { timeoutMs: 30_000 } },
                {
                    method: 'mcpAppOperationCancel',
                    options: { timeoutMs: 5_000, overallTimeoutMs: 5_000 },
                },
            ]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
