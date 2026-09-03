import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { McpAppBindingRegistry } from './McpAppBindingRegistry';
import { CodexAppServerRequestTimeoutError } from '../codexAppServerClient';
import {
    MCP_APP_CHUNK_BYTES,
    MCP_APP_MAX_ACTIVE_RESOURCES,
    MCP_APP_MAX_HTML_BYTES,
    MCP_APP_RESOURCE_TTL_MS,
    registerMcpAppRpcHandlers,
    type McpAppResourceChunkResponse,
    type McpAppResourceOpenResponse,
    type McpAppRpcResponse,
} from './registerMcpAppRpcHandlers';
import type { McpAppTelemetrySink } from './mcpAppTelemetry';

type Handler = (request: unknown) => Promise<unknown>;

let nextOperationSequence = 0;

function testOperationId(): string {
    nextOperationSequence += 1;
    return `00000000-0000-4000-8000-${String(nextOperationSequence).padStart(12, '0')}`;
}

function createHarness(options?: {
    now?: () => number;
    readMcpResource?: ReturnType<typeof vi.fn>;
    listMcpServerStatus?: ReturnType<typeof vi.fn>;
    callMcpTool?: ReturnType<typeof vi.fn>;
    handleToolCall?: ReturnType<typeof vi.fn>;
    telemetry?: McpAppTelemetrySink;
}) {
    const handlers = new Map<string, Handler>();
    const registry = new McpAppBindingRegistry();
    const client = {
        readMcpResource: options?.readMcpResource ?? vi.fn(async () => ({
            contents: [{
                uri: 'ui://demo/index.html',
                mimeType: 'text/html;profile=mcp-app',
                text: '<main>App</main>',
            }],
        })),
        listMcpServerStatus: options?.listMcpServerStatus ?? vi.fn(async () => ({
            data: [{
                name: 'demo',
                authStatus: 'unsupported',
                runtimeStatus: 'connected',
                pluginId: null,
                serverInfo: null,
                tools: {
                    refresh: {
                        name: 'refresh',
                        inputSchema: {},
                        annotations: { readOnlyHint: true },
                    },
                },
                resources: [],
                resourceTemplates: [],
            }],
            nextCursor: null,
        })),
        callMcpTool: options?.callMcpTool ?? vi.fn(async () => ({
            content: [{ type: 'text', text: 'refreshed' }],
            structuredContent: { refreshed: true },
        })),
    };
    const permissionHandler = {
        handleToolCall: options?.handleToolCall ?? vi.fn(async () => ({ decision: 'approved' as const })),
    };
    const registration = registerMcpAppRpcHandlers({
        rpcHandlerManager: {
            registerHandler(method: string, handler: Handler) {
                handlers.set(method, handler);
            },
            unregisterHandler(method: string) {
                handlers.delete(method);
            },
        },
        client,
        bindingRegistry: registry,
        permissionHandler,
        now: options?.now,
        telemetry: options?.telemetry,
    });

    return { client, handlers, permissionHandler, registration, registry };
}

function bind(registry: McpAppBindingRegistry, options?: { connectorId?: string; callId?: string }) {
    const callId = options?.callId ?? 'call-1';
    registry.bindStarted({
        callId,
        threadId: 'thread-1',
        server: 'demo',
        resourceUri: 'ui://demo/index.html',
        input: {},
        ...(options?.connectorId ? { connectorId: options.connectorId } : {}),
    });
    return callId;
}

async function readSecondary(handler: Handler, uri: string, callId = 'call-1') {
    return await handler({ callId, operationId: testOperationId(), uri }) as McpAppRpcResponse<unknown>;
}

async function callTool(
    handler: Handler,
    tool = 'refresh',
    request: Record<string, unknown> = {},
    callId = 'call-1',
) {
    return await handler({
        callId,
        operationId: testOperationId(),
        tool,
        arguments: { id: 1 },
        ...request,
    }) as McpAppRpcResponse<unknown>;
}

async function open(
    handler: Handler,
    callId = 'call-1',
): Promise<McpAppRpcResponse<McpAppResourceOpenResponse>> {
    return await handler({ callId }) as McpAppRpcResponse<McpAppResourceOpenResponse>;
}

async function chunk(
    handler: Handler,
    resourceId: string,
    offset: number,
): Promise<McpAppRpcResponse<McpAppResourceChunkResponse>> {
    return await handler({ resourceId, offset }) as McpAppRpcResponse<McpAppResourceChunkResponse>;
}

