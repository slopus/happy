import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpAppPresentationV1, McpAppResultV1 } from '@slopus/happy-wire';
import {
    MCP_APP_MAX_CONCURRENT_BRIDGE_REQUESTS,
    MCP_APP_MAX_REQUESTS_PER_MINUTE,
    MCP_APP_INITIALIZE_TIMEOUT_MS,
    MCP_APP_SANDBOX_READY_TIMEOUT_MS,
    createMcpAppHostController,
} from './hostController';
import {
    McpAppHostError,
    type FrameMountInput,
    type McpAppFrame,
    type McpAppFrameAdapter,
    type McpAppBridgeRequest,
    type McpAppHostContext,
    type McpAppRemotePort,
    type McpAppResource,
    type McpAppToolResult,
} from './types';
import type { McpAppTelemetrySink } from './mcpAppTelemetry';

const presentation: McpAppPresentationV1 = {
    version: 1,
    server: 'demo',
    resourceUri: 'ui://demo/index.html',
};

const context: McpAppHostContext = {
    theme: 'light',
    locale: 'en',
    platform: 'web',
    touch: false,
    hover: true,
    container: { width: 640, height: 320 },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    displayMode: 'inline',
};

const resource: McpAppResource = {
    resourceId: 'resource-1',
    uri: presentation.resourceUri,
    mimeType: 'text/html;profile=mcp-app',
    byteLength: 14,
    sha256: '4db7ef630005c462450ea587722b1a7cff53dfdcd35d7dd40bcf8e97e50826ee',
    encoding: 'utf8',
    html: '<h1>hello</h1>',
};

const availableResult: McpAppResultV1 = {
    version: 1,
    state: 'available',
    content: [{ type: 'text', text: 'done' }],
    structuredContent: { ok: true },
    _meta: { view: 'safe-only-inside-frame' },
};

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

class MemoryRemotePort implements McpAppRemotePort {
    reads = 0;
    readonly readInputs: unknown[] = [];
    readonly secondaryInputs: unknown[] = [];
    readonly toolInputs: unknown[] = [];

    constructor(
        private readonly read: () => Promise<McpAppResource>,
        private readonly secondary: (input: unknown) => Promise<{ contents: unknown[] }> = async () => ({ contents: [] }),
        private readonly tool: (input: unknown) => Promise<McpAppToolResult> = async () => ({ content: [] }),
    ) {}

    async readResource(input: unknown): Promise<McpAppResource> {
        this.reads += 1;
        this.readInputs.push(input);
        return this.read();
    }

    async readSecondaryResource(input: unknown): Promise<{ contents: unknown[] }> {
        this.secondaryInputs.push(input);
        return this.secondary(input);
    }

    async callTool(input: unknown): Promise<McpAppToolResult> {
        this.toolInputs.push(input);
        return this.tool(input);
    }
}

class MemoryFrame implements McpAppFrame {
    constructor(
        private readonly events: string[],
        private readonly onToolResult: (result: McpAppToolResult) => void = () => {},
    ) {}

    sendToolInput(input: Record<string, unknown>): void {
        this.events.push(`input:${JSON.stringify(input)}`);
    }

    sendToolResult(result: McpAppToolResult): void {
        this.onToolResult(result);
        this.events.push(`result:${JSON.stringify(result.content)}`);
    }

    sendToolCancelled(reason: string): void {
        this.events.push(`cancel:${reason}`);
    }

    updateHostContext(next: McpAppHostContext): void {
        this.events.push(`context:${next.theme}`);
    }

    async teardown(): Promise<void> {
        this.events.push('teardown');
    }
}

class MemoryFrameAdapter implements McpAppFrameAdapter {
    mounts = 0;
    lastMountInput?: FrameMountInput;
    lastToolResult?: McpAppToolResult;

    constructor(
        private readonly events: string[],
        private readonly initialize: (input: FrameMountInput) => Promise<void> = async () => {},
    ) {}

    async mount(input: FrameMountInput): Promise<McpAppFrame> {
        this.mounts += 1;
        this.lastMountInput = input;
        this.events.push(`mount:${input.resource.html}`);
        input.onSandboxReady();
        this.events.push('sandbox-ready');
        await this.initialize(input);
        this.events.push('initialized');
        return new MemoryFrame(this.events, (result) => { this.lastToolResult = result; });
    }

