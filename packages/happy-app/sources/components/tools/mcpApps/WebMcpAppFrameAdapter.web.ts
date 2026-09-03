import * as React from 'react';
import {
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    MCP_APP_MIN_FRAME_HEIGHT,
    utf8ByteLength,
} from '../../../../mcp-app-sandbox/protocol';
import { McpAppFrameBridge, type McpAppFrameBridgeSnapshot } from './McpAppFrameBridge';
import { normalizeMcpAppResourceUi } from './resourceUiMetadata';
import { UnsupportedMcpAppFrameAdapter } from './UnsupportedMcpAppFrameAdapter';
import { McpAppHostError, type FrameMountInput, type McpAppFrame, type McpAppFrameAdapter } from './types';

export const MCP_APP_SANDBOX_MAX_CSP_BYTES = 8 * 1024;
export const MCP_APP_SANDBOX_MAX_CSP_ORIGINS = 32;

export type ResolvedWebMcpAppSandbox = {
    enabled: true;
    sandboxOrigin: string;
    appOrigin: string;
} | {
    enabled: false;
    code: 'MCP_APP_SANDBOX_UNAVAILABLE';
};

type MessageTarget = {
    addEventListener(type: 'message', listener: EventListener): void;
    removeEventListener(type: 'message', listener: EventListener): void;
};

type FrameWindow = { postMessage(message: string, targetOrigin: string): void };
type FrameElement = { contentWindow: FrameWindow | null };

type WebSnapshot = McpAppFrameBridgeSnapshot & { src?: string; prefersBorder: boolean };

function isLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalDevelopmentHttp(raw: string): boolean {
    const match = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?\/?$/u.exec(raw);
    return Boolean(match && (match[1] === undefined || Number(match[1]) <= 65_535));
}

function normalizeExactOrigin(raw: string | undefined, development: boolean): string | null {
    if (!raw || raw.trim() !== raw || /[\s;'"\\?#]/u.test(raw)) return null;
    const withoutRootSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const separator = withoutRootSlash.indexOf('://');
    if (separator <= 0 || withoutRootSlash.slice(separator + 3).includes('/')) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || !url.hostname || url.hostname.includes('*') || url.hostname.endsWith('.')) return null;
    if (url.protocol !== 'https:') {
        if (url.protocol !== 'http:' || !development || !isLoopbackHostname(url.hostname)
            || !canonicalDevelopmentHttp(raw)) return null;
    }
    return url.origin === 'null' ? null : url.origin;
}

export function resolveWebMcpAppSandbox(input: {
    sandboxOrigin: string | undefined;
    appOrigin: string | undefined;
    development: boolean;
}): ResolvedWebMcpAppSandbox {
    const sandboxOrigin = normalizeExactOrigin(input.sandboxOrigin, input.development);
    const appOrigin = normalizeExactOrigin(input.appOrigin, input.development);
    if (!sandboxOrigin || !appOrigin || sandboxOrigin === appOrigin) {
        return { enabled: false, code: 'MCP_APP_SANDBOX_UNAVAILABLE' };
    }
    return { enabled: true, sandboxOrigin, appOrigin };
}

function normalizeCspDomains(value: unknown, development: boolean): string[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MCP_APP_SANDBOX_MAX_CSP_ORIGINS) return null;
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
        if (typeof raw !== 'string') return null;
        const origin = normalizeExactOrigin(raw, development);
        if (!origin) return null;
        if (!seen.has(origin)) {
            seen.add(origin);
            domains.push(origin);
        }
    }
    return domains;
}

function encodeBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function encodeCspMetadata(input: unknown, development: boolean): string | null {
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return null;
    const raw = (input ?? {}) as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (keys.some((key) => !['connectDomains', 'resourceDomains', 'frameDomains'].includes(key))) return null;
    const connectDomains = normalizeCspDomains(raw.connectDomains, development);
    const resourceDomains = normalizeCspDomains(raw.resourceDomains, development);
    const frameDomains = normalizeCspDomains(raw.frameDomains, development);
    if (!connectDomains || !resourceDomains || !frameDomains) return null;
    const encoded = encodeBase64Url(JSON.stringify({ connectDomains, resourceDomains, frameDomains }));
    return utf8ByteLength(encoded) <= MCP_APP_SANDBOX_MAX_CSP_BYTES ? encoded : null;
}

function sandboxUnavailable(): McpAppHostError {
    return new McpAppHostError('MCP_APP_SANDBOX_UNAVAILABLE', false, 'The App sandbox is unavailable.');
}

function protocolError(): McpAppHostError {
    return new McpAppHostError('MCP_APP_BRIDGE_PROTOCOL', false, 'The App bridge protocol failed.');
}

function isExactProxyReady(value: unknown, appOrigin: string): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 2
        && record.type === 'sandbox-proxy-ready'
        && record.parentOrigin === appOrigin;
}

export class WebMcpAppFrameAdapter implements McpAppFrameAdapter {
    readonly support = 'supported' as const;
    readonly originScoped = true;
    private readonly config: Extract<ResolvedWebMcpAppSandbox, { enabled: true }>;
    private readonly eventWindow: MessageTarget;
    private readonly bridge: McpAppFrameBridge;
    private src?: string;
    private frameWindow?: FrameWindow;
    private listening = false;
    private proxyReady = false;
    private cachedBridgeSnapshot?: McpAppFrameBridgeSnapshot;
    private cachedSnapshot?: WebSnapshot;
    private prefersBorder = false;

