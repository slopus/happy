import {
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    MCP_APP_MAX_FRAME_HEIGHT,
    MCP_APP_MIN_FRAME_HEIGHT,
    createMcpAppMountCommands,
    hostCommandSchema,
    nativeMessages,
    utf8ByteLength,
} from '../../../../mcp-app-sandbox/protocol';
import { McpAppHostError, type FrameMountInput, type McpAppFrame, type McpAppFrameAdapter } from './types';

const MCP_APP_TEARDOWN_TIMEOUT_MS = 1_000;
const MCP_APP_RESIZE_THROTTLE_MS = 16;
const MCP_APP_MAX_RETIRED_REQUEST_IDS = 64;

export type McpAppFrameBridgeSnapshot = { visible: boolean; height: number; instanceId?: string };

type PendingMount = {
    input: FrameMountInput;
    resolve(frame: McpAppFrame): void;
    reject(error: McpAppHostError): void;
    sandboxReady: boolean;
    initialized: boolean;
    mountSent: boolean;
    abortListener: () => void;
};

type ActiveFrame = {
    input: FrameMountInput;
    acceptingRequests: boolean;
    requests: Map<string, AbortController>;
    retiredRequestIds: Set<string>;
};

function protocolError(): McpAppHostError {
    return new McpAppHostError('MCP_APP_BRIDGE_PROTOCOL', false, 'The App bridge protocol failed.');
}

const SAFE_ERROR_SUMMARIES: Record<McpAppHostError['code'], string> = {
    MCP_APP_UNSUPPORTED: 'This App is not supported.',
    MCP_APP_SESSION_OFFLINE: 'The session is no longer available.',
    MCP_APP_BINDING_NOT_FOUND: 'This App resource is no longer available.',
    MCP_APP_ORIGIN_MISMATCH: 'Waiting for the trusted App origin.',
    MCP_APP_RESOURCE_NOT_FOUND: 'The App resource was not found.',
    MCP_APP_INVALID_RESOURCE: 'The App resource is invalid.',
    MCP_APP_RESOURCE_TOO_LARGE: 'The App resource is too large.',
    MCP_APP_RESULT_TOO_LARGE: 'The App result is too large.',
    MCP_APP_TOOL_NOT_ALLOWED: 'This App action is not allowed.',
    MCP_APP_PERMISSION_DENIED: 'Permission was denied.',
    MCP_APP_SANDBOX_UNAVAILABLE: 'The App sandbox is unavailable.',
    MCP_APP_BRIDGE_PROTOCOL: 'The App bridge protocol failed.',
    MCP_APP_TIMEOUT: 'The App request timed out.',
    MCP_APP_INTERNAL: 'The App request could not be completed.',
};

function safeBridgeFailure(error: unknown) {
    const normalized = error instanceof McpAppHostError
        ? error
        : new McpAppHostError('MCP_APP_INTERNAL', false, 'The App request could not be completed.');
    return {
        ok: false as const,
        error: {
            code: normalized.code,
            retryable: normalized.retryable,
            summary: SAFE_ERROR_SUMMARIES[normalized.code],
        },
    };
}

function rememberRetiredRequest(active: ActiveFrame, requestId: string): void {
    while (active.retiredRequestIds.size >= MCP_APP_MAX_RETIRED_REQUEST_IDS) {
        const oldest = active.retiredRequestIds.values().next().value as string | undefined;
        if (!oldest) break;
        active.retiredRequestIds.delete(oldest);
    }
    active.retiredRequestIds.add(requestId);
}

let nextInstanceId = 0;

export class McpAppFrameBridge implements McpAppFrameAdapter {
    readonly support = 'supported' as const;
    readonly originScoped: boolean;
    private snapshot: McpAppFrameBridgeSnapshot = { visible: false, height: MCP_APP_MIN_FRAME_HEIGHT };
    private readonly listeners = new Set<() => void>();
    private readonly createInstanceId: () => string;
    private readonly onCleared?: () => void;
    private sendRaw?: (raw: string) => void;
    private pending?: PendingMount;
    private active?: ActiveFrame;
    private resizeTimer?: ReturnType<typeof setTimeout>;
    private pendingHeight?: number;
    private teardownResolve?: () => void;
    private teardownTimer?: ReturnType<typeof setTimeout>;