    request(request: McpAppBridgeRequest, signal?: AbortSignal): Promise<unknown> {
        if (!this.lastMountInput) throw new Error('frame has not mounted');
        return this.lastMountInput.onRequest(request, signal);
    }
}

function makeController(options: {
    remotePort?: McpAppRemotePort;
    frameAdapter?: McpAppFrameAdapter;
    result?: McpAppResultV1;
    events?: string[];
    openExternalLink?: (url: string, signal: AbortSignal) => Promise<Record<string, never>>;
    now?: () => number;
    telemetry?: McpAppTelemetrySink;
}) {
    const events = options.events ?? [];
    const remotePort = options.remotePort ?? new MemoryRemotePort(async () => {
        events.push('resource-verified');
        return resource;
    });
    const frameAdapter = options.frameAdapter ?? new MemoryFrameAdapter(events);
    const controller = createMcpAppHostController({
        callId: 'call-1',
        presentation,
        input: { city: 'Hangzhou' },
        result: options.result,
        hostContext: context,
        remotePort,
        frameAdapter,
        openExternalLink: options.openExternalLink ?? (async () => ({})),
        now: options.now,
        telemetry: options.telemetry,
        onStateChange: (state) => events.push(`state:${state.type}`),
    });
    return { controller, events, remotePort, frameAdapter };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('MCP App host controller', () => {
    it('marks telemetry origin-scoped only for an exact-origin frame transport', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const adapter = new MemoryFrameAdapter([]);
        Object.assign(adapter, { originScoped: true as const });
        const { controller } = makeController({
            frameAdapter: adapter,
            telemetry: (eventName, payload) => { telemetryEvents.push([eventName, payload]); },
        });

        await controller.start();

        expect(telemetryEvents.map(([, payload]) => payload.originScoped)).toEqual([true, true]);
        expect(JSON.stringify(telemetryEvents)).not.toContain('ui://demo/index.html');
    });

    it('emits redacted render and action lifecycle events from real controller boundaries', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const telemetry: McpAppTelemetrySink = (eventName, payload) => {
            telemetryEvents.push([eventName, payload]);
        };
        const remote = new MemoryRemotePort(
            async () => resource,
            undefined,
            async () => ({ content: [{ type: 'text', text: 'CANARY_RESULT' }] }),
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter, telemetry });

        await controller.start();
        await adapter.request({
            method: 'tools/call',
            params: { name: 'CANARY_TOOL', arguments: { secret: 'CANARY_ARGUMENT' } },
        });

        expect(telemetryEvents.map(([eventName]) => eventName)).toEqual([
            'mcp_app_render_started',
            'mcp_app_render_succeeded',
            'mcp_app_tool_call_requested',
            'mcp_app_tool_call_resolved',
        ]);
        expect(telemetryEvents[1]?.[1]).toMatchObject({
            platform: 'web',
            stage: 'initialize',
            byteSizeBucket: 'under_1kb',
            originScoped: false,
            outcomeCode: 'succeeded',
        });
        expect(telemetryEvents[2]?.[1].byteSizeBucket).toBe('under_1kb');
        expect(telemetryEvents[3]?.[1]).toMatchObject({
            platform: 'web',
            stage: 'tool_call',
            originScoped: false,
            outcomeCode: 'succeeded',
            byteSizeBucket: 'under_1kb',
        });
        expect(JSON.stringify(telemetryEvents)).not.toMatch(/CANARY_(?:TOOL|ARGUMENT|RESULT)/);
    });

    it('emits a stable render failure outcome without raw errors', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const telemetry: McpAppTelemetrySink = (eventName, payload) => {
            telemetryEvents.push([eventName, payload]);
        };
        const remote = new MemoryRemotePort(async () => {
            throw new McpAppHostError(
                'MCP_APP_INVALID_RESOURCE',
                false,
                'CANARY_RAW_ERROR_MUST_NOT_APPEAR',
            );
        });
        const { controller } = makeController({ remotePort: remote, telemetry });

        await controller.start();

        expect(telemetryEvents.map(([eventName, payload]) => [eventName, payload.outcomeCode])).toEqual([
            ['mcp_app_render_started', 'started'],
            ['mcp_app_render_failed', 'MCP_APP_INVALID_RESOURCE'],
        ]);
        expect(JSON.stringify(telemetryEvents)).not.toContain('CANARY_RAW_ERROR_MUST_NOT_APPEAR');
    });

    it('resolves a rate-limited tool action with the stable timeout outcome', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const telemetry: McpAppTelemetrySink = (eventName, payload) => {
            telemetryEvents.push([eventName, payload]);
        };
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ frameAdapter: adapter, telemetry, now: () => 1_000 });
        await controller.start();
        telemetryEvents.length = 0;
        for (let index = 0; index < 30; index += 1) {
            await adapter.request({ method: 'ping', params: {} });
        }

        await expect(adapter.request({
            method: 'tools/call', params: { name: 'CANARY_RATE_LIMITED_TOOL' },
        })).rejects.toMatchObject({ code: 'MCP_APP_TIMEOUT' });

        expect(telemetryEvents.map(([eventName, payload]) => [eventName, payload.outcomeCode])).toEqual([
            ['mcp_app_tool_call_requested', 'started'],
            ['mcp_app_tool_call_resolved', 'MCP_APP_TIMEOUT'],
        ]);
        expect(JSON.stringify(telemetryEvents)).not.toContain('CANARY_RATE_LIMITED_TOOL');
    });

    it('preserves a View cancellation as the local action outcome exactly once', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            undefined,
            async (input) => new Promise((_resolve, reject) => {
                const signal = (input as { signal: AbortSignal }).signal;
                signal.addEventListener('abort', () => reject(new McpAppHostError(
                    'MCP_APP_SESSION_OFFLINE', true, 'downstream normalized cancellation',
                )), { once: true });
            }),
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({
            remotePort: remote,
            frameAdapter: adapter,
            telemetry: (eventName, payload) => { telemetryEvents.push([eventName, payload]); },
        });
        await controller.start();
        telemetryEvents.length = 0;
        const frameAbort = new AbortController();
        const pending = adapter.request({
            method: 'tools/call', params: { name: 'cancel-me' },
        }, frameAbort.signal);
        await vi.waitFor(() => expect(remote.toolInputs).toHaveLength(1));

        frameAbort.abort();
        await expect(pending).rejects.toMatchObject({ code: 'MCP_APP_SESSION_OFFLINE' });

        expect(telemetryEvents.map(([eventName, payload]) => [eventName, payload.outcomeCode])).toEqual([
            ['mcp_app_tool_call_requested', 'started'],
            ['mcp_app_tool_call_resolved', 'cancelled'],
        ]);
    });

    it('preserves the controller request deadline over a downstream offline error exactly once', async () => {
        vi.useFakeTimers();
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            undefined,
            async (input) => new Promise((_resolve, reject) => {
                const signal = (input as { signal: AbortSignal }).signal;
                signal.addEventListener('abort', () => reject(new McpAppHostError(
                    'MCP_APP_SESSION_OFFLINE', true, 'downstream normalized deadline',
                )), { once: true });
            }),
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({
            remotePort: remote,
            frameAdapter: adapter,
            telemetry: (eventName, payload) => { telemetryEvents.push([eventName, payload]); },
        });
        await controller.start();
        telemetryEvents.length = 0;
        const pending = adapter.request({ method: 'tools/call', params: { name: 'time-out' } });
        await vi.waitFor(() => expect(remote.toolInputs).toHaveLength(1));

        const rejected = expect(pending).rejects.toMatchObject({ code: 'MCP_APP_SESSION_OFFLINE' });
        await vi.advanceTimersByTimeAsync(30_000);
        await rejected;

        expect(telemetryEvents.map(([eventName, payload]) => [eventName, payload.outcomeCode])).toEqual([
            ['mcp_app_tool_call_requested', 'started'],
            ['mcp_app_tool_call_resolved', 'MCP_APP_TIMEOUT'],
        ]);
    });

    it('keeps controller disposal distinct from View cancellation and local timeout', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            undefined,
            async (input) => new Promise((_resolve, reject) => {
                const signal = (input as { signal: AbortSignal }).signal;
                signal.addEventListener('abort', () => reject(new McpAppHostError(
                    'MCP_APP_SESSION_OFFLINE', true, 'session disposed',
                )), { once: true });
            }),
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({
            remotePort: remote,
            frameAdapter: adapter,
            telemetry: (eventName, payload) => { telemetryEvents.push([eventName, payload]); },
        });
        await controller.start();
        telemetryEvents.length = 0;
        const pending = adapter.request({ method: 'tools/call', params: { name: 'offline' } });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'MCP_APP_SESSION_OFFLINE' });
        await vi.waitFor(() => expect(remote.toolInputs).toHaveLength(1));

        await controller.dispose();
        await rejected;

        expect(telemetryEvents.map(([eventName, payload]) => [eventName, payload.outcomeCode])).toEqual([
            ['mcp_app_tool_call_requested', 'started'],
            ['mcp_app_tool_call_resolved', 'MCP_APP_SESSION_OFFLINE'],
        ]);
    });

    it('uses the unknown request byte bucket when telemetry serialization fails safely', async () => {
        const telemetryEvents: Array<Parameters<McpAppTelemetrySink>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            undefined,
            async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({
            remotePort: remote,
            frameAdapter: adapter,
            telemetry: (eventName, payload) => { telemetryEvents.push([eventName, payload]); },
        });
        await controller.start();
        telemetryEvents.length = 0;
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        await expect(adapter.request({
            method: 'tools/call', params: { name: 'safe-size', arguments: cyclic },
        })).resolves.toMatchObject({ content: expect.any(Array) });

        expect(telemetryEvents.map(([eventName, payload]) => [
            eventName,
            payload.byteSizeBucket,
        ])).toEqual([
            ['mcp_app_tool_call_requested', 'unknown'],
            ['mcp_app_tool_call_resolved', 'under_1kb'],
        ]);
    });

    it('enforces resource, sandbox, initialize, input, buffered result, active ordering', async () => {
        const { controller, events } = makeController({ result: availableResult });

        await controller.start();

        expect(events).toEqual([
            'state:loading-resource',
            'resource-verified',
            'state:loading-sandbox',
            'mount:<h1>hello</h1>',
            'state:initializing',
            'sandbox-ready',
            'initialized',
            'input:{"city":"Hangzhou"}',
            'result:[{"type":"text","text":"done"}]',
            'state:active',
        ]);
        expect(controller.getState()).toEqual({ type: 'active' });
    });

    it('omits null result metadata before notifying the MCP App SDK', async () => {
        const adapter = new MemoryFrameAdapter([]);
        const result = {
            ...availableResult,
            _meta: null,
        } as unknown as McpAppResultV1;
        const { controller } = makeController({ frameAdapter: adapter, result });

        await controller.start();

        expect(adapter.lastToolResult).toEqual({
            content: [{ type: 'text', text: 'done' }],
            structuredContent: { ok: true },
        });
    });

    it('buffers cancellation until initialization and sends input first', async () => {
        const gate = deferred<void>();
        const events: string[] = [];
        const adapter = new MemoryFrameAdapter(events, async () => gate.promise);
        const { controller } = makeController({ events, frameAdapter: adapter });
        const starting = controller.start();
        await Promise.resolve();
        await Promise.resolve();

        controller.updateToolCall({ state: 'cancelled', cancellationReason: 'Stopped by user' });
        gate.resolve();
        await starting;

        expect(events.filter((event) => (
            event === 'input:{"city":"Hangzhou"}' || event === 'cancel:Stopped by user'
        ))).toEqual([
            'input:{"city":"Hangzhou"}',
            'cancel:Stopped by user',
        ]);
        expect(events.filter((event) => event.startsWith('cancel:'))).toEqual(['cancel:Stopped by user']);
    });

    it('delivers repeated terminal result or cancellation updates at most once after activation', async () => {
        const resultEvents: string[] = [];
        const { controller: resultController } = makeController({ events: resultEvents });
        await resultController.start();

        await resultController.updateToolCall({ state: 'completed', result: availableResult });
        await resultController.updateToolCall({ state: 'completed', result: availableResult });
        await resultController.updateToolCall({ state: 'cancelled', cancellationReason: 'late cancellation' });

        expect(resultEvents.filter((event) => (
            event.startsWith('result:') || event.startsWith('cancel:')
        ))).toEqual([
            'result:[{"type":"text","text":"done"}]',
        ]);

        const cancellationEvents: string[] = [];
        const { controller: cancellationController } = makeController({ events: cancellationEvents });
        await cancellationController.start();

        await cancellationController.updateToolCall({ state: 'cancelled', cancellationReason: 'Stopped by user' });
        await cancellationController.updateToolCall({ state: 'cancelled', cancellationReason: 'Stopped by user' });
        await cancellationController.updateToolCall({ state: 'completed', result: availableResult });

        expect(cancellationEvents.filter((event) => (
            event.startsWith('result:') || event.startsWith('cancel:')
        ))).toEqual([
            'cancel:Stopped by user',
        ]);
    });

    it('waits without polling and retries origin once only after a new terminal update', async () => {
        vi.useFakeTimers();
        let first = true;
        const remote = new MemoryRemotePort(async () => {
            if (first) {
                first = false;
                throw new McpAppHostError(
                    'MCP_APP_ORIGIN_MISMATCH',
                    true,
                    'Waiting for the trusted App origin.',
                );
            }
            return resource;
        });
        const { controller } = makeController({ remotePort: remote });

        await controller.start();
        expect(controller.getState()).toEqual({ type: 'waiting-for-origin' });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(remote.reads).toBe(1);

        await controller.updateToolCall({ state: 'completed', result: availableResult });
        expect(remote.reads).toBe(2);
        expect(controller.getState()).toEqual({ type: 'active' });

        await controller.updateToolCall({ state: 'completed', result: availableResult });
        expect(remote.reads).toBe(2);
    });

    it('keeps an unavailable oversized result on static fallback', async () => {
        const remote = new MemoryRemotePort(async () => resource);
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({
            remotePort: remote,
            frameAdapter: adapter,
            result: { version: 1, state: 'unavailable', code: 'MCP_APP_RESULT_TOO_LARGE' },
        });

        await controller.start();

        expect(controller.getState()).toEqual({ type: 'fallback' });
        expect(remote.reads).toBe(0);
        expect(adapter.mounts).toBe(0);
    });

    it('uses independent ten-second sandbox-ready and initialize deadlines', async () => {
        expect(MCP_APP_SANDBOX_READY_TIMEOUT_MS).toBe(10_000);
        expect(MCP_APP_INITIALIZE_TIMEOUT_MS).toBe(10_000);
        vi.useFakeTimers();
        const neverReady: McpAppFrameAdapter = {
            mount: async (input) => new Promise((_resolve, reject) => {
                input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
            }),
        };
        const { controller } = makeController({ frameAdapter: neverReady });
        const starting = controller.start();
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(10_000);
        await starting;

        expect(controller.getState()).toMatchObject({
            type: 'failed',
            error: { code: 'MCP_APP_TIMEOUT', retryable: true },
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('starts a fresh ten-second deadline after sandbox ready', async () => {
        vi.useFakeTimers();
        const neverInitializes: McpAppFrameAdapter = {
            mount: async (input) => {
                input.onSandboxReady();
                return new Promise((_resolve, reject) => {
                    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
                });
            },
        };
        const { controller } = makeController({ frameAdapter: neverInitializes });
        const starting = controller.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(controller.getState()).toEqual({ type: 'initializing' });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(controller.getState()).toEqual({ type: 'initializing' });
        await vi.advanceTimersByTimeAsync(1);
        await starting;

        expect(controller.getState()).toMatchObject({
            type: 'failed',
            error: { code: 'MCP_APP_TIMEOUT', retryable: true },
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('tears down frame state and ignores late async work after dispose', async () => {
        vi.useFakeTimers();
        const readGate = deferred<McpAppResource>();
        const remote = new MemoryRemotePort(async () => readGate.promise);
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter });
        const starting = controller.start();
        await Promise.resolve();

        await controller.dispose();
        readGate.resolve(resource);
        await starting;

        expect(controller.getState()).toEqual({ type: 'fallback' });
        expect(adapter.mounts).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('allows only one user retry for retryable failures', async () => {
        const remote = new MemoryRemotePort(async () => {
            throw new McpAppHostError('MCP_APP_SESSION_OFFLINE', true, 'offline');
        });
        const { controller } = makeController({ remotePort: remote });

        await controller.start();
        await controller.retry();
        await controller.retry();

        expect(remote.reads).toBe(2);
        expect(controller.getState()).toMatchObject({ type: 'failed' });
    });

    it('tears down the bridge before aborting adapter listeners on active disposal', async () => {
        vi.useFakeTimers();
        const events: string[] = [];
        const adapter: McpAppFrameAdapter = {
            async mount(input) {
                input.signal.addEventListener('abort', () => events.push('listener-aborted'), { once: true });
                input.onSandboxReady();
                return new MemoryFrame(events);
            },
        };
        const { controller } = makeController({ events, frameAdapter: adapter });
        await controller.start();

        await controller.dispose();

        expect(events.filter((event) => (
            event === 'teardown' || event === 'listener-aborted' || event === 'state:fallback'
        ))).toEqual([
            'teardown',
            'listener-aborted',
            'state:fallback',
        ]);
        expect(controller.getState()).toEqual({ type: 'fallback' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('tears down and leaves active state when the mounted frame later fails', async () => {
        const events: string[] = [];
        let reportFailure: ((error: McpAppHostError) => void) | undefined;
        const adapter: McpAppFrameAdapter = {
            async mount(input) {
                input.onSandboxReady();
                reportFailure = input.onFailure;
                return new MemoryFrame(events);
            },
        };
        const { controller } = makeController({ events, frameAdapter: adapter });
        await controller.start();
        expect(controller.getState()).toEqual({ type: 'active' });
        expect(reportFailure).toEqual(expect.any(Function));

        reportFailure!(new McpAppHostError(
            'MCP_APP_BRIDGE_PROTOCOL', false, 'sensitive protocol detail',
        ));
        await vi.waitFor(() => expect(controller.getState()).toMatchObject({
            type: 'failed',
            error: { code: 'MCP_APP_BRIDGE_PROTOCOL', retryable: false },
        }));

        expect(events.filter((event) => event === 'teardown' || event === 'state:failed')).toEqual([
            'teardown',
            'state:failed',
        ]);
    });

    it('ignores a late frame failure after disposal', async () => {
        let reportFailure: ((error: McpAppHostError) => void) | undefined;
        const adapter: McpAppFrameAdapter = {
            async mount(input) {
                input.onSandboxReady();
                reportFailure = input.onFailure;
                return new MemoryFrame([]);
            },
        };
        const { controller } = makeController({ frameAdapter: adapter });
        await controller.start();
        await controller.dispose();

        reportFailure!(new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', true, 'late failure'));
        await Promise.resolve();

        expect(controller.getState()).toEqual({ type: 'fallback' });
    });

    it('correlates resource, tool, ping, and link requests through immutable call authority', async () => {
        const remote = new MemoryRemotePort(
            async () => resource,
            async () => ({ contents: [{ uri: 'ui://demo/detail', text: 'detail' }] }),
            async () => ({ content: [{ type: 'text', text: 'refreshed' }] }),
        );
        const openExternalLink = vi.fn(async () => ({}));
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({
            remotePort: remote,
            frameAdapter: adapter,
            openExternalLink,
        });
        await controller.start();

        await expect(adapter.request({
            method: 'resources/read',
            params: { uri: 'ui://demo/detail' },
        })).resolves.toEqual({ contents: [{ uri: 'ui://demo/detail', text: 'detail' }] });
        await expect(adapter.request({
            method: 'tools/call',
            params: {
                name: 'refresh',
                arguments: { id: 1 },
                _meta: { progressToken: 'view-token' },
            },
        })).resolves.toEqual({ content: [{ type: 'text', text: 'refreshed' }] });
        await expect(adapter.request({ method: 'ping', params: {} })).resolves.toEqual({});
        await expect(adapter.request({
            method: 'ui/open-link', params: { url: 'https://example.com/path' },
        })).resolves.toEqual({});

        expect(remote.secondaryInputs).toEqual([expect.objectContaining({
            callId: 'call-1', uri: 'ui://demo/detail', signal: expect.any(AbortSignal),
        })]);
        expect(remote.toolInputs).toEqual([expect.objectContaining({
            callId: 'call-1',
            tool: 'refresh',
            arguments: { id: 1 },
            _meta: { progressToken: 'view-token' },
            signal: expect.any(AbortSignal),
        })]);
        expect(openExternalLink).toHaveBeenCalledWith(
            'https://example.com/path', expect.any(AbortSignal),
        );
        for (const input of [...remote.secondaryInputs, ...remote.toolInputs]) {
            expect(input).not.toHaveProperty('threadId');
            expect(input).not.toHaveProperty('server');
            expect(input).not.toHaveProperty('connectorId');
            expect(input).not.toHaveProperty('originCallId');
        }
    });

    it('preserves stable permission denial without leaking raw tool context', async () => {
        const remote = new MemoryRemotePort(
            async () => resource,
            undefined,
            async () => {
                throw new McpAppHostError(
                    'MCP_APP_PERMISSION_DENIED', false, 'Permission was denied.',
                );
            },
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter });
        await controller.start();

        await expect(adapter.request({
            method: 'tools/call',
            params: { name: 'dangerous', arguments: { secret: 'CANARY_ARGUMENT' } },
        })).rejects.toEqual(expect.objectContaining({
            code: 'MCP_APP_PERMISSION_DENIED',
            retryable: false,
            summary: 'Permission was denied.',
        }));
    });

    it('limits each View to eight concurrent requests and thirty requests per minute', async () => {
        expect(MCP_APP_MAX_CONCURRENT_BRIDGE_REQUESTS).toBe(8);
        expect(MCP_APP_MAX_REQUESTS_PER_MINUTE).toBe(30);
        let now = 1_000;
        const pendingReads: Array<ReturnType<typeof deferred<{ contents: unknown[] }>>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            async () => {
                const gate = deferred<{ contents: unknown[] }>();
                pendingReads.push(gate);
                return gate.promise;
            },
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter, now: () => now });
        await controller.start();

        const firstEight = Array.from({ length: 8 }, (_, index) => adapter.request({
            method: 'resources/read' as const,
            params: { uri: `ui://demo/${index}` },
        }));
        await vi.waitFor(() => expect(pendingReads).toHaveLength(8));
        await expect(adapter.request({
            method: 'resources/read', params: { uri: 'ui://demo/overflow' },
        })).rejects.toMatchObject({ code: 'MCP_APP_TIMEOUT', retryable: true });
        pendingReads.forEach((gate) => gate.resolve({ contents: [] }));
        await Promise.all(firstEight);

        for (let index = 9; index < 30; index += 1) {
            await expect(adapter.request({ method: 'ping', params: {} })).resolves.toEqual({});
        }
        await expect(adapter.request({ method: 'ping', params: {} })).rejects.toMatchObject({
            code: 'MCP_APP_TIMEOUT', retryable: true,
        });

        now += 60_001;
        await expect(adapter.request({ method: 'ping', params: {} })).resolves.toEqual({});
    });

    it('holds a cancelled slot until the remote authenticated cancellation settles', async () => {
        const pendingReads: Array<ReturnType<typeof deferred<{ contents: unknown[] }>>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            async () => {
                const gate = deferred<{ contents: unknown[] }>();
                pendingReads.push(gate);
                return gate.promise;
            },
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter });
        await controller.start();
        const signals = Array.from({ length: 8 }, () => new AbortController());
        const requests = signals.map((signal, index) => adapter.request({
            method: 'resources/read', params: { uri: `ui://demo/${index}` },
        }, signal.signal));
        await vi.waitFor(() => expect(pendingReads).toHaveLength(8));
        await expect(adapter.request({
            method: 'resources/read', params: { uri: 'ui://demo/blocked' },
        })).rejects.toMatchObject({ code: 'MCP_APP_TIMEOUT' });

        signals[0].abort();
        let firstSettled = false;
        void requests[0].finally(() => { firstSettled = true; }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(firstSettled).toBe(false);
        expect((remote.secondaryInputs[0] as { signal: AbortSignal }).signal.aborted).toBe(true);
        await expect(adapter.request({ method: 'ping', params: {} })).rejects.toMatchObject({
            code: 'MCP_APP_TIMEOUT',
        });

        pendingReads[0].reject(new McpAppHostError(
            'MCP_APP_SESSION_OFFLINE', true, 'The session is no longer available.',
        ));
        await expect(requests[0]).rejects.toMatchObject({ code: 'MCP_APP_SESSION_OFFLINE' });
        await expect(adapter.request({ method: 'ping', params: {} })).resolves.toEqual({});

        pendingReads.slice(1).forEach((gate) => gate.resolve({ contents: [] }));
        await Promise.all(requests.slice(1));
    });

    it('releases the held cancellation slot at the remote five-second wall-clock deadline', async () => {
        vi.useFakeTimers();
        const pendingReads: Array<ReturnType<typeof deferred<{ contents: unknown[] }>>> = [];
        const remote = new MemoryRemotePort(
            async () => resource,
            async (input) => {
                const gate = deferred<{ contents: unknown[] }>();
                const signal = (input as { signal: AbortSignal }).signal;
                signal.addEventListener('abort', () => {
                    setTimeout(() => gate.reject(new McpAppHostError(
                        'MCP_APP_SESSION_OFFLINE', true, 'The session is no longer available.',
                    )), 5_000);
                }, { once: true });
                pendingReads.push(gate);
                return gate.promise;
            },
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter });
        await controller.start();
        const signals = Array.from({ length: 8 }, () => new AbortController());
        const requests = signals.map((signal, index) => adapter.request({
            method: 'resources/read', params: { uri: `ui://demo/deadline-${index}` },
        }, signal.signal));
        await vi.waitFor(() => expect(pendingReads).toHaveLength(8));

        const firstRejected = expect(requests[0]).rejects.toMatchObject({
            code: 'MCP_APP_SESSION_OFFLINE',
        });
        signals[0].abort();
        await vi.advanceTimersByTimeAsync(4_999);
        await expect(adapter.request({ method: 'ping', params: {} })).rejects.toMatchObject({
            code: 'MCP_APP_TIMEOUT',
        });
        await vi.advanceTimersByTimeAsync(1);

        await firstRejected;
        await expect(adapter.request({ method: 'ping', params: {} })).resolves.toEqual({});
        pendingReads.slice(1).forEach((gate) => gate.resolve({ contents: [] }));
        await Promise.all(requests.slice(1));
    });

    it('rejects a serialized bridge response over 256 KiB with a stable safe code', async () => {
        const remote = new MemoryRemotePort(
            async () => resource,
            async () => ({
                contents: [{ uri: 'ui://demo/large', text: 'x'.repeat(256 * 1024) }],
            }),
            async () => ({
                content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }],
            }),
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter });
        await controller.start();

        await expect(adapter.request({
            method: 'resources/read', params: { uri: 'ui://demo/large' },
        })).rejects.toMatchObject({
            code: 'MCP_APP_RESOURCE_TOO_LARGE', retryable: false,
        });
        await expect(adapter.request({
            method: 'tools/call', params: { name: 'large' },
        })).rejects.toMatchObject({
            code: 'MCP_APP_RESULT_TOO_LARGE', retryable: false,
        });
    });

    it('aborts in-flight requests and makes late completions inert after disposal', async () => {
        const gate = deferred<{ contents: unknown[] }>();
        let requestSignal: AbortSignal | undefined;
        const remote = new MemoryRemotePort(
            async () => resource,
            async (input) => {
                requestSignal = (input as { signal: AbortSignal }).signal;
                return gate.promise;
            },
        );
        const adapter = new MemoryFrameAdapter([]);
        const { controller } = makeController({ remotePort: remote, frameAdapter: adapter });
        await controller.start();

        const pending = adapter.request({
            method: 'resources/read', params: { uri: 'ui://demo/late' },
        });
        await vi.waitFor(() => expect(requestSignal).toEqual(expect.any(AbortSignal)));
        await controller.dispose();

        expect(requestSignal?.aborted).toBe(true);
        let requestSettled = false;
        void pending.finally(() => { requestSettled = true; }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(requestSettled).toBe(false);
        gate.resolve({ contents: [{ uri: 'ui://demo/late', text: 'CANARY_LATE_RESULT' }] });
        await expect(pending).rejects.toMatchObject({
            code: 'MCP_APP_SESSION_OFFLINE', retryable: true,
        });
        await Promise.resolve();
        expect(controller.getState()).toEqual({ type: 'fallback' });
    });
});