    constructor(options: {
        config: Extract<ResolvedWebMcpAppSandbox, { enabled: true }>;
        eventWindow?: MessageTarget;
        createInstanceId?: () => string;
    }) {
        this.config = options.config;
        this.eventWindow = options.eventWindow ?? window;
        this.bridge = new McpAppFrameBridge({
            createInstanceId: options.createInstanceId,
            originScoped: true,
            onCleared: this.cleanup,
        });
    }

    subscribe = (listener: () => void): (() => void) => this.bridge.subscribe(listener);
    getSnapshot = (): WebSnapshot => {
        const bridgeSnapshot = this.bridge.getSnapshot();
        if (this.cachedSnapshot && this.cachedBridgeSnapshot === bridgeSnapshot
            && this.cachedSnapshot.src === this.src
            && this.cachedSnapshot.prefersBorder === this.prefersBorder) return this.cachedSnapshot;
        this.cachedBridgeSnapshot = bridgeSnapshot;
        this.cachedSnapshot = {
            ...bridgeSnapshot,
            ...(this.src ? { src: this.src } : {}),
            prefersBorder: this.prefersBorder,
        };
        return this.cachedSnapshot;
    };

    attachFrame = (frame: FrameElement | null): void => {
        const nextWindow = frame?.contentWindow ?? undefined;
        if (this.bridge.getSnapshot().visible && this.frameWindow && nextWindow && nextWindow !== this.frameWindow) {
            this.bridge.fail(protocolError());
            return;
        }
        this.frameWindow = nextWindow;
        if (!nextWindow && this.bridge.getSnapshot().visible) this.bridge.transportFailure();
    };

    async mount(input: FrameMountInput): Promise<McpAppFrame> {
        const development = this.config.appOrigin.startsWith('http://');
        const ui = normalizeMcpAppResourceUi(input.resource.ui, development);
        if (ui === null) throw sandboxUnavailable();
        const csp = encodeCspMetadata(ui?.csp, development);
        if (!csp) throw sandboxUnavailable();
        const url = new URL('/mcp-app-sandbox/host', this.config.sandboxOrigin);
        url.searchParams.set('parentOrigin', this.config.appOrigin);
        url.searchParams.set('csp', csp);
        this.src = url.toString();
        this.prefersBorder = ui?.prefersBorder === true;
        this.proxyReady = false;
        this.startListening();
        try {
            return await this.bridge.mount(input);
        } catch (error) {
            this.cleanup();
            throw error;
        }
    }

    private startListening(): void {
        if (this.listening) return;
        this.listening = true;
        this.eventWindow.addEventListener('message', this.onMessage as EventListener);
    }

    private cleanup = (): void => {
        if (this.listening) this.eventWindow.removeEventListener('message', this.onMessage as EventListener);
        this.listening = false;
        this.proxyReady = false;
        this.frameWindow = undefined;
        this.src = undefined;
        this.prefersBorder = false;
    };

    private onMessage = (event: MessageEvent): void => {
        if (!this.bridge.getSnapshot().visible) return;
        if (!this.frameWindow || event.source !== this.frameWindow as unknown as MessageEventSource) return;
        if (event.origin !== this.config.sandboxOrigin
            || typeof event.data !== 'string'
            || utf8ByteLength(event.data) > MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) {
            this.bridge.fail(protocolError());
            return;
        }
        if (!this.proxyReady) {
            let ready: unknown;
            try { ready = JSON.parse(event.data); } catch { this.bridge.fail(protocolError()); return; }
            if (!isExactProxyReady(ready, this.config.appOrigin)) {
                this.bridge.fail(protocolError());
                return;
            }
            this.proxyReady = true;
            const ownedWindow = this.frameWindow;
            this.bridge.attachTransport((raw) => ownedWindow.postMessage(raw, this.config.sandboxOrigin));
            try { this.bridge.transportReady(); } catch {
                // The common bridge has already failed closed and settled the mount.
            }
            return;
        }
        this.bridge.receive(event.data);
    };

    onFrameFailure = (): void => this.bridge.transportFailure();
}

export function createWebMcpAppFrameAdapter(): WebMcpAppFrameAdapter | UnsupportedMcpAppFrameAdapter {
    const config = resolveWebMcpAppSandbox({
        sandboxOrigin: process.env.EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN,
        appOrigin: typeof window === 'undefined' ? undefined : window.location.origin,
        development: typeof __DEV__ !== 'undefined' && __DEV__,
    });
    if (!config.enabled) {
        return new UnsupportedMcpAppFrameAdapter();
    }
    return new WebMcpAppFrameAdapter({ config });
}

export function WebMcpAppFrameView({ adapter }: { adapter: WebMcpAppFrameAdapter }) {
    const snapshot = React.useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
    if (!snapshot.visible || !snapshot.src) return null;
    return React.createElement('iframe', {
        ref: adapter.attachFrame,
        'data-testid': 'mcp-app-sandbox-frame',
        src: snapshot.src,
        title: 'MCP App sandbox',
        sandbox: 'allow-scripts allow-same-origin',
        allow: "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
        referrerPolicy: 'origin',
        onError: adapter.onFrameFailure,
        style: {
            display: 'block', width: '100%', height: snapshot.height || MCP_APP_MIN_FRAME_HEIGHT,
            border: snapshot.prefersBorder ? '1px solid currentColor' : 0,
            background: 'transparent',
        },
    });
}