function opened(response: McpAppRpcResponse<McpAppResourceOpenResponse>): McpAppResourceOpenResponse {
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.code);
    return response.value;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('registerMcpAppRpcHandlers', () => {
    it('emits exact redacted pairs for success, denial, cancellation, timeout, and rate limit', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const telemetry: McpAppTelemetrySink = (eventName, payload) => {
            telemetryEvents.push([eventName, payload]);
        };
        const { handlers, registry } = createHarness({ telemetry });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!, 'refresh', {
            arguments: { secret: 'CANARY_ARGUMENT' },
        })).resolves.toMatchObject({ ok: true });

        expect(telemetryEvents.map(([eventName, payload]) => [eventName, payload.outcomeCode])).toEqual([
            ['mcp_app_tool_call_requested', 'started'],
            ['mcp_app_tool_call_resolved', 'succeeded'],
        ]);
        expect(telemetryEvents[1]?.[1]).toMatchObject({
            platform: 'cli',
            stage: 'tool_call',
            originScoped: true,
            outcomeCode: 'succeeded',
        });
        expect(telemetryEvents.map(([, payload]) => payload.originScoped)).toEqual([false, true]);
        expect(JSON.stringify(telemetryEvents)).not.toContain('CANARY_ARGUMENT');

        const deniedEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const denied = createHarness({
            telemetry: (eventName, payload) => { deniedEvents.push([eventName, payload]); },
            listMcpServerStatus: vi.fn(async () => ({
                data: [{
                    name: 'demo',
                    runtimeStatus: 'connected',
                    tools: {
                        mutate: {
                            name: 'mutate',
                            enabled: true,
                            annotations: { readOnlyHint: false },
                        },
                    },
                }],
            })),
            handleToolCall: vi.fn(async () => ({ decision: 'denied' as const })),
        });
        bind(denied.registry);
        await expect(callTool(denied.handlers.get('mcpAppToolCall')!, 'mutate')).resolves.toMatchObject({
            ok: false,
            error: { code: 'MCP_APP_PERMISSION_DENIED' },
        });
        expect(deniedEvents.map(([eventName, payload]) => [
            eventName, payload.outcomeCode, payload.originScoped,
        ])).toEqual([
            ['mcp_app_tool_call_requested', 'started', false],
            ['mcp_app_tool_call_resolved', 'MCP_APP_PERMISSION_DENIED', false],
        ]);

        const cancelledEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const execution = deferred<any>();
        const cancelled = createHarness({
            telemetry: (eventName, payload) => { cancelledEvents.push([eventName, payload]); },
            callMcpTool: vi.fn(() => execution.promise),
        });
        bind(cancelled.registry);
        const operationId = testOperationId();
        const pending = cancelled.handlers.get('mcpAppToolCall')!({
            callId: 'call-1', operationId, tool: 'refresh', arguments: {},
        });
        await vi.waitFor(() => expect(cancelled.client.callMcpTool).toHaveBeenCalledTimes(1));
        await cancelled.handlers.get('mcpAppOperationCancel')!({ callId: 'call-1', operationId });
        await expect(pending).resolves.toMatchObject({
            ok: false,
            error: { code: 'MCP_APP_SESSION_OFFLINE' },
        });
        expect(cancelledEvents.map(([eventName, payload]) => [
            eventName, payload.outcomeCode, payload.originScoped,
        ])).toEqual([
            ['mcp_app_tool_call_requested', 'started', false],
            ['mcp_app_tool_call_resolved', 'cancelled', true],
        ]);

        const timeoutEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const timedOut = createHarness({
            telemetry: (eventName, payload) => { timeoutEvents.push([eventName, payload]); },
            listMcpServerStatus: vi.fn(async () => {
                throw new CodexAppServerRequestTimeoutError('mcpServerStatus/list', 30_000);
            }),
        });
        bind(timedOut.registry);
        await expect(callTool(timedOut.handlers.get('mcpAppToolCall')!)).resolves.toMatchObject({
            ok: false,
            error: { code: 'MCP_APP_TIMEOUT' },
        });
        expect(timeoutEvents.map(([eventName, payload]) => [
            eventName, payload.outcomeCode, payload.originScoped,
        ])).toEqual([
            ['mcp_app_tool_call_requested', 'started', false],
            ['mcp_app_tool_call_resolved', 'MCP_APP_TIMEOUT', false],
        ]);

        const rateEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const catalog = deferred<any>();
        const rateLimited = createHarness({
            telemetry: (eventName, payload) => { rateEvents.push([eventName, payload]); },
            listMcpServerStatus: vi.fn(() => catalog.promise),
        });
        bind(rateLimited.registry);
        const occupied = Array.from({ length: 8 }, () => (
            callTool(rateLimited.handlers.get('mcpAppToolCall')!)
        ));
        await vi.waitFor(() => expect(rateLimited.client.listMcpServerStatus).toHaveBeenCalledTimes(8));
        rateEvents.length = 0;
        await expect(callTool(rateLimited.handlers.get('mcpAppToolCall')!)).resolves.toMatchObject({
            ok: false,
            error: { code: 'MCP_APP_TIMEOUT' },
        });
        expect(rateEvents.map(([eventName, payload]) => [
            eventName, payload.outcomeCode, payload.originScoped,
        ])).toEqual([
            ['mcp_app_tool_call_requested', 'started', false],
            ['mcp_app_tool_call_resolved', 'MCP_APP_TIMEOUT', false],
        ]);
        rateLimited.registration.dispose();
        await Promise.all(occupied);
    });

    it('registers bounded secondary resource and direct tool handlers', () => {
        const { handlers } = createHarness();

        expect(handlers.has('mcpAppResourceRead')).toBe(true);
        expect(handlers.has('mcpAppToolCall')).toBe(true);
        expect(handlers.has('mcpAppOperationCancel')).toBe(true);
    });

    it('omits null tool result metadata before returning it to an MCP App', async () => {
        const callMcpTool = vi.fn(async () => ({
            content: [{ type: 'text', text: 'done' }],
            _meta: null,
        }));
        const { handlers, registry } = createHarness({ callMcpTool });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toEqual({
            ok: true,
            value: { content: [{ type: 'text', text: 'done' }] },
        });
    });

    it('cancels only the exact binding-scoped operation and blocks late permission execution', async () => {
        const permission = deferred<{ decision: 'approved' }>();
        let permissionSignal: AbortSignal | undefined;
        const handleToolCall = vi.fn((
            _permissionId: string,
            _toolName: string,
            _input: unknown,
            options?: { signal?: AbortSignal },
        ) => {
            permissionSignal = options?.signal;
            return permission.promise;
        });
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                runtimeStatus: 'connected',
                tools: {
                    mutate: {
                        name: 'mutate',
                        enabled: true,
                        annotations: { readOnlyHint: false },
                        _meta: { ui: { visibility: ['app'] } },
                    },
                    refresh: {
                        name: 'refresh',
                        enabled: true,
                        annotations: { readOnlyHint: true },
                    },
                },
            }],
        }));
        const { client, handlers, registry } = createHarness({ listMcpServerStatus, handleToolCall });
        bind(registry);
        const operationId = '00000000-0000-4000-8000-000000000077';
        const pending = handlers.get('mcpAppToolCall')!({
            callId: 'call-1', operationId, tool: 'mutate', arguments: { id: 1 },
        }) as Promise<McpAppRpcResponse<unknown>>;
        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledTimes(1));

        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'call-1', operationId: '00000000-0000-4000-8000-000000000099',
        })).resolves.toEqual({ ok: true, value: {} });
        expect(permissionSignal?.aborted).toBe(false);
        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'unknown-call', operationId,
        })).resolves.toEqual({ ok: true, value: {} });
        expect(permissionSignal?.aborted).toBe(false);
        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'call-1', operationId,
        })).resolves.toEqual({ ok: true, value: {} });

        expect(permissionSignal?.aborted).toBe(true);
        await expect(pending).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
        });
        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'call-1', operationId,
        })).resolves.toEqual({ ok: true, value: {} });
        permission.resolve({ decision: 'approved' });
        await Promise.resolve();
        expect(client.callMcpTool).not.toHaveBeenCalled();
        await expect(callTool(handlers.get('mcpAppToolCall')!, 'refresh')).resolves.toMatchObject({ ok: true });
    });

    it('consumes reordered cancellation before independently encrypted resource and tool requests', async () => {
        const { client, handlers, permissionHandler, registry } = createHarness();
        bind(registry);
        const resourceOperationId = '00000000-0000-4000-8000-000000000101';
        const toolOperationId = '00000000-0000-4000-8000-000000000102';

        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'call-1', operationId: resourceOperationId,
        })).resolves.toEqual({ ok: true, value: {} });
        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'call-1', operationId: toolOperationId,
        })).resolves.toEqual({ ok: true, value: {} });

        await expect(handlers.get('mcpAppResourceRead')!({
            callId: 'call-1', operationId: resourceOperationId, uri: 'ui://demo/detail',
        })).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
        });
        await expect(handlers.get('mcpAppToolCall')!({
            callId: 'call-1', operationId: toolOperationId, tool: 'refresh', arguments: { id: 1 },
        })).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
        });

        expect(client.readMcpResource).not.toHaveBeenCalled();
        expect(client.listMcpServerStatus).not.toHaveBeenCalled();
        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
        expect(client.callMcpTool).not.toHaveBeenCalled();
        await expect(callTool(handlers.get('mcpAppToolCall')!, 'refresh')).resolves.toMatchObject({ ok: true });
    });

    it('bounds pre-cancel memory and expires tombstones within one operation lifetime', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const { client, handlers, registration, registry } = createHarness();
            bind(registry);
            const operationIds = Array.from({ length: 65 }, (_, index) => (
                `00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}`
            ));
            for (const operationId of operationIds) {
                await handlers.get('mcpAppOperationCancel')!({ callId: 'call-1', operationId });
            }

            await expect(handlers.get('mcpAppToolCall')!({
                callId: 'call-1', operationId: operationIds[0], tool: 'refresh', arguments: {},
            })).resolves.toMatchObject({ ok: true });
            await expect(handlers.get('mcpAppToolCall')!({
                callId: 'call-1', operationId: operationIds.at(-1), tool: 'refresh', arguments: {},
            })).resolves.toMatchObject({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE' }),
            });
            expect(client.callMcpTool).toHaveBeenCalledTimes(1);

            const expiringOperationId = '00000000-0000-4000-8000-000000000999';
            await handlers.get('mcpAppOperationCancel')!({
                callId: 'call-1', operationId: expiringOperationId,
            });
            await vi.advanceTimersByTimeAsync(30_001);
            await expect(handlers.get('mcpAppToolCall')!({
                callId: 'call-1', operationId: expiringOperationId, tool: 'refresh', arguments: {},
            })).resolves.toMatchObject({ ok: true });
            expect(client.callMcpTool).toHaveBeenCalledTimes(2);

            registration.dispose();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns a safe not-found envelope for an unknown binding', async () => {
        const { handlers } = createHarness();

        await expect(open(handlers.get('mcpAppResourceOpen')!, 'missing')).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({
                code: 'MCP_APP_BINDING_NOT_FOUND',
                retryable: false,
            }),
        });
    });

    it('waits for a connector origin instead of reading an untrusted App resource', async () => {
        const { client, handlers, registry } = createHarness();
        bind(registry, { connectorId: 'connector-1' });

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({
                code: 'MCP_APP_ORIGIN_MISMATCH',
                retryable: true,
            }),
        });
        expect(client.readMcpResource).not.toHaveBeenCalled();
    });

    it('reads a trusted App primary resource exactly once with its origin call ID', async () => {
        const { client, handlers, registry } = createHarness();
        bind(registry, { connectorId: 'connector-1' });
        registry.complete('call-1', undefined, true);

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toMatchObject({ ok: true });
        expect(client.readMcpResource.mock.calls[0][0]).toEqual({
            threadId: 'thread-1',
            server: 'demo',
            uri: 'ui://demo/index.html',
            originCallId: 'call-1',
        });
        expect(client.readMcpResource).toHaveBeenCalledTimes(1);
    });

    it('reads an ordinary configured server resource only in its binding thread', async () => {
        const { client, handlers, registry } = createHarness();
        bind(registry);

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toMatchObject({ ok: true });
        expect(client.readMcpResource.mock.calls[0][0]).toEqual({
            threadId: 'thread-1',
            server: 'demo',
            uri: 'ui://demo/index.html',
        });
    });

    it('preserves validated official App UI metadata with a non-inline primary resource', async () => {
        const html = [
            '<link rel="stylesheet" href="https://cdn.example.test/app.css">',
            '<main>App</main>',
            '<script src="https://cdn.example.test/app.js"></script>',
        ].join('');
        const readMcpResource = vi.fn(async () => ({
            contents: [{
                uri: 'ui://demo/index.html',
                mimeType: 'text/html;profile=mcp-app',
                text: html,
                _meta: {
                    ui: {
                        csp: {
                            connectDomains: ['https://api.example.test'],
                            resourceDomains: ['https://cdn.example.test'],
                            frameDomains: ['https://frame.example.test'],
                        },
                        permissions: { camera: {}, clipboardWrite: {} },
                        prefersBorder: true,
                    },
                },
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);

        const resource = opened(await open(handlers.get('mcpAppResourceOpen')!));

        expect(resource).toMatchObject({
            byteLength: Buffer.byteLength(html),
            ui: {
                csp: {
                    connectDomains: ['https://api.example.test'],
                    resourceDomains: ['https://cdn.example.test'],
                    frameDomains: ['https://frame.example.test'],
                },
                permissions: { camera: {}, clipboardWrite: {} },
                prefersBorder: true,
            },
        });
    });

    it('normalizes deprecated flat App UI metadata before returning it', async () => {
        const readMcpResource = vi.fn(async () => ({
            contents: [{
                uri: 'ui://demo/index.html',
                mimeType: 'text/html;profile=mcp-app',
                text: '<main>App</main>',
                _meta: {
                    'ui/csp': { resourceDomains: ['https://cdn.example.test'] },
                    'ui/permissions': { microphone: {} },
                    'ui/prefersBorder': false,
                },
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);

        expect((opened(await open(handlers.get('mcpAppResourceOpen')!)) as unknown as { ui?: unknown }).ui).toEqual({
            csp: {
                connectDomains: [],
                resourceDomains: ['https://cdn.example.test'],
                frameDomains: [],
            },
            permissions: { microphone: {} },
            prefersBorder: false,
        });
    });

    it.each([
        ['malformed CSP origin', { ui: { csp: { resourceDomains: ['https://cdn.example.test/path'] } } }],
        ['too many CSP origins', { ui: { csp: { resourceDomains: Array.from({ length: 33 }, (_, index) => `https://cdn-${index}.example.test`) } } }],
        ['malformed permission marker', { ui: { permissions: { camera: { reason: 'secret' } } } }],
        ['malformed border preference', { ui: { prefersBorder: 'yes' } }],
    ])('rejects primary resource metadata with %s', async (_label, metadata) => {
        const readMcpResource = vi.fn(async () => ({
            contents: [{
                uri: 'ui://demo/index.html',
                mimeType: 'text/html;profile=mcp-app',
                text: '<main>App</main>',
                _meta: metadata,
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_INVALID_RESOURCE', retryable: false }),
        });
    });

    it('reads secondary resources only through binding-derived authority and declared schemes', async () => {
        const readMcpResource = vi.fn(async (params: { uri: string }) => params.uri === 'ui://demo/index.html'
            ? {
                contents: [{
                    uri: params.uri,
                    mimeType: 'text/html;profile=mcp-app',
                    text: '<main>App</main>',
                    _meta: {
                        ui: {
                            csp: { resourceDomains: ['https://cdn.example.test'] },
                        },
                    },
                }],
            }
            : {
                contents: [{ uri: params.uri, mimeType: 'application/json', text: '{"ok":true}' }],
            });
        const { client, handlers, registry } = createHarness({ readMcpResource });
        bind(registry, { connectorId: 'connector-1' });
        registry.complete('call-1', undefined, true);
        await open(handlers.get('mcpAppResourceOpen')!);

        await expect(readSecondary(
            handlers.get('mcpAppResourceRead')!,
            'https://cdn.example.test/data.json',
        )).resolves.toEqual({
            ok: true,
            value: {
                contents: [{
                    uri: 'https://cdn.example.test/data.json',
                    mimeType: 'application/json',
                    text: '{"ok":true}',
                }],
            },
        });
        expect(client.readMcpResource.mock.calls[1][0]).toEqual({
            threadId: 'thread-1',
            server: 'demo',
            uri: 'https://cdn.example.test/data.json',
            originCallId: 'call-1',
            connectorId: 'connector-1',
        });
        expect(client.readMcpResource.mock.calls[1][0]).not.toHaveProperty('accountId');

        await expect(readSecondary(
            handlers.get('mcpAppResourceRead')!,
            'file:///private/secret',
        )).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_INVALID_RESOURCE', retryable: false }),
        });
        await expect(readSecondary(
            handlers.get('mcpAppResourceRead')!,
            'ui:not-hierarchical',
        )).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_INVALID_RESOURCE', retryable: false }),
        });
        expect(client.readMcpResource).toHaveBeenCalledTimes(2);
    });

    it('allows ui secondary reads without primary CSP metadata', async () => {
        const readMcpResource = vi.fn(async (params: { uri: string }) => ({
            contents: [{
                uri: params.uri,
                mimeType: params.uri.endsWith('index.html') ? 'text/html;profile=mcp-app' : 'text/plain',
                text: params.uri.endsWith('index.html') ? '<main>App</main>' : 'detail',
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);
        await open(handlers.get('mcpAppResourceOpen')!);

        await expect(readSecondary(
            handlers.get('mcpAppResourceRead')!,
            'ui://demo/detail.txt',
        )).resolves.toMatchObject({ ok: true });
    });

    it('rejects a secondary response over 512 KiB serialized without buffering it', async () => {
        const readMcpResource = vi.fn(async (params: { uri: string }) => ({
            contents: [{
                uri: params.uri,
                mimeType: params.uri.endsWith('index.html') ? 'text/html;profile=mcp-app' : 'text/plain',
                text: params.uri.endsWith('index.html') ? '<main>App</main>' : 'x'.repeat(512 * 1024),
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);
        await open(handlers.get('mcpAppResourceOpen')!);

        await expect(readSecondary(
            handlers.get('mcpAppResourceRead')!,
            'ui://demo/large.txt',
        )).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_RESOURCE_TOO_LARGE', retryable: false }),
        });
    });

    it.each([
        ['absent visibility', undefined],
        ['explicit app visibility', { ui: { visibility: ['app'] } }],
    ])('calls a current-catalog tool with %s using only immutable authority', async (_case, meta) => {
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                runtimeStatus: 'connected',
                tools: {
                    refresh: {
                        name: 'refresh',
                        enabled: true,
                        inputSchema: {},
                        annotations: { readOnlyHint: true },
                        ...(meta ? { _meta: meta } : {}),
                    },
                },
            }],
        }));
        const { client, handlers, permissionHandler, registry } = createHarness({ listMcpServerStatus });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toMatchObject({ ok: true });
        expect(client.listMcpServerStatus).toHaveBeenCalledWith({
            threadId: 'thread-1',
            detail: 'toolsAndAuthOnly',
            limit: 100,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(client.callMcpTool.mock.calls[0][0]).toEqual({
            threadId: 'thread-1',
            server: 'demo',
            tool: 'refresh',
            arguments: { id: 1 },
            originCallId: 'call-1',
        });
        expect(client.callMcpTool.mock.calls[0][0]).not.toHaveProperty('connectorId');
        expect(client.callMcpTool.mock.calls[0][0]).not.toHaveProperty('accountId');
        expect(client.callMcpTool.mock.calls[0][0]).not.toHaveProperty('_meta');
        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    });

    it('normalizes the deprecated array tool catalog shape', async () => {
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                tools: [{
                    name: 'refresh',
                    enabled: true,
                    annotations: { readOnlyHint: true },
                    _meta: { 'ui/visibility': ['app'] },
                }],
            }],
        }));
        const { handlers, registry } = createHarness({ listMcpServerStatus });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toMatchObject({ ok: true });
    });

    it.each([
        ['unknown current status', { server: { runtimeStatus: 'mystery' }, tool: {} }],
        ['malformed current status', { server: { runtimeStatus: 1 }, tool: {} }],
        ['unknown deprecated status', { server: { status: 'mystery' }, tool: {} }],
        ['conflicting status shapes', { server: { runtimeStatus: 'connected', status: 'disabled' }, tool: {} }],
        ['malformed enabled flag', { server: {}, tool: { enabled: 'true' } }],
        ['malformed current visibility', { server: {}, tool: { _meta: { ui: { visibility: 'app' } } } }],
        ['unknown current visibility', { server: {}, tool: { _meta: { ui: { visibility: ['app', 'admin'] } } } }],
        ['malformed deprecated visibility', { server: {}, tool: { _meta: { 'ui/visibility': 'app' } } }],
        ['conflicting visibility shapes', {
            server: {},
            tool: { _meta: { ui: { visibility: ['app'] }, 'ui/visibility': ['model'] } },
        }],
        ['malformed risk annotations', {
            server: {},
            tool: { annotations: { readOnlyHint: true, destructiveHint: 'false' } },
        }],
    ])('fails closed for a present %s catalog control', async (_case, fixture) => {
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                ...fixture.server,
                tools: {
                    refresh: {
                        name: 'refresh',
                        inputSchema: {},
                        annotations: { readOnlyHint: true },
                        ...fixture.tool,
                    },
                },
            }],
        }));
        const { client, handlers, registry } = createHarness({ listMcpServerStatus });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TOOL_NOT_ALLOWED', retryable: false }),
        });
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it.each([
        ['explicit model-only visibility', {
            catalog: { enabled: true, _meta: { ui: { visibility: ['model'] } } },
            request: {},
        }],
        ['disabled catalog entry', {
            catalog: { enabled: false, _meta: { ui: { visibility: ['app'] } } },
            request: {},
        }],
        ['cross-server authority field', {
            catalog: { enabled: true, _meta: { ui: { visibility: ['app'] } } },
            request: { server: 'other-server' },
        }],
        ['connector mismatch', {
            catalog: {
                enabled: true,
                _meta: { ui: { visibility: ['app'] }, connectorId: 'connector-other' },
            },
            request: {},
        }],
    ])('rejects %s before direct execution', async (_case, fixture) => {
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                runtimeStatus: 'connected',
                tools: {
                    refresh: {
                        name: 'refresh',
                        inputSchema: {},
                        annotations: { readOnlyHint: true },
                        ...fixture.catalog,
                    },
                },
            }],
        }));
        const { client, handlers, registry } = createHarness({ listMcpServerStatus });
        bind(registry, { connectorId: 'connector-1' });
        registry.complete('call-1', undefined, true);

        await expect(callTool(
            handlers.get('mcpAppToolCall')!,
            'refresh',
            fixture.request,
        )).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TOOL_NOT_ALLOWED', retryable: false }),
        });
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it('refreshes the catalog for every call and rejects a tool removed from the new snapshot', async () => {
        const listMcpServerStatus = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    name: 'demo',
                    runtimeStatus: 'connected',
                    tools: {
                        refresh: {
                            name: 'refresh',
                            enabled: true,
                            inputSchema: {},
                            annotations: { readOnlyHint: true },
                        },
                    },
                }],
            })
            .mockResolvedValueOnce({
                data: [{ name: 'demo', runtimeStatus: 'connected', tools: {} }],
            });
        const { client, handlers, registry } = createHarness({ listMcpServerStatus });
        bind(registry);
        const handler = handlers.get('mcpAppToolCall')!;

        await expect(callTool(handler)).resolves.toMatchObject({ ok: true });
        await expect(callTool(handler)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TOOL_NOT_ALLOWED' }),
        });
        expect(listMcpServerStatus).toHaveBeenCalledTimes(2);
        expect(client.callMcpTool).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['oversized arguments', { payload: 'x'.repeat(256 * 1024) }],
        ['deep arguments', (() => {
            let value: Record<string, unknown> = { leaf: true };
            for (let index = 0; index < 33; index++) value = { nested: value };
            return value;
        })()],
    ])('rejects %s before catalog refresh or execution', async (_case, args) => {
        const { client, handlers, registry } = createHarness();
        bind(registry);

        await expect(callTool(
            handlers.get('mcpAppToolCall')!,
            'refresh',
            { arguments: args },
        )).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TOOL_NOT_ALLOWED', retryable: false }),
        });
        expect(client.listMcpServerStatus).not.toHaveBeenCalled();
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it.each([
        ['call ID', { callId: 'c'.repeat(257), tool: 'refresh' }],
        ['tool name', { callId: 'call-1', tool: '界'.repeat(100) }],
    ])('rejects an overlong %s before catalog refresh', async (_case, request) => {
        const { client, handlers, registry } = createHarness();
        bind(registry, { callId: request.callId });

        await expect(handlers.get('mcpAppToolCall')!({
            ...request,
            arguments: {},
        })).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TOOL_NOT_ALLOWED', retryable: false }),
        });
        expect(client.listMcpServerStatus).not.toHaveBeenCalled();
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it('strips caller connector and account metadata from an authorized tool call', async () => {
        const { client, handlers, registry } = createHarness();
        bind(registry, { connectorId: 'connector-1' });
        registry.complete('call-1', undefined, true);

        await expect(callTool(handlers.get('mcpAppToolCall')!, 'refresh', {
            _meta: {
                connectorId: 'connector-1',
                accountId: 'caller-account',
                trace: { requestId: 'caller-trace' },
            },
        })).resolves.toMatchObject({ ok: true });
        expect(client.callMcpTool.mock.calls[0][0]).toEqual({
            threadId: 'thread-1',
            server: 'demo',
            tool: 'refresh',
            arguments: { id: 1 },
            originCallId: 'call-1',
        });
    });

    it('prompts for risky tools and does not execute after denial', async () => {
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                runtimeStatus: 'connected',
                tools: {
                    mutate: {
                        name: 'mutate',
                        enabled: true,
                        inputSchema: {},
                        annotations: { readOnlyHint: false, destructiveHint: true },
                        _meta: { ui: { visibility: ['app'] } },
                    },
                },
            }],
        }));
        const handleToolCall = vi.fn(async () => ({ decision: 'denied' }));
        const { client, handlers, registry } = createHarness({ listMcpServerStatus, handleToolCall });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!, 'mutate')).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_PERMISSION_DENIED', retryable: false }),
        });
        expect(handleToolCall).toHaveBeenCalledWith(
            'mcp-app-call-1-1',
            'mcp__demo__mutate',
            { id: 1 },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it('uses one 30-second deadline across catalog, permission, and execution', async () => {
        vi.useFakeTimers();
        try {
            const catalog = deferred<any>();
            const permission = deferred<{ decision: 'approved' }>();
            const execution = deferred<any>();
            const listMcpServerStatus = vi.fn(() => catalog.promise);
            const handleToolCall = vi.fn(() => permission.promise);
            const callMcpTool = vi.fn(() => execution.promise);
            const { handlers, registry } = createHarness({ listMcpServerStatus, handleToolCall, callMcpTool });
            bind(registry);

            const pending = callTool(handlers.get('mcpAppToolCall')!, 'mutate');
            await vi.advanceTimersByTimeAsync(10_000);
            catalog.resolve({
                data: [{
                    name: 'demo',
                    runtimeStatus: 'connected',
                    tools: {
                        mutate: {
                            name: 'mutate',
                            enabled: true,
                            annotations: { readOnlyHint: false },
                            _meta: { ui: { visibility: ['app'] } },
                        },
                    },
                }],
            });
            await vi.advanceTimersByTimeAsync(15_000);
            permission.resolve({ decision: 'approved' });
            await vi.advanceTimersByTimeAsync(4_999);
            expect(callMcpTool).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toEqual({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_TIMEOUT', retryable: true }),
            });

            execution.resolve({ content: [{ type: 'text', text: 'late' }] });
            await Promise.resolve();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not start permission when the absolute deadline passes before its timer callback', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const catalog = deferred<any>();
            const listMcpServerStatus = vi.fn((_params: unknown, _options?: { signal?: AbortSignal }) => catalog.promise);
            const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
            const { client, handlers, registry } = createHarness({ listMcpServerStatus, handleToolCall });
            bind(registry);

            const pending = callTool(handlers.get('mcpAppToolCall')!, 'mutate');
            const operationSignal = listMcpServerStatus.mock.calls[0][1]?.signal;
            const onAbort = vi.fn();
            operationSignal?.addEventListener('abort', onAbort);
            vi.setSystemTime(30_000);
            expect(operationSignal?.aborted).toBe(false);

            catalog.resolve({
                data: [{
                    name: 'demo',
                    runtimeStatus: 'connected',
                    tools: {
                        mutate: {
                            name: 'mutate',
                            enabled: true,
                            annotations: { readOnlyHint: false },
                        },
                    },
                }],
            });

            await expect(pending).resolves.toEqual({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_TIMEOUT', retryable: true }),
            });
            expect(operationSignal?.aborted).toBe(true);
            expect(onAbort).toHaveBeenCalledTimes(1);
            expect(handleToolCall).not.toHaveBeenCalled();
            expect(client.callMcpTool).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not start direct execution when permission resolves after the absolute deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const permission = deferred<{ decision: 'approved' }>();
            const handleToolCall = vi.fn((
                _permissionId: string,
                _tool: string,
                _arguments: unknown,
                _options?: { signal?: AbortSignal },
            ) => permission.promise);
            const listMcpServerStatus = vi.fn(async () => ({
                data: [{
                    name: 'demo',
                    runtimeStatus: 'connected',
                    tools: {
                        mutate: {
                            name: 'mutate',
                            enabled: true,
                            annotations: { readOnlyHint: false },
                        },
                    },
                }],
            }));
            const { client, handlers, registry } = createHarness({ listMcpServerStatus, handleToolCall });
            bind(registry);

            const pending = callTool(handlers.get('mcpAppToolCall')!, 'mutate');
            for (let index = 0; index < 6 && handleToolCall.mock.calls.length === 0; index += 1) {
                await Promise.resolve();
            }
            expect(handleToolCall).toHaveBeenCalledTimes(1);
            const operationSignal = handleToolCall.mock.calls[0][3]?.signal;
            const onAbort = vi.fn();
            operationSignal?.addEventListener('abort', onAbort);
            vi.setSystemTime(30_000);
            expect(operationSignal?.aborted).toBe(false);

            permission.resolve({ decision: 'approved' });

            await expect(pending).resolves.toEqual({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_TIMEOUT', retryable: true }),
            });
            expect(operationSignal?.aborted).toBe(true);
            expect(onAbort).toHaveBeenCalledTimes(1);
            expect(client.callMcpTool).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('maps a Codex transport timeout to the safe App timeout envelope', async () => {
        const listMcpServerStatus = vi.fn(async () => {
            throw new CodexAppServerRequestTimeoutError('mcpServerStatus/list', 30_000);
        });
        const { client, handlers, registry } = createHarness({ listMcpServerStatus });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TIMEOUT', retryable: true }),
        });
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it('settles deferred permission calls on rebind, recovers slots, and blocks late execution', async () => {
        const permissions = Array.from({ length: 8 }, () => deferred<{ decision: 'approved' }>());
        let permissionIndex = 0;
        const handleToolCall = vi.fn(() => permissions[permissionIndex++].promise);
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                runtimeStatus: 'connected',
                tools: {
                    mutate: {
                        name: 'mutate',
                        enabled: true,
                        annotations: { readOnlyHint: false },
                        _meta: { ui: { visibility: ['app'] } },
                    },
                    refresh: {
                        name: 'refresh',
                        enabled: true,
                        annotations: { readOnlyHint: true },
                    },
                },
            }],
        }));
        const { client, handlers, registration, registry } = createHarness({ listMcpServerStatus, handleToolCall });
        bind(registry);
        const oldHandler = handlers.get('mcpAppToolCall')!;
        const operations = Array.from({ length: 8 }, () => callTool(oldHandler, 'mutate'));
        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledTimes(8));
        await expect(callTool(oldHandler, 'refresh')).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TIMEOUT', retryable: true }),
        });

        const replacementHandlers = new Map<string, Handler>();
        registration.rebind({
            registerHandler(method: string, handler: Handler) {
                replacementHandlers.set(method, handler);
            },
            unregisterHandler(method: string) {
                replacementHandlers.delete(method);
            },
        });

        await expect(Promise.all(operations)).resolves.toEqual(
            Array.from({ length: 8 }, () => ({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
            })),
        );
        await expect(callTool(replacementHandlers.get('mcpAppToolCall')!, 'refresh')).resolves.toMatchObject({ ok: true });

        for (const permission of permissions) permission.resolve({ decision: 'approved' });
        await Promise.resolve();
        expect(client.callMcpTool).toHaveBeenCalledTimes(1);
        expect(client.callMcpTool.mock.calls[0][0]).toMatchObject({ tool: 'refresh' });
    });

    it('settles a deferred permission on dispose without allowing late execution', async () => {
        const permission = deferred<{ decision: 'approved' }>();
        const handleToolCall = vi.fn(() => permission.promise);
        const listMcpServerStatus = vi.fn(async () => ({
            data: [{
                name: 'demo',
                runtimeStatus: 'connected',
                tools: {
                    mutate: {
                        name: 'mutate',
                        enabled: true,
                        annotations: { readOnlyHint: false },
                    },
                },
            }],
        }));
        const { client, handlers, registration, registry } = createHarness({ listMcpServerStatus, handleToolCall });
        bind(registry);
        const pending = callTool(handlers.get('mcpAppToolCall')!, 'mutate');
        await vi.waitFor(() => expect(handleToolCall).toHaveBeenCalledTimes(1));

        registration.dispose();

        await expect(pending).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
        });
        permission.resolve({ decision: 'approved' });
        await Promise.resolve();
        expect(client.callMcpTool).not.toHaveBeenCalled();
    });

    it.each([
        ['oversized result', { content: [], structuredContent: { payload: 'x'.repeat(512 * 1024) } }],
        ['deep result', (() => {
            let value: Record<string, unknown> = { leaf: true };
            for (let index = 0; index < 33; index++) value = { nested: value };
            return { content: [], structuredContent: value };
        })()],
    ])('returns a safe result-too-large envelope for an %s', async (_case, result) => {
        const callMcpTool = vi.fn(async () => result);
        const { handlers, registry } = createHarness({ callMcpTool });
        bind(registry);

        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_RESULT_TOO_LARGE', retryable: false }),
        });
    });

    it('caps concurrent App operations, recovers an exact cancelled slot, and aborts the rest on disconnect', async () => {
        const signals: AbortSignal[] = [];
        const pending = (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            if (!options?.signal) throw new Error('missing abort signal');
            signals.push(options.signal);
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        const readMcpResource = vi.fn(async (params: { uri: string }, options?: { signal?: AbortSignal }) => {
            if (params.uri.endsWith('index.html')) {
                return {
                    contents: [{
                        uri: params.uri,
                        mimeType: 'text/html;profile=mcp-app',
                        text: '<main>App</main>',
                    }],
                };
            }
            return await pending(params, options);
        });
        const callMcpTool = vi.fn(pending);
        const { handlers, registration, registry } = createHarness({ readMcpResource, callMcpTool });
        bind(registry);
        await open(handlers.get('mcpAppResourceOpen')!);

        const cancelledOperationId = '00000000-0000-4000-8000-000000000088';
        const cancelled = callTool(
            handlers.get('mcpAppToolCall')!,
            'refresh',
            { operationId: cancelledOperationId },
        );
        const operations = [cancelled, ...Array.from(
            { length: 7 },
            () => callTool(handlers.get('mcpAppToolCall')!),
        )];
        await vi.waitFor(() => expect(signals).toHaveLength(8));
        await expect(callTool(handlers.get('mcpAppToolCall')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_TIMEOUT', retryable: true }),
        });
        await expect(handlers.get('mcpAppOperationCancel')!({
            callId: 'call-1', operationId: cancelledOperationId,
        })).resolves.toEqual({ ok: true, value: {} });
        await expect(cancelled).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
        });
        const replacement = callTool(handlers.get('mcpAppToolCall')!);
        operations.push(replacement);
        await vi.waitFor(() => expect(signals).toHaveLength(9));

        registration.dispose();

        await expect(Promise.all(operations)).resolves.toEqual(
            expect.arrayContaining(Array.from({ length: 9 }, () => ({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE' }),
            }))),
        );
        expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it.each([
        ['URI', { uri: 'ui://demo/other.html', mimeType: 'text/html;profile=mcp-app', text: '<main>App</main>' }],
        ['MIME', { uri: 'ui://demo/index.html', mimeType: 'text/html', text: '<main>App</main>' }],
    ])('rejects a primary resource with a mismatched %s', async (_kind, content) => {
        const readMcpResource = vi.fn(async () => ({ contents: [content] }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_INVALID_RESOURCE' }),
        });
    });

    it('rejects HTML over the five MiB decoded limit before buffering it', async () => {
        const readMcpResource = vi.fn(async () => ({
            contents: [{
                uri: 'ui://demo/index.html',
                mimeType: 'text/html;profile=mcp-app',
                text: 'x'.repeat(MCP_APP_MAX_HTML_BYTES + 1),
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_RESOURCE_TOO_LARGE' }),
        });
    });

    it('converts malformed Codex resource responses into a safe invalid-resource envelope', async () => {
        const readMcpResource = vi.fn(async () => null) as any;
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);

        await expect(open(handlers.get('mcpAppResourceOpen')!)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_INVALID_RESOURCE', retryable: false }),
        });
    });

    it('returns fixed-size contiguous chunks with the verified hash metadata', async () => {
        const html = 'x'.repeat(MCP_APP_CHUNK_BYTES + 13);
        const readMcpResource = vi.fn(async () => ({
            contents: [{
                uri: 'ui://demo/index.html',
                mimeType: 'text/html;profile=mcp-app',
                text: html,
            }],
        }));
        const { handlers, registry } = createHarness({ readMcpResource });
        bind(registry);
        const resource = opened(await open(handlers.get('mcpAppResourceOpen')!));
        const chunkHandler = handlers.get('mcpAppResourceChunk')!;

        const first = await chunk(chunkHandler, resource.resourceId, 0);
        expect(first).toMatchObject({ ok: true, value: { offset: 0, nextOffset: MCP_APP_CHUNK_BYTES } });
        if (!first.ok) throw new Error(first.error.code);
        expect(Buffer.from(first.value.dataBase64, 'base64')).toHaveLength(MCP_APP_CHUNK_BYTES);

        const second = await chunk(chunkHandler, resource.resourceId, first.value.nextOffset!);
        expect(second).toMatchObject({ ok: true, value: { offset: MCP_APP_CHUNK_BYTES } });
        if (!second.ok) throw new Error(second.error.code);
        expect(second.value.nextOffset).toBeUndefined();
        expect(Buffer.from(second.value.dataBase64, 'base64').toString('utf8')).toBe('x'.repeat(13));
        expect(resource.sha256).toBe(createHash('sha256').update(html, 'utf8').digest('hex'));
    });

    it('issues distinct unguessable resource capabilities', async () => {
        const { handlers, registry } = createHarness();
        bind(registry, { callId: 'call-1' });
        bind(registry, { callId: 'call-2' });
        const openHandler = handlers.get('mcpAppResourceOpen')!;

        const first = opened(await open(openHandler, 'call-1'));
        const second = opened(await open(openHandler, 'call-2'));

        expect(first.resourceId).not.toBe(second.resourceId);
        expect(first.resourceId).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    });

    it('evicts the oldest buffered resource after eight active capabilities', async () => {
        const { handlers, registry } = createHarness();
        const openHandler = handlers.get('mcpAppResourceOpen')!;
        for (let index = 0; index <= MCP_APP_MAX_ACTIVE_RESOURCES; index++) {
            bind(registry, { callId: `call-${index}` });
        }
        const resources: McpAppResourceOpenResponse[] = [];
        for (let index = 0; index <= MCP_APP_MAX_ACTIVE_RESOURCES; index++) {
            resources.push(opened(await open(openHandler, `call-${index}`)));
        }

        await expect(chunk(handlers.get('mcpAppResourceChunk')!, resources[0].resourceId, 0)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_RESOURCE_NOT_FOUND' }),
        });
    });

    it('expires a resource two minutes after its last access', async () => {
        let now = 100;
        const { handlers, registry } = createHarness({ now: () => now });
        bind(registry);
        const resource = opened(await open(handlers.get('mcpAppResourceOpen')!));
        await chunk(handlers.get('mcpAppResourceChunk')!, resource.resourceId, 0);
        now += MCP_APP_RESOURCE_TTL_MS - 1;
        await expect(chunk(handlers.get('mcpAppResourceChunk')!, resource.resourceId, 0)).resolves.toMatchObject({ ok: true });
        now += MCP_APP_RESOURCE_TTL_MS + 1;

        await expect(chunk(handlers.get('mcpAppResourceChunk')!, resource.resourceId, 0)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_RESOURCE_NOT_FOUND' }),
        });
    });

    it('destroys an unopened resource at the two-minute expiry boundary', async () => {
        vi.useFakeTimers();
        try {
            const { handlers, registry } = createHarness();
            bind(registry);
            const resource = opened(await open(handlers.get('mcpAppResourceOpen')!));

            await vi.advanceTimersByTimeAsync(MCP_APP_RESOURCE_TTL_MS);

            await expect(chunk(handlers.get('mcpAppResourceChunk')!, resource.resourceId, 0)).resolves.toEqual({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_RESOURCE_NOT_FOUND' }),
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['expired', 'missing binding'] as const)(
        'clears the scheduled expiry timer when chunk access finds a %s resource',
        async (state) => {
            vi.useFakeTimers();
            try {
                let now = 100;
                const { handlers, registry } = createHarness({ now: () => now });
                bind(registry);
                const resource = opened(await open(handlers.get('mcpAppResourceOpen')!));
                expect(vi.getTimerCount()).toBe(1);

                if (state === 'expired') {
                    now += MCP_APP_RESOURCE_TTL_MS;
                } else {
                    registry.clear();
                }
                await chunk(handlers.get('mcpAppResourceChunk')!, resource.resourceId, 0);

                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('moves registered RPC methods to a replacement session manager', async () => {
        const { handlers, registration, registry } = createHarness();
        const replacementHandlers = new Map<string, Handler>();
        bind(registry);

        registration.rebind({
            registerHandler(method: string, handler: Handler) {
                replacementHandlers.set(method, handler);
            },
            unregisterHandler(method: string) {
                replacementHandlers.delete(method);
            },
        });

        expect(handlers.has('mcpAppResourceOpen')).toBe(false);
        expect(handlers.has('mcpAppResourceChunk')).toBe(false);
        await expect(open(replacementHandlers.get('mcpAppResourceOpen')!)).resolves.toMatchObject({ ok: true });
    });

    it('does not restore primary resource authority after a resolved-before-rebind read', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        try {
            const primary = deferred<any>();
            const readMcpResource = vi.fn((params: { uri: string }) => params.uri.endsWith('index.html')
                ? primary.promise
                : Promise.resolve({ contents: [{ uri: params.uri, text: 'secondary' }] }));
            const { client, handlers, registration, registry } = createHarness({ readMcpResource });
            bind(registry);
            const pendingOpen = open(handlers.get('mcpAppResourceOpen')!);
            await vi.waitFor(() => expect(readMcpResource).toHaveBeenCalledTimes(1));

            primary.resolve({
                contents: [{
                    uri: 'ui://demo/index.html',
                    mimeType: 'text/html;profile=mcp-app',
                    text: '<main>App</main>',
                    _meta: { ui: { csp: { resourceDomains: ['https://cdn.example.test'] } } },
                }],
            });
            const replacementHandlers = new Map<string, Handler>();
            registration.rebind({
                registerHandler(method: string, handler: Handler) {
                    replacementHandlers.set(method, handler);
                },
                unregisterHandler(method: string) {
                    replacementHandlers.delete(method);
                },
            });

            await expect(pendingOpen).resolves.toEqual({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE', retryable: true }),
            });
            await expect(readSecondary(
                replacementHandlers.get('mcpAppResourceRead')!,
                'https://cdn.example.test/data.json',
            )).resolves.toEqual({
                ok: false,
                error: expect.objectContaining({ code: 'MCP_APP_INVALID_RESOURCE', retryable: false }),
            });
            expect(client.readMcpResource).toHaveBeenCalledTimes(1);
            expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === MCP_APP_RESOURCE_TTL_MS)).toBe(false);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('unregisters and clears capabilities on session cleanup', async () => {
        const { handlers, registration, registry } = createHarness();
        bind(registry);
        const resource = opened(await open(handlers.get('mcpAppResourceOpen')!));

        registration.dispose();

        expect(handlers.has('mcpAppResourceOpen')).toBe(false);
        expect(handlers.has('mcpAppResourceChunk')).toBe(false);
        await expect(chunk(async (request) => registration.resourceChunk(request), resource.resourceId, 0)).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE' }),
        });
    });

    it('aborts an in-flight resource open when the session disconnects', async () => {
        let wasAborted = false;
        const readMcpResource = vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
            if (!options?.signal) throw new Error('missing abort signal');
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    wasAborted = true;
                    reject(new Error('aborted'));
                }, { once: true });
            });
        });
        const { handlers, registration, registry } = createHarness({ readMcpResource });
        bind(registry);

        const pending = open(handlers.get('mcpAppResourceOpen')!);
        await vi.waitFor(() => expect(readMcpResource).toHaveBeenCalledTimes(1));
        registration.dispose();

        await expect(pending).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'MCP_APP_SESSION_OFFLINE' }),
        });
        expect(wasAborted).toBe(true);
    });
});
