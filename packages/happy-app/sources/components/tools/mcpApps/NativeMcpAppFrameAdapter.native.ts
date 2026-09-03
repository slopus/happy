import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { WebView } from 'react-native-webview';
import {
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    MCP_APP_MAX_FRAME_HEIGHT,
    MCP_APP_MIN_FRAME_HEIGHT,
    createMcpAppMountCommands,
    hostCommandSchema,
    nativeMessages,
} from '../../../../mcp-app-sandbox/protocol';
import { MCP_APP_HOST_SHELL_HTML } from './generated/hostShellBundle';
import { McpAppHostError, type FrameMountInput, type McpAppFrame, type McpAppFrameAdapter } from './types';
import {
    normalizeMcpAppResourceUi,
    type McpAppResourceCsp,
} from './resourceUiMetadata';

export { MCP_APP_MAX_BRIDGE_MESSAGE_BYTES, MCP_APP_MAX_FRAME_HEIGHT, MCP_APP_MIN_FRAME_HEIGHT };

export const MCP_APP_HOST_BASE_URL = 'https://mcp-app-host.invalid/';
export const MCP_APP_RESIZE_THROTTLE_MS = 16;
const MCP_APP_TEARDOWN_TIMEOUT_MS = 1_000;

type WebViewHandle = { postMessage(message: string): void };
type Snapshot = {
    visible: boolean;
    height: number;
    instanceId?: string;
    hostHtml?: string;
    prefersBorder?: boolean;
};
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

const MCP_APP_MAX_RETIRED_REQUEST_IDS = 64;

function rememberRetiredRequest(active: ActiveFrame, requestId: string): void {
    while (active.retiredRequestIds.size >= MCP_APP_MAX_RETIRED_REQUEST_IDS) {
        const oldest = active.retiredRequestIds.values().next().value as string | undefined;
        if (!oldest) break;
        active.retiredRequestIds.delete(oldest);
    }
    active.retiredRequestIds.add(requestId);
}

function byteLength(value: string): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
            bytes += 4;
            index += 1;
        } else bytes += 3;
    }
    return bytes;
}

function protocolError(): McpAppHostError {
    return new McpAppHostError('MCP_APP_BRIDGE_PROTOCOL', false, 'The App bridge protocol failed.');
}

function sandboxUnavailable(): McpAppHostError {
    return new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', false, 'The App sandbox is unavailable.');
}

function originSources(values: readonly string[]): string {
    return values.length > 0 ? ` ${values.join(' ')}` : '';
}

