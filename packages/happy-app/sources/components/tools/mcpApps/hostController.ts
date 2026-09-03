import type { McpAppPresentationV1, McpAppResultV1 } from '@slopus/happy-wire';
import {
    McpAppHostError,
    type McpAppBridgeRequest,
    type McpAppFrame,
    type McpAppFrameAdapter,
    type McpAppHostContext,
    type McpAppRemotePort,
    type McpAppToolResult,
} from './types';
import {
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    utf8ByteLength,
} from '../../../../mcp-app-sandbox/protocol';
import {
    emitMcpAppTelemetry,
    type McpAppTelemetryEventName,
    type McpAppTelemetryInput,
    type McpAppTelemetrySink,
} from './mcpAppTelemetry';
import { boundedJsonUtf8ByteLength } from './boundedJsonUtf8ByteLength';

export const MCP_APP_SANDBOX_READY_TIMEOUT_MS = 10_000;
export const MCP_APP_INITIALIZE_TIMEOUT_MS = 10_000;
export const MCP_APP_MAX_CONCURRENT_BRIDGE_REQUESTS = 8;
export const MCP_APP_MAX_REQUESTS_PER_MINUTE = 30;
export const MCP_APP_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

export type McpAppHostState =
    | { type: 'fallback' }
    | { type: 'waiting-for-origin' }
    | { type: 'loading-resource' }
    | { type: 'loading-sandbox' }
    | { type: 'initializing' }
    | { type: 'active' }
    | { type: 'failed'; error: McpAppHostError };

export type McpAppToolCallUpdate = {
    state: 'running' | 'completed' | 'error' | 'cancelled';
    result?: McpAppResultV1;
    cancellationReason?: string;
};

type PendingDelivery =
    | { type: 'result'; result: McpAppToolResult }
    | { type: 'cancelled'; reason: string };

function safeInternalError(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_INTERNAL',
        true,
        'The App could not be loaded.',
    );
}

function safeRequestInternalError(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_INTERNAL',
        false,
        'The App request could not be completed.',
    );
}

function cancellationError(): McpAppHostError {
    return new McpAppHostError(
        'MCP_APP_SESSION_OFFLINE',
        true,
        'The session is no longer available.',
    );
}

function timeoutError(): McpAppHostError {
    return new McpAppHostError('MCP_APP_TIMEOUT', true, 'The App request timed out.');
}

function normalizeError(error: unknown): McpAppHostError {
    return error instanceof McpAppHostError ? error : safeInternalError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function availableResult(result: McpAppResultV1, isError: boolean): McpAppToolResult | undefined {
    if (result.state !== 'available') return undefined;
    return {
        content: result.content,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
        ...(isError ? { isError: true } : {}),
    };
}

function abortReason(signal: AbortSignal): McpAppHostError {
    return signal.reason instanceof McpAppHostError ? signal.reason : cancellationError();
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    let remove = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        remove = () => signal.removeEventListener('abort', onAbort);
    });
    return Promise.race([promise, aborted]).finally(remove);
}

function createStageDeadline(controller: AbortController) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        arm(timeoutMs: number): void {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
        },
        clear(): void {
            if (timer) clearTimeout(timer);
            timer = undefined;
        },
    };
}

function responseTooLarge(method: McpAppBridgeRequest['method']): McpAppHostError {
    return new McpAppHostError(
        method === 'resources/read' ? 'MCP_APP_RESOURCE_TOO_LARGE' : 'MCP_APP_RESULT_TOO_LARGE',
        false,
        method === 'resources/read' ? 'The App resource is too large.' : 'The App result is too large.',
    );
}

function validateBridgeResponse(value: unknown, method: McpAppBridgeRequest['method']): unknown {
    try {
        const serialized = JSON.stringify({ ok: true, value });
        if (serialized === undefined || utf8ByteLength(serialized) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
            throw responseTooLarge(method);
        }
        return value;
    } catch (error) {
        if (error instanceof McpAppHostError) throw error;
        throw safeRequestInternalError();
    }
}

function telemetrySerializedByteLength(value: unknown): number {
    return boundedJsonUtf8ByteLength(value, {
        maxBytes: MCP_APP_MAX_BRIDGE_MESSAGE_BYTES + 1,
        maxDepth: 32,
        maxNodes: MCP_APP_MAX_BRIDGE_MESSAGE_BYTES + 1,
    }) ?? Number.NaN;
}

