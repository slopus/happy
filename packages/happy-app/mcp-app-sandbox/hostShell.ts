import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
    ErrorCode,
    JSONRPCMessageSchema,
    McpError,
    PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
    MCP_APP_MAX_FRAME_HEIGHT,
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    MCP_APP_MAX_MOUNT_CHUNK_DECODED_BYTES,
    MCP_APP_MAX_MOUNT_HTML_BYTES,
    MCP_APP_MIN_FRAME_HEIGHT,
    hostContextSchema,
    mcpAppBridgeRequestSchema,
    nativeMessages,
    parseHostCommand,
    utf8ByteLength,
    type HostCommand,
    type McpAppBridgeRequest,
    type NativeMessage,
} from './protocol';

export * from './protocol';

export function createSandboxedIframe(ownerDocument: Document, html: string): HTMLIFrameElement {
    const iframe = ownerDocument.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent';
    iframe.srcdoc = html;
    return iframe;
}

export function createResizeEmitter(
    send: (height: number) => void,
    requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): (height: number) => void {
    let queued = false;
    let latest = MCP_APP_MIN_FRAME_HEIGHT;
    return (height: number) => {
        latest = Number.isFinite(height)
            ? Math.max(MCP_APP_MIN_FRAME_HEIGHT, Math.min(MCP_APP_MAX_FRAME_HEIGHT, height))
            : MCP_APP_MAX_FRAME_HEIGHT;
        if (queued) return;
        queued = true;
        requestFrame(() => {
            queued = false;
            send(latest);
        });
    };
}

type ShellWindow = Window & {
    ReactNativeWebView?: { postMessage(message: string): void };
};

function officialHostContext(context: z.infer<typeof hostContextSchema>) {
    return {
        theme: context.theme,
        locale: context.locale,
        platform: context.platform === 'desktop' ? 'desktop' as const : context.platform === 'web' ? 'web' as const : 'mobile' as const,
        deviceCapabilities: { touch: context.touch, hover: context.hover },
        containerDimensions: { width: context.container.width, height: context.container.height },
        safeAreaInsets: context.safeAreaInsets,
        displayMode: context.displayMode,
    };
}

type AppBridgeRequestExtra = Parameters<Parameters<AppBridge['setRequestHandler']>[1]>[1];

const MCP_APP_MAX_VIEW_REQUESTS_PER_MINUTE = 30;

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasStrictJsonRpcEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const envelope = value as Record<string, unknown>;
    if (!JSONRPCMessageSchema.safeParse(value).success) return false;
    if (hasOwn(envelope, 'method')) {
        return hasOnlyKeys(envelope, hasOwn(envelope, 'id')
            ? ['jsonrpc', 'id', 'method', 'params']
            : ['jsonrpc', 'method', 'params']);
    }
    if (hasOwn(envelope, 'result')) {
        return hasOnlyKeys(envelope, ['jsonrpc', 'id', 'result']);
    }
    if (!hasOnlyKeys(envelope, ['jsonrpc', 'id', 'error'])) return false;
    const error = envelope.error;
    return Boolean(error && typeof error === 'object' && !Array.isArray(error)
        && hasOnlyKeys(error, ['code', 'message', 'data']));
}

function isViewRequestAttempt(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && hasOwn(value, 'method') && hasOwn(value, 'id'));
}

function officialRequestIdKey(requestId: unknown): string | undefined {
    return typeof requestId === 'string' || typeof requestId === 'number'
        ? `${typeof requestId}:${String(requestId)}`
        : undefined;
}

const OFFICIAL_ZERO_REQUEST_ID = '\u0000paws:request-id:number:0';
const OFFICIAL_EMPTY_REQUEST_ID = '\u0000paws:request-id:string:empty';

function internalOfficialRequestId(requestId: unknown): unknown {
    if (requestId === 0) return OFFICIAL_ZERO_REQUEST_ID;
    if (requestId === '') return OFFICIAL_EMPTY_REQUEST_ID;
    return requestId;
}