    constructor(options: {
        createInstanceId?: () => string;
        originScoped?: boolean;
        onCleared?: () => void;
    } = {}) {
        this.createInstanceId = options.createInstanceId ?? (() => `mcp-app-frame-${++nextInstanceId}`);
        this.originScoped = options.originScoped === true;
        this.onCleared = options.onCleared;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): McpAppFrameBridgeSnapshot => this.snapshot;

    private publish(next: McpAppFrameBridgeSnapshot): void {
        this.snapshot = next;
        for (const listener of this.listeners) listener();
    }

    attachTransport(sendRaw: ((raw: string) => void) | undefined): void {
        this.sendRaw = sendRaw;
    }

    async mount(input: FrameMountInput): Promise<McpAppFrame> {
        if (this.pending || this.snapshot.visible) {
            throw new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', true, 'The App sandbox is busy.');
        }
        const instanceId = this.createInstanceId();
        this.publish({ visible: true, height: MCP_APP_MIN_FRAME_HEIGHT, instanceId });
        return new Promise<McpAppFrame>((resolve, reject) => {
            const abortListener = () => this.fail(input.signal.reason instanceof McpAppHostError
                ? input.signal.reason
                : new McpAppHostError('MCP_APP_SESSION_OFFLINE', true, 'The session is no longer available.'));
            this.pending = { input, resolve, reject, sandboxReady: false, initialized: false, mountSent: false, abortListener };
            input.signal.addEventListener('abort', abortListener, { once: true });
            if (input.signal.aborted) abortListener();
        });
    }

    transportReady(): void {
        const pending = this.pending;
        if (!pending || pending.mountSent || !this.snapshot.instanceId || !this.sendRaw) {
            this.fail(protocolError());
            return;
        }
        pending.mountSent = true;
        for (const command of createMcpAppMountCommands(
            this.snapshot.instanceId,
            pending.input.resource.html,
            pending.input.context,
        )) this.send(command);
    }