function buildNativeMcpAppHostShellHtml(csp: McpAppResourceCsp | undefined): string {
    const resourceSources = originSources(csp?.resourceDomains ?? []);
    const frameSources = originSources(csp?.frameDomains ?? []);
    const connectSources = csp?.connectDomains ?? [];
    const policy = [
        "default-src 'none'",
        `script-src 'unsafe-inline'${resourceSources}`,
        `style-src 'unsafe-inline'${resourceSources}`,
        `frame-src data: blob: 'self'${frameSources}`,
        `img-src data: blob:${resourceSources}`,
        `font-src data:${resourceSources}`,
        resourceSources ? `media-src blob:${resourceSources}` : "media-src 'none'",
        connectSources.length > 0 ? `connect-src ${connectSources.join(' ')}` : "connect-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
    const marker = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/u;
    if (!marker.test(MCP_APP_HOST_SHELL_HTML)) throw sandboxUnavailable();
    return MCP_APP_HOST_SHELL_HTML.replace(marker, (_match, before: string, after: string) => (
        `${before}${policy}${after}`
    ));
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
        : new McpAppHostError(
            'MCP_APP_INTERNAL', false, 'The App request could not be completed.',
        );
    return {
        ok: false as const,
        error: {
            code: normalized.code,
            retryable: normalized.retryable,
            summary: SAFE_ERROR_SUMMARIES[normalized.code],
        },
    };
}

let nextInstanceId = 0;

export class NativeMcpAppFrameAdapter implements McpAppFrameAdapter {
    private snapshot: Snapshot = { visible: false, height: MCP_APP_MIN_FRAME_HEIGHT };
    private readonly listeners = new Set<() => void>();
    private readonly createInstanceId: () => string;
    private handle?: WebViewHandle;
    private pending?: PendingMount;
    private active?: ActiveFrame;
    private navigationAvailable = false;
    private resizeTimer?: ReturnType<typeof setTimeout>;
    private pendingHeight?: number;
    private teardownResolve?: () => void;
    private teardownTimer?: ReturnType<typeof setTimeout>;

    constructor(options: { createInstanceId?: () => string } = {}) {
        this.createInstanceId = options.createInstanceId ?? (() => `mcp-app-frame-${++nextInstanceId}`);
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): Snapshot => this.snapshot;

    private publish(next: Snapshot): void {
        this.snapshot = next;
        for (const listener of this.listeners) listener();
    }

    attachWebView = (handle: WebViewHandle | null): void => {
        this.handle = handle ?? undefined;
    };

    async mount(input: FrameMountInput): Promise<McpAppFrame> {
        if (this.pending || this.snapshot.visible) {
            throw new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', true, 'The App sandbox is busy.');
        }
        const ui = normalizeMcpAppResourceUi(
            input.resource.ui,
            typeof __DEV__ !== 'undefined' && __DEV__,
        );
        if (ui === null) throw sandboxUnavailable();
        const hostHtml = buildNativeMcpAppHostShellHtml(ui?.csp);
        const instanceId = this.createInstanceId();
        this.navigationAvailable = true;
        this.publish({
            visible: true,
            height: MCP_APP_MIN_FRAME_HEIGHT,
            instanceId,
            hostHtml,
            prefersBorder: ui?.prefersBorder === true,
        });
        return new Promise<McpAppFrame>((resolve, reject) => {
            const abortListener = () => this.fail(input.signal.reason instanceof McpAppHostError
                ? input.signal.reason
                : new McpAppHostError('MCP_APP_SESSION_OFFLINE', true, 'The session is no longer available.'));
            this.pending = { input, resolve, reject, sandboxReady: false, initialized: false, mountSent: false, abortListener };
            input.signal.addEventListener('abort', abortListener, { once: true });
            if (input.signal.aborted) abortListener();
        });
    }

    onLoadEnd = (): void => {
        const pending = this.pending;
        if (!pending || pending.mountSent || !this.snapshot.instanceId) return;
        pending.mountSent = true;
        for (const command of createMcpAppMountCommands(
            this.snapshot.instanceId,
            pending.input.resource.html,
            pending.input.context,
        )) this.send(command);
    };

    onShouldStartLoadWithRequest = (request: { url?: string; isTopFrame?: boolean }): boolean => {
        if (request.isTopFrame === false) return false;
        if (this.navigationAvailable && request.url === MCP_APP_HOST_BASE_URL) {
            this.navigationAvailable = false;
            return true;
        }
        return false;
    };

    onMessage = (event: { nativeEvent?: { data?: unknown } }): void => {
        const raw = event.nativeEvent?.data;
        if (typeof raw !== 'string' || byteLength(raw) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
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
            this.active = {
                input: pending.input,
                acceptingRequests: true,
                requests: new Map(),
                retiredRequestIds: new Set(),
            };
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
    };

    private handleBridgeRequest(
        instanceId: string,
        requestId: string,
        request: Parameters<FrameMountInput['onRequest']>[0],
    ): void {
        const active = this.active;
        if (!active || !active.acceptingRequests || active.requests.has(requestId)
            || active.retiredRequestIds.has(requestId)) {
            this.fail(protocolError());
            return;
        }
        const operation = new AbortController();
        active.requests.set(requestId, operation);
        void active.input.onRequest(request, operation.signal).then(
            (value) => this.finishBridgeRequest(active, instanceId, requestId, {
                ok: true,
                value,
            }),
            (error) => this.finishBridgeRequest(
                active,
                instanceId,
                requestId,
                safeBridgeFailure(error),
            ),
        );
    }

    private finishBridgeRequest(
        owned: ActiveFrame,
        instanceId: string,
        requestId: string,
        response: { ok: true; value: unknown } | ReturnType<typeof safeBridgeFailure>,
    ): void {
        if (this.active !== owned || !owned.acceptingRequests
            || !owned.requests.delete(requestId)
            || this.snapshot.instanceId !== instanceId) return;
        rememberRetiredRequest(owned, requestId);
        try {
            this.send({ type: 'bridge-response', instanceId, requestId, response });
        } catch {
            // send() already revokes the frame and reports its protocol failure.
        }
    }

    private handleBridgeCancel(requestId: string): void {
        const active = this.active;
        if (!active) {
            this.fail(protocolError());
            return;
        }
        const operation = active.requests.get(requestId);
        if (operation) {
            active.requests.delete(requestId);
            rememberRetiredRequest(active, requestId);
            operation.abort();
            return;
        }
        if (active.retiredRequestIds.has(requestId)) return;
        this.fail(protocolError());
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
        if (!parsed.success || !this.handle) {
            this.fail(protocolError());
            throw protocolError();
        }
        const raw = JSON.stringify(parsed.data);
        if (byteLength(raw) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
            this.fail(protocolError());
            throw protocolError();
        }
        this.handle.postMessage(raw);
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
        if (!this.snapshot.visible || this.snapshot.instanceId !== instanceId) return Promise.resolve();
        if (this.teardownResolve) return Promise.resolve();
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

    private fail(error: McpAppHostError): void {
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

    onWebViewFailure = (): void => {
        this.fail(new McpAppHostError(
            'MCP_APP_SANDBOX_UNAVAILABLE', true, 'The App sandbox stopped unexpectedly.',
        ));
    };

    private clearOwnedState(): void {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        if (this.teardownTimer) clearTimeout(this.teardownTimer);
        this.resizeTimer = undefined;
        this.teardownTimer = undefined;
        this.pendingHeight = undefined;
        this.navigationAvailable = false;
        this.handle = undefined;
        this.publish({ visible: false, height: MCP_APP_MIN_FRAME_HEIGHT });
    }
}

export function createMcpAppFrameAdapter(): NativeMcpAppFrameAdapter {
    return new NativeMcpAppFrameAdapter();
}

export function NativeMcpAppFrameView({ adapter }: { adapter: NativeMcpAppFrameAdapter }) {
    const snapshot = React.useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
    if (!snapshot.visible) return null;
    return React.createElement(WebView as React.ComponentType<any>, {
        ref: adapter.attachWebView,
        testID: 'mcp-app-sandbox-frame',
        source: { html: snapshot.hostHtml ?? MCP_APP_HOST_SHELL_HTML, baseUrl: MCP_APP_HOST_BASE_URL },
        // Let the wrapper delegate every request to our callback; a narrower
        // whitelist can invoke Linking.openURL before this policy runs.
        originWhitelist: ['*'],
        javaScriptEnabled: true,
        javaScriptCanOpenWindowsAutomatically: false,
        setSupportMultipleWindows: false,
        allowFileAccess: false,
        allowFileAccessFromFileURLs: false,
        allowUniversalAccessFromFileURLs: false,
        mediaPlaybackRequiresUserAction: true,
        mediaCapturePermissionGrantType: 'deny',
        geolocationEnabled: false,
        allowsLinkPreview: false,
        sharedCookiesEnabled: false,
        thirdPartyCookiesEnabled: false,
        domStorageEnabled: false,
        cacheEnabled: false,
        incognito: true,
        onShouldStartLoadWithRequest: adapter.onShouldStartLoadWithRequest,
        onMessage: adapter.onMessage,
        onLoadEnd: adapter.onLoadEnd,
        onError: adapter.onWebViewFailure,
        onHttpError: adapter.onWebViewFailure,
        onContentProcessDidTerminate: adapter.onWebViewFailure,
        onRenderProcessGone: adapter.onWebViewFailure,
        style: {
            ...styles.frame,
            ...(snapshot.prefersBorder ? styles.borderedFrame : {}),
            height: snapshot.height,
        },
    });
}

export const McpAppFrameView = NativeMcpAppFrameView;

const styles = StyleSheet.create((theme) => ({
    frame: {
        width: '100%',
        backgroundColor: theme.colors.surface,
    },
    borderedFrame: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
}));