function externalOfficialRequestId(requestId: unknown): unknown {
    if (requestId === OFFICIAL_ZERO_REQUEST_ID) return 0;
    if (requestId === OFFICIAL_EMPTY_REQUEST_ID) return '';
    return requestId;
}

function isReservedOfficialRequestId(requestId: unknown): boolean {
    return requestId === OFFICIAL_ZERO_REQUEST_ID || requestId === OFFICIAL_EMPTY_REQUEST_ID;
}

function hasReservedOfficialInboundId(envelope: Record<string, unknown>): boolean {
    if (hasOwn(envelope, 'id') && isReservedOfficialRequestId(envelope.id)) return true;
    if (envelope.method !== 'notifications/cancelled'
        || !envelope.params || typeof envelope.params !== 'object'
        || Array.isArray(envelope.params)) return false;
    return isReservedOfficialRequestId((envelope.params as Record<string, unknown>).requestId);
}

type OfficialTransportMessage = Parameters<PostMessageTransport['send']>[0];
type OfficialTransportOptions = Parameters<PostMessageTransport['send']>[1];

function rewriteOfficialInbound(message: OfficialTransportMessage): OfficialTransportMessage {
    if ('method' in message && 'id' in message && (message.id === 0 || message.id === '')) {
        return { ...message, id: internalOfficialRequestId(message.id) } as OfficialTransportMessage;
    }
    if ('method' in message && message.method === 'notifications/cancelled'
        && 'params' in message && message.params && typeof message.params === 'object'
        && !Array.isArray(message.params)) {
        const params = message.params as Record<string, unknown>;
        if (params.requestId === 0 || params.requestId === '') {
            return {
                ...message,
                params: { ...params, requestId: internalOfficialRequestId(params.requestId) },
            } as OfficialTransportMessage;
        }
    }
    return message;
}

function rewriteOfficialOutbound(message: OfficialTransportMessage): OfficialTransportMessage {
    if ('id' in message && ('result' in message || 'error' in message)
        && isReservedOfficialRequestId(message.id)) {
        return { ...message, id: externalOfficialRequestId(message.id) } as OfficialTransportMessage;
    }
    return message;
}

class TrackedPostMessageTransport {
    private readonly transport: PostMessageTransport;
    onclose?: PostMessageTransport['onclose'];
    onerror?: PostMessageTransport['onerror'];
    onmessage?: PostMessageTransport['onmessage'];
    sessionId?: string;

    constructor(
        target: Window,
        source: Window,
        private readonly onTerminalResponse: (requestId: string | number) => void,
    ) {
        this.transport = new PostMessageTransport(target, source);
    }

    async start(): Promise<void> {
        this.transport.onclose = () => this.onclose?.();
        this.transport.onerror = (error) => this.onerror?.(error);
        this.transport.onmessage = (message, extra) => {
            this.onmessage?.(rewriteOfficialInbound(message), extra);
        };
        await this.transport.start();
    }

    async send(
        message: OfficialTransportMessage,
        options?: OfficialTransportOptions,
    ): Promise<void> {
        const outgoing = rewriteOfficialOutbound(message);
        if ('id' in outgoing && (typeof outgoing.id === 'string' || typeof outgoing.id === 'number')
            && ('result' in outgoing || 'error' in outgoing)) {
            this.onTerminalResponse(outgoing.id);
        }
        await this.transport.send(outgoing, options);
    }

    async close(): Promise<void> {
        await this.transport.close();
    }

    setProtocolVersion(version: string): void {
        this.transport.setProtocolVersion?.(version);
    }
}

class PawsAppBridge extends AppBridge {
    replacePingHandler(
        handler: (
            request: z.infer<typeof PingRequestSchema>,
            extra: AppBridgeRequestExtra,
        ) => Promise<Record<string, never>>,
    ): void {
        this.replaceRequestHandler(PingRequestSchema, handler);
    }
}