    receive(raw: unknown): void {
        if (typeof raw !== 'string' || utf8ByteLength(raw) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
            this.fail(protocolError());
            return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { this.fail(protocolError()); return; }
        const result = nativeMessages.safeParse(parsed);
        if (!result.success || !this.snapshot.instanceId || result.data.instanceId !== this.snapshot.instanceId) {
            this.fail(protocolError());
            return;
        }
        const message = result.data;
        if (message.type === 'protocol-error') {
            this.fail(protocolError());
        } else if (message.type === 'sandbox-ready') {
            const pending = this.pending;
            if (!pending || pending.sandboxReady) { this.fail(protocolError()); return; }
            pending.sandboxReady = true;
            pending.input.onSandboxReady();
        } else if (message.type === 'initialized') {
            const pending = this.pending;
            if (!pending || !pending.sandboxReady || pending.initialized) { this.fail(protocolError()); return; }
            pending.initialized = true;
            pending.input.signal.removeEventListener('abort', pending.abortListener);
            this.pending = undefined;
            this.active = { input: pending.input, acceptingRequests: true, requests: new Map(), retiredRequestIds: new Set() };
            pending.resolve(this.createFrame(message.instanceId));
        } else if (message.type === 'bridge-request') {
            this.handleBridgeRequest(message.instanceId, message.requestId, message.request);
        } else if (message.type === 'bridge-cancel') {
            this.handleBridgeCancel(message.requestId);
        } else if (message.type === 'resize') {
            this.queueResize(message.height);
        } else if (message.type === 'teardown-complete') {
            if (!this.teardownResolve) { this.fail(protocolError()); return; }
            this.finishTeardown();
        }
    }

    private handleBridgeRequest(instanceId: string, requestId: string, request: Parameters<FrameMountInput['onRequest']>[0]): void {
        const active = this.active;
        if (!active || !active.acceptingRequests || active.requests.has(requestId) || active.retiredRequestIds.has(requestId)) {
            this.fail(protocolError());
            return;
        }
        const operation = new AbortController();
        active.requests.set(requestId, operation);
        void active.input.onRequest(request, operation.signal).then(
            (value) => this.finishBridgeRequest(active, instanceId, requestId, { ok: true, value }),
            (error) => this.finishBridgeRequest(active, instanceId, requestId, safeBridgeFailure(error)),
        );
    }

    private finishBridgeRequest(
        owned: ActiveFrame,
        instanceId: string,
        requestId: string,
        response: { ok: true; value: unknown } | ReturnType<typeof safeBridgeFailure>,
    ): void {
        if (this.active !== owned || !owned.acceptingRequests || !owned.requests.delete(requestId)
            || this.snapshot.instanceId !== instanceId) return;
        rememberRetiredRequest(owned, requestId);
        try { this.send({ type: 'bridge-response', instanceId, requestId, response }); } catch {}
    }

    private handleBridgeCancel(requestId: string): void {
        const active = this.active;
        if (!active) { this.fail(protocolError()); return; }
        const operation = active.requests.get(requestId);
        if (operation) {
            active.requests.delete(requestId);
            rememberRetiredRequest(active, requestId);
            operation.abort();
            return;
        }
        if (!active.retiredRequestIds.has(requestId)) this.fail(protocolError());
    }

    private revokeActiveRequests(): void {
        const active = this.active;
        if (!active) return;
        active.acceptingRequests = false;
        for (const [requestId, operation] of active.requests) {
            rememberRetiredRequest(active, requestId);
            operation.abort();
        }
        active.requests.clear();
    }

    private createFrame(instanceId: string): McpAppFrame {
        return {
            sendToolInput: (input) => this.send({ type: 'tool-input', instanceId, input }),
            sendToolResult: (result) => this.send({ type: 'tool-result', instanceId, result }),
            sendToolCancelled: (reason) => this.send({ type: 'tool-cancelled', instanceId, reason: reason.slice(0, 280) }),
            updateHostContext: (context) => this.send({ type: 'host-context', instanceId, context }),
            teardown: () => this.teardown(instanceId),
        };
    }

    private send(command: unknown): void {
        const parsed = hostCommandSchema.safeParse(command);
        if (!parsed.success || !this.sendRaw) {
            this.fail(protocolError());
            throw protocolError();
        }
        const raw = JSON.stringify(parsed.data);
        if (utf8ByteLength(raw) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
            this.fail(protocolError());
            throw protocolError();
        }
        try { this.sendRaw(raw); } catch {
            const error = new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', true, 'The App sandbox stopped unexpectedly.');
            this.fail(error);
            throw error;
        }
    }

    private queueResize(height: number): void {
        this.pendingHeight = Number.isFinite(height)
            ? Math.max(MCP_APP_MIN_FRAME_HEIGHT, Math.min(MCP_APP_MAX_FRAME_HEIGHT, height))
            : MCP_APP_MAX_FRAME_HEIGHT;
        if (this.resizeTimer) return;
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = undefined;
            if (this.snapshot.visible && this.pendingHeight !== undefined) {
                this.publish({ ...this.snapshot, height: this.pendingHeight });
            }
            this.pendingHeight = undefined;
        }, MCP_APP_RESIZE_THROTTLE_MS);
    }

    private teardown(instanceId: string): Promise<void> {
        if (!this.snapshot.visible || this.snapshot.instanceId !== instanceId || this.teardownResolve) return Promise.resolve();
        this.revokeActiveRequests();
        return new Promise<void>((resolve) => {
            this.teardownResolve = resolve;
            try { this.send({ type: 'teardown', instanceId }); } catch { this.finishTeardown(); return; }
            this.teardownTimer = setTimeout(() => this.finishTeardown(), MCP_APP_TEARDOWN_TIMEOUT_MS);
        });
    }

    private finishTeardown(): void {
        if (this.teardownTimer) clearTimeout(this.teardownTimer);
        this.teardownTimer = undefined;
        const resolve = this.teardownResolve;
        this.teardownResolve = undefined;
        this.active = undefined;
        this.clearOwnedState();
        resolve?.();
    }

    fail(error: McpAppHostError): void {
        if (!this.pending && !this.active && !this.snapshot.visible) return;
        const pending = this.pending;
        const active = this.active;
        this.revokeActiveRequests();
        this.pending = undefined;
        this.active = undefined;
        if (pending) {
            pending.input.signal.removeEventListener('abort', pending.abortListener);
            pending.reject(error);
        }
        this.clearOwnedState();
        this.teardownResolve?.();
        this.teardownResolve = undefined;
        if (!pending && active) active.input.onFailure(error);
    }

    transportFailure(): void {
        this.fail(new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', true, 'The App sandbox stopped unexpectedly.'));
    }

    private clearOwnedState(): void {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        if (this.teardownTimer) clearTimeout(this.teardownTimer);
        this.resizeTimer = undefined;
        this.teardownTimer = undefined;
        this.pendingHeight = undefined;
        this.sendRaw = undefined;
        this.publish({ visible: false, height: MCP_APP_MIN_FRAME_HEIGHT });
        this.onCleared?.();
    }
}