export function createMcpAppHostController(options: {
    callId: string;
    presentation: McpAppPresentationV1;
    input: Record<string, unknown>;
    result?: McpAppResultV1;
    hostContext: McpAppHostContext;
    remotePort: McpAppRemotePort;
    frameAdapter: McpAppFrameAdapter;
    openExternalLink(url: string, signal: AbortSignal): Promise<Record<string, never>>;
    now?: () => number;
    onStateChange?: (state: McpAppHostState) => void;
    telemetry?: McpAppTelemetrySink;
}) {
    let state: McpAppHostState = { type: 'fallback' };
    let hostContext = options.hostContext;
    let currentResult = options.result;
    let pendingDelivery: PendingDelivery | undefined = currentResult?.state === 'available'
        ? { type: 'result', result: availableResult(currentResult, false)! }
        : undefined;
    let terminalDeliveryAccepted = pendingDelivery !== undefined;
    let frame: McpAppFrame | undefined;
    let activeController: AbortController | undefined;
    let loadPromise: Promise<void> | undefined;
    let disposed = false;
    let started = false;
    let generation = 0;
    let originRetryUsed = false;
    let userRetryUsed = false;
    let inputSent = false;
    let terminalSent = false;
    const now = options.now ?? Date.now;
    const requestControllers = new Set<AbortController>();
    const requestTimestamps: number[] = [];
    const resultIsUnavailable = (): boolean => currentResult?.state === 'unavailable';
    const emitTelemetry = (
        eventName: McpAppTelemetryEventName,
        input: Omit<McpAppTelemetryInput, 'platform' | 'originScoped'>,
    ): void => {
        emitMcpAppTelemetry(eventName, {
            ...input,
            platform: hostContext.platform,
            originScoped: options.frameAdapter.originScoped === true,
        }, options.telemetry);
    };

    const setState = (next: McpAppHostState): void => {
        state = next;
        options.onStateChange?.(next);
    };

    const teardownFrame = async (): Promise<void> => {
        for (const controller of requestControllers) controller.abort(cancellationError());
        requestControllers.clear();
        requestTimestamps.length = 0;
        const ownedFrame = frame;
        frame = undefined;
        if (ownedFrame) {
            try {
                await ownedFrame.teardown();
            } catch {
                // Teardown is best-effort; the adapter must still release its outer frame.
            }
        }
        activeController?.abort(cancellationError());
        activeController = undefined;
        inputSent = false;
        terminalSent = false;
    };

    const handleBridgeRequest = async (
        request: McpAppBridgeRequest,
        frameSignal?: AbortSignal,
    ): Promise<unknown> => {
        if (disposed || activeController?.signal.aborted) throw cancellationError();
        const telemetryStartedAt = Date.now();
        const requestByteLength = telemetrySerializedByteLength(request);
        const emitToolResolved = (
            code: McpAppTelemetryInput['code'],
            byteLength = Number.NaN,
        ): void => {
            if (request.method !== 'tools/call') return;
            emitTelemetry('mcp_app_tool_call_resolved', {
                stage: 'tool_call',
                durationMs: Math.max(0, Date.now() - telemetryStartedAt),
                byteLength,
                code,
            });
        };
        if (request.method === 'tools/call') {
            emitTelemetry('mcp_app_tool_call_requested', {
                stage: 'tool_call',
                durationMs: 0,
                byteLength: requestByteLength,
                code: 'started',
            });
        }
        const currentTime = now();
        while (requestTimestamps.length > 0
            && requestTimestamps[0] <= currentTime - 60_000) {
            requestTimestamps.shift();
        }
        if (requestTimestamps.length >= MCP_APP_MAX_REQUESTS_PER_MINUTE) {
            emitToolResolved('MCP_APP_TIMEOUT');
            throw timeoutError();
        }
        requestTimestamps.push(currentTime);
        if (requestControllers.size >= MCP_APP_MAX_CONCURRENT_BRIDGE_REQUESTS) {
            emitToolResolved('MCP_APP_TIMEOUT');
            throw timeoutError();
        }

        const operation = new AbortController();
        let localTerminationCode: 'cancelled' | 'MCP_APP_TIMEOUT' | undefined;
        requestControllers.add(operation);
        const abortFromFrame = () => {
            if (operation.signal.aborted) return;
            localTerminationCode = 'cancelled';
            operation.abort(cancellationError());
        };
        frameSignal?.addEventListener('abort', abortFromFrame, { once: true });
        if (frameSignal?.aborted) abortFromFrame();
        const timer = setTimeout(
            () => {
                if (operation.signal.aborted) return;
                localTerminationCode = 'MCP_APP_TIMEOUT';
                operation.abort(timeoutError());
            },
            MCP_APP_BRIDGE_REQUEST_TIMEOUT_MS,
        );
        try {
            let result: unknown;
            switch (request.method) {
                case 'ping':
                    result = {};
                    break;
                case 'resources/read':
                    result = await options.remotePort.readSecondaryResource({
                        callId: options.callId,
                        uri: request.params.uri,
                        signal: operation.signal,
                    });
                    break;
                case 'tools/call':
                    result = await options.remotePort.callTool({
                        callId: options.callId,
                        tool: request.params.name,
                        ...(request.params.arguments !== undefined
                            ? { arguments: request.params.arguments }
                            : {}),
                        ...(request.params._meta !== undefined ? { _meta: request.params._meta } : {}),
                        signal: operation.signal,
                    });
                    break;
                case 'ui/open-link':
                    result = await raceAbort(
                        options.openExternalLink(request.params.url, operation.signal),
                        operation.signal,
                    );
                    break;
            }
            if (disposed || operation.signal.aborted || !requestControllers.has(operation)) {
                throw abortReason(operation.signal);
            }
            const validated = validateBridgeResponse(result, request.method);
            emitToolResolved('succeeded', telemetrySerializedByteLength(validated));
            return validated;
        } catch (error) {
            const normalized = error instanceof McpAppHostError ? error : safeRequestInternalError();
            emitToolResolved(localTerminationCode ?? normalized.code);
            throw normalized;
        } finally {
            clearTimeout(timer);
            frameSignal?.removeEventListener('abort', abortFromFrame);
            requestControllers.delete(operation);
        }
    };

    const deliverPending = (): void => {
        if (!frame || terminalSent || !pendingDelivery) return;
        if (pendingDelivery.type === 'result') {
            frame.sendToolResult(pendingDelivery.result);
        } else {
            frame.sendToolCancelled(pendingDelivery.reason);
        }
        terminalSent = true;
    };

    const handleFrameFailure = (ownedGeneration: number, caught: unknown): void => {
        if (disposed || generation !== ownedGeneration) return;
        generation += 1;
        const error = normalizeError(caught);
        emitTelemetry('mcp_app_render_failed', {
            stage: 'sandbox',
            durationMs: 0,
            byteLength: 0,
            code: error.code,
        });
        void teardownFrame().then(() => {
            if (!disposed && generation === ownedGeneration + 1) {
                setState({ type: 'failed', error });
            }
        });
    };

    const runLoad = async (): Promise<void> => {
        if (disposed || resultIsUnavailable()) return;
        const ownedGeneration = ++generation;
        const operation = new AbortController();
        activeController = operation;
        let mountPromise: Promise<McpAppFrame> | undefined;
        let mountAccepted = false;
        let renderStage: McpAppTelemetryInput['stage'] = 'resource';
        let resourceByteLength = 0;
        const telemetryStartedAt = Date.now();
        const deadline = createStageDeadline(operation);
        try {
            emitTelemetry('mcp_app_render_started', {
                stage: 'resource',
                durationMs: 0,
                byteLength: 0,
                code: 'started',
            });
            setState({ type: 'loading-resource' });
            const resource = await raceAbort(options.remotePort.readResource({
                callId: options.callId,
                expectedResourceUri: options.presentation.resourceUri,
                signal: operation.signal,
            }), operation.signal);
            if (disposed || ownedGeneration !== generation) return;
            resourceByteLength = resource.byteLength;

            renderStage = 'sandbox';
            setState({ type: 'loading-sandbox' });
            deadline.arm(MCP_APP_SANDBOX_READY_TIMEOUT_MS);
            mountPromise = options.frameAdapter.mount({
                resource,
                context: hostContext,
                signal: operation.signal,
                onSandboxReady: () => {
                    if (disposed || ownedGeneration !== generation || operation.signal.aborted
                        || state.type !== 'loading-sandbox') return;
                    renderStage = 'initialize';
                    setState({ type: 'initializing' });
                    deadline.arm(MCP_APP_INITIALIZE_TIMEOUT_MS);
                },
                onFailure: (error) => handleFrameFailure(ownedGeneration, error),
                onRequest: handleBridgeRequest,
            });
            const mounted = await raceAbort(mountPromise, operation.signal);
            mountAccepted = true;
            deadline.clear();
            if (disposed || ownedGeneration !== generation || resultIsUnavailable()) {
                await mounted.teardown();
                return;
            }
            if (state.type !== 'initializing') {
                await mounted.teardown();
                throw new McpAppHostError(
                    'MCP_APP_BRIDGE_PROTOCOL',
                    false,
                    'The App bridge protocol failed.',
                );
            }

            frame = mounted;
            inputSent = false;
            terminalSent = false;
            frame.sendToolInput(options.input);
            inputSent = true;
            deliverPending();
            setState({ type: 'active' });
            emitTelemetry('mcp_app_render_succeeded', {
                stage: 'initialize',
                durationMs: Math.max(0, Date.now() - telemetryStartedAt),
                byteLength: resourceByteLength,
                code: 'succeeded',
            });
        } catch (caught) {
            deadline.clear();
            if (mountPromise && !mountAccepted) {
                void mountPromise.then((lateFrame) => lateFrame.teardown()).catch(() => {});
            }
            if (disposed || ownedGeneration !== generation) return;
            const error = normalizeError(caught);
            emitTelemetry('mcp_app_render_failed', {
                stage: renderStage,
                durationMs: Math.max(0, Date.now() - telemetryStartedAt),
                byteLength: resourceByteLength,
                code: error.code,
            });
            if (error.code === 'MCP_APP_ORIGIN_MISMATCH' && error.retryable && !originRetryUsed) {
                operation.abort(error);
                if (activeController === operation) activeController = undefined;
                setState({ type: 'waiting-for-origin' });
                return;
            }
            await teardownFrame();
            setState({ type: 'failed', error });
        } finally {
            deadline.clear();
            if (!frame && activeController === operation) {
                operation.abort(cancellationError());
                activeController = undefined;
            }
        }
    };

    const load = async (): Promise<void> => {
        if (disposed || loadPromise) return loadPromise;
        const pending = runLoad();
        loadPromise = pending;
        try {
            await pending;
        } finally {
            if (loadPromise === pending) loadPromise = undefined;
        }
    };

    return {
        getState(): McpAppHostState {
            return state;
        },

        async start(): Promise<void> {
            if (disposed || started) return;
            started = true;
            if (resultIsUnavailable()) return;
            await load();
        },

        async updateToolCall(update: McpAppToolCallUpdate): Promise<void> {
            if (disposed) return;
            if (update.result) currentResult = update.result;
            if (resultIsUnavailable()) {
                generation += 1;
                await teardownFrame();
                if (!disposed) setState({ type: 'fallback' });
                return;
            }

            if (!terminalDeliveryAccepted && update.state === 'cancelled') {
                terminalDeliveryAccepted = true;
                pendingDelivery = {
                    type: 'cancelled',
                    reason: update.cancellationReason ?? 'The tool call was cancelled.',
                };
            } else if (!terminalDeliveryAccepted && update.result?.state === 'available') {
                terminalDeliveryAccepted = true;
                pendingDelivery = {
                    type: 'result',
                    result: availableResult(update.result, update.state === 'error')!,
                };
            }

            if (frame && inputSent) {
                try {
                    deliverPending();
                } catch (caught) {
                    await teardownFrame();
                    if (!disposed) setState({ type: 'failed', error: normalizeError(caught) });
                }
            }

            const terminal = update.state === 'completed' || update.state === 'error'
                || update.state === 'cancelled';
            if (terminal && state.type === 'waiting-for-origin' && !originRetryUsed) {
                originRetryUsed = true;
                await load();
            }
        },

        updateHostContext(next: McpAppHostContext): void {
            if (disposed) return;
            hostContext = next;
            frame?.updateHostContext(next);
        },

        async retry(): Promise<void> {
            if (disposed || userRetryUsed || state.type !== 'failed' || !state.error.retryable) return;
            userRetryUsed = true;
            await load();
        },

        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            generation += 1;
            await teardownFrame();
            setState({ type: 'fallback' });
        },
    };
}