type MountAssembly = {
    byteLength: number;
    receivedBytes: number;
    chunks: Uint8Array[];
    context: z.infer<typeof hostContextSchema>;
};

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function decodeMountChunk(dataBase64: string): Uint8Array | undefined {
    if (!STRICT_BASE64.test(dataBase64)) return undefined;
    try {
        const binary = atob(dataBase64);
        if (binary.length === 0 || binary.length > MCP_APP_MAX_MOUNT_CHUNK_DECODED_BYTES) return undefined;
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    } catch {
        return undefined;
    }
}

/** Starts the browser-only shell. The inner opaque-origin View never receives the native bridge object. */
export function startHostShell(shellWindow: ShellWindow = window as ShellWindow): () => void {
    const native = shellWindow.ReactNativeWebView;
    if (!native) return () => {};

    // The official transport logs complete JSON-RPC envelopes by default. This
    // shell carries HTML, tool arguments/results, resource URIs, and App names,
    // so its isolated console must stay silent rather than becoming a data sink.
    const shellConsole = (shellWindow as Window & { console: Console }).console;
    const originalConsole = {
        debug: shellConsole.debug,
        info: shellConsole.info,
        log: shellConsole.log,
        warn: shellConsole.warn,
        error: shellConsole.error,
    };
    const silent = () => {};
    shellConsole.debug = silent;
    shellConsole.info = silent;
    shellConsole.log = silent;
    shellConsole.warn = silent;
    shellConsole.error = silent;

    let instanceId: string | undefined;
    let mountAssembly: MountAssembly | undefined;
    let iframe: HTMLIFrameElement | undefined;
    let bridge: PawsAppBridge | undefined;
    let disposed = false;
    let closing = false;
    let releasePromise: Promise<void> | undefined;
    let nextRequestId = 0;
    const pendingBridgeRequests = new Map<string, {
        resolve(value: unknown): void;
        reject(error: Error): void;
        removeAbortListener(): void;
    }>();
    const abandonedBridgeRequestIds = new Set<string>();
    const viewRequestTimestamps: number[] = [];
    const activeOfficialRequestIds = new Set<string>();
    const retiredOfficialRequestIds = new Set<string>();
    let viewSource: Window | undefined;

    const rememberAbandonedRequest = (requestId: string): void => {
        while (abandonedBridgeRequestIds.size >= 64) {
            const oldest = abandonedBridgeRequestIds.values().next().value as string | undefined;
            if (!oldest) break;
            abandonedBridgeRequestIds.delete(oldest);
        }
        abandonedBridgeRequestIds.add(requestId);
    };

    const retireOfficialRequestId = (requestId: unknown): void => {
        const key = officialRequestIdKey(requestId);
        if (!key || !activeOfficialRequestIds.delete(key)) return;
        while (retiredOfficialRequestIds.size >= 64) {
            const oldest = retiredOfficialRequestIds.values().next().value as string | undefined;
            if (!oldest) break;
            retiredOfficialRequestIds.delete(oldest);
        }
        retiredOfficialRequestIds.add(key);
    };

    const post = (message: NativeMessage): boolean => {
        const terminal = message.type === 'teardown-complete' || message.type === 'protocol-error';
        if ((!disposed && !closing) || terminal) {
            const parsed = nativeMessages.safeParse(message);
            if (!parsed.success) return false;
            const serialized = JSON.stringify(parsed.data);
            if (utf8ByteLength(serialized) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) return false;
            native.postMessage(serialized);
            return true;
        }
        return false;
    };
    const emitResize = createResizeEmitter((height) => {
        if (instanceId) post({ type: 'resize', instanceId, height });
    }, shellWindow.requestAnimationFrame.bind(shellWindow));

    const release = (acknowledge: boolean, graceful = true): Promise<void> => {
        if (releasePromise) return releasePromise;
        closing = true;
        const ownedId = instanceId;
        const ownedBridge = bridge;
        bridge = undefined;
        mountAssembly = undefined;
        if (viewSource) {
            shellWindow.removeEventListener('message', viewIngressListener, true);
            viewSource = undefined;
        }
        viewRequestTimestamps.length = 0;
        activeOfficialRequestIds.clear();
        retiredOfficialRequestIds.clear();
        releasePromise = (async () => {
            for (const pending of pendingBridgeRequests.values()) {
                pending.removeAbortListener();
                pending.reject(new McpError(ErrorCode.ConnectionClosed, 'App bridge closed.'));
            }
            pendingBridgeRequests.clear();
            abandonedBridgeRequestIds.clear();
            if (graceful && ownedBridge) {
                try {
                    await Promise.race([
                        ownedBridge.teardownResource({}),
                        new Promise<void>((resolve) => shellWindow.setTimeout(resolve, 500)),
                    ]);
                } catch {
                    // The View may already be gone. Closing still revokes the transport.
                }
            }
            try {
                await ownedBridge?.close();
            } catch {
                // Best-effort close; iframe removal is the security boundary.
            }
            iframe?.remove();
            iframe = undefined;
            instanceId = undefined;
            if (acknowledge && ownedId) post({ type: 'teardown-complete', instanceId: ownedId });
        })();
        return releasePromise;
    };

    const protocolFailure = () => {
        const ownedId = instanceId;
        void release(false, false).finally(() => {
            if (ownedId) post({ type: 'protocol-error', instanceId: ownedId });
        });
    };

    const relay = (request: McpAppBridgeRequest, signal?: AbortSignal): Promise<unknown> => {
        if (!instanceId || disposed || closing || signal?.aborted) {
            return Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'App bridge closed.'));
        }
        const parsed = mcpAppBridgeRequestSchema.safeParse(request);
        if (!parsed.success) {
            protocolFailure();
            return Promise.reject(new McpError(ErrorCode.InvalidParams, 'Invalid App request.'));
        }
        const requestId = `request-${++nextRequestId}`;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                const pending = pendingBridgeRequests.get(requestId);
                if (!pending) return;
                pendingBridgeRequests.delete(requestId);
                pending.removeAbortListener();
                rememberAbandonedRequest(requestId);
                if (!closing && instanceId) {
                    post({ type: 'bridge-cancel', instanceId, requestId });
                }
                reject(new McpError(ErrorCode.ConnectionClosed, 'App bridge closed.'));
            };
            const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
            pendingBridgeRequests.set(requestId, { resolve, reject, removeAbortListener });
            signal?.addEventListener('abort', onAbort, { once: true });
            const sent = post({
                type: 'bridge-request',
                instanceId: instanceId!,
                requestId,
                request: parsed.data,
            });
            if (!sent) {
                pendingBridgeRequests.delete(requestId);
                removeAbortListener();
                protocolFailure();
                reject(new McpError(ErrorCode.InvalidRequest, 'Invalid App request.'));
            }
        });
    };

    const unsupported = async (): Promise<never> => {
        throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
    };

    function viewIngressListener(event: MessageEvent): void {
        if (!viewSource || event.source !== viewSource) return;
        if (closing || disposed) {
            event.stopImmediatePropagation();
            return;
        }
        let serialized: string | undefined;
        try {
            serialized = JSON.stringify(event.data);
        } catch {
            // Cyclic and otherwise non-JSON values are protocol abuse.
        }
        const now = Date.now();
        if (isViewRequestAttempt(event.data)) {
            while (viewRequestTimestamps.length > 0
                && viewRequestTimestamps[0] <= now - 60_000) {
                viewRequestTimestamps.shift();
            }
            viewRequestTimestamps.push(now);
        }
        const overRate = viewRequestTimestamps.length > MCP_APP_MAX_VIEW_REQUESTS_PER_MINUTE;
        if (!serialized || utf8ByteLength(serialized) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES
            || !hasStrictJsonRpcEnvelope(event.data) || overRate) {
            event.stopImmediatePropagation();
            protocolFailure();
            return;
        }
        const envelope = event.data as Record<string, unknown>;
        if (hasReservedOfficialInboundId(envelope)) {
            event.stopImmediatePropagation();
            protocolFailure();
            return;
        }
        if (isViewRequestAttempt(envelope)) {
            const key = officialRequestIdKey(envelope.id);
            if (!key || activeOfficialRequestIds.has(key) || retiredOfficialRequestIds.has(key)) {
                event.stopImmediatePropagation();
                protocolFailure();
                return;
            }
            activeOfficialRequestIds.add(key);
        } else if (envelope.method === 'notifications/cancelled'
            && envelope.params && typeof envelope.params === 'object'
            && !Array.isArray(envelope.params)) {
            retireOfficialRequestId((envelope.params as Record<string, unknown>).requestId);
        }
        // Notifications and responses are schema/byte checked but deliberately
        // do not consume the budget; only envelopes with both method and ID are attempts.
    }

    const mountView = async (
        ownedId: string,
        html: string,
        context: z.infer<typeof hostContextSchema>,
    ): Promise<void> => {
        iframe = createSandboxedIframe(shellWindow.document, html);
        shellWindow.document.body.replaceChildren(iframe);
        const target = iframe.contentWindow;
        if (!target) {
            protocolFailure();
            return;
        }
        viewSource = target;
        viewRequestTimestamps.length = 0;
        activeOfficialRequestIds.clear();
        retiredOfficialRequestIds.clear();
        shellWindow.addEventListener('message', viewIngressListener, true);
        bridge = new PawsAppBridge(
            null,
            { name: 'Paws', version: '1.0.0' },
            { openLinks: {}, serverTools: {}, serverResources: {} },
            { hostContext: officialHostContext(context) },
        );
        bridge.onreadresource = async ({ uri }, extra) => relay({
            method: 'resources/read', params: { uri },
        }, extra.signal) as ReturnType<NonNullable<AppBridge['onreadresource']>>;
        bridge.oncalltool = async (params, extra) => relay({
            method: 'tools/call',
            params: {
                name: params.name,
                ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
                ...(params._meta !== undefined ? { _meta: params._meta } : {}),
            },
        }, extra.signal) as ReturnType<NonNullable<AppBridge['oncalltool']>>;
        bridge.onopenlink = async ({ url }, extra) => relay({
            method: 'ui/open-link', params: { url },
        }, extra.signal) as ReturnType<NonNullable<AppBridge['onopenlink']>>;
        bridge.replacePingHandler(async (_request, extra) => relay({
            method: 'ping', params: {},
        }, extra.signal) as Promise<Record<string, never>>);
        bridge.onrequestdisplaymode = async ({ mode }) => {
            if (mode === 'inline') return { mode: 'inline' };
            return unsupported();
        };
        bridge.ondownloadfile = unsupported;
        bridge.onmessage = unsupported;
        bridge.onupdatemodelcontext = unsupported;
        bridge.oncreatesamplingmessage = unsupported;
        bridge.onlistresources = unsupported;
        bridge.onlistresourcetemplates = unsupported;
        bridge.onlistprompts = unsupported;
        bridge.oninitialized = () => {
            if (instanceId === ownedId) post({ type: 'initialized', instanceId: ownedId });
        };
        bridge.onsizechange = ({ height }) => {
            if (height !== undefined) emitResize(height);
        };
        bridge.onrequestteardown = () => { void release(true); };
        post({ type: 'sandbox-ready', instanceId: ownedId });
        try {
            await bridge.connect(new TrackedPostMessageTransport(
                target,
                target,
                retireOfficialRequestId,
            ));
        } catch {
            protocolFailure();
        }
    };

    const handleCommand = async (raw: unknown) => {
        if (closing || disposed) return;
        let command: HostCommand;
        try {
            command = parseHostCommand(raw as string);
        } catch {
            protocolFailure();
            return;
        }

        if (command.type === 'mount') {
            if (instanceId) {
                protocolFailure();
                return;
            }
            instanceId = command.instanceId;
            await mountView(command.instanceId, command.html, command.context);
            return;
        }

        if (command.type === 'mount-start') {
            if (instanceId || mountAssembly || command.byteLength > MCP_APP_MAX_MOUNT_HTML_BYTES) {
                protocolFailure();
                return;
            }
            instanceId = command.instanceId;
            mountAssembly = {
                byteLength: command.byteLength,
                receivedBytes: 0,
                chunks: [],
                context: command.context,
            };
            return;
        }

        if (command.type === 'mount-chunk') {
            const assembly = mountAssembly;
            const chunk = decodeMountChunk(command.dataBase64);
            if (!assembly || !chunk || command.instanceId !== instanceId
                || command.offset !== assembly.receivedBytes
                || assembly.receivedBytes + chunk.byteLength > assembly.byteLength) {
                protocolFailure();
                return;
            }
            assembly.chunks.push(chunk);
            assembly.receivedBytes += chunk.byteLength;
            return;
        }

        if (command.type === 'mount-complete') {
            const assembly = mountAssembly;
            if (!assembly || command.instanceId !== instanceId
                || assembly.receivedBytes !== assembly.byteLength) {
                protocolFailure();
                return;
            }
            const bytes = new Uint8Array(assembly.byteLength);
            let offset = 0;
            for (const chunk of assembly.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            let html: string;
            try {
                html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                protocolFailure();
                return;
            }
            mountAssembly = undefined;
            await mountView(command.instanceId, html, assembly.context);
            return;
        }

        if (!instanceId || command.instanceId !== instanceId || !bridge) {
            protocolFailure();
            return;
        }
        try {
            switch (command.type) {
                case 'tool-input': await bridge.sendToolInput({ arguments: command.input }); break;
                case 'tool-result': await bridge.sendToolResult(
                    command.result as Parameters<AppBridge['sendToolResult']>[0],
                ); break;
                case 'tool-cancelled': await bridge.sendToolCancelled({ reason: command.reason }); break;
                case 'host-context': bridge.setHostContext(officialHostContext(command.context)); break;
                case 'bridge-response': {
                    const pending = pendingBridgeRequests.get(command.requestId);
                    if (!pending) {
                        if (abandonedBridgeRequestIds.delete(command.requestId)) break;
                        protocolFailure();
                        return;
                    }
                    pendingBridgeRequests.delete(command.requestId);
                    pending.removeAbortListener();
                    if (command.response.ok) {
                        pending.resolve(command.response.value);
                    } else {
                        pending.reject(new McpError(
                            ErrorCode.InternalError,
                            command.response.error.summary,
                            {
                                code: command.response.error.code,
                                retryable: command.response.error.retryable,
                            },
                        ));
                    }
                    break;
                }
                case 'teardown': await release(true); break;
            }
        } catch {
            protocolFailure();
        }
    };

    const listener = (event: MessageEvent) => {
        // The official transport exclusively owns the exact immediate View.
        if (viewSource && event.source === viewSource) return;
        // React Native WebView injects host commands with a null MessageEvent
        // source. The Web Proxy validates its parent and redispatches accepted
        // commands with that same null source. Foreign browser Windows are
        // untrusted, but ignoring them avoids giving an attacker a teardown
        // primitive against an otherwise healthy App.
        if (event.source !== null) {
            event.stopImmediatePropagation();
            return;
        }
        if (closing || disposed) return;
        void handleCommand(event.data);
    };
    shellWindow.addEventListener('message', listener);
    shellWindow.document.addEventListener('message', listener as EventListener);
    return () => {
        disposed = true;
        shellWindow.removeEventListener('message', listener);
        shellWindow.document.removeEventListener('message', listener as EventListener);
        shellWindow.removeEventListener('message', viewIngressListener, true);
        void release(false, false);
        shellConsole.debug = originalConsole.debug;
        shellConsole.info = originalConsole.info;
        shellConsole.log = originalConsole.log;
        shellConsole.warn = originalConsole.warn;
        shellConsole.error = originalConsole.error;
    };
}

if (typeof window !== 'undefined' && (window as ShellWindow).ReactNativeWebView) {
    startHostShell(window as ShellWindow);
}
