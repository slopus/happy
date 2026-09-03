import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import {
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    MCP_APP_MAX_FRAME_HEIGHT,
    NativeMcpAppFrameAdapter,
    NativeMcpAppFrameView,
} from './NativeMcpAppFrameAdapter.native';
import type { McpAppHostContext, McpAppResource } from './types';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: unknown) => typeof factory === 'function'
        ? (factory as (theme: object) => object)({ colors: { surface: '#101010', divider: '#303030' } })
        : factory },
}));
vi.mock('react-native-webview', async () => {
    const ReactModule = await import('react');
    return {
        WebView: ReactModule.forwardRef((props: object, forwardedRef) => ReactModule.createElement(
            'WebView', { ...props, forwardedRef },
        )),
    };
});

const context: McpAppHostContext = {
    theme: 'dark',
    locale: 'en',
    platform: 'android',
    touch: true,
    hover: false,
    container: { width: 390, height: 640 },
    safeAreaInsets: { top: 24, right: 0, bottom: 16, left: 0 },
    displayMode: 'inline',
};

const resource: McpAppResource = {
    resourceId: 'resource-1',
    uri: 'ui://demo/index.html',
    mimeType: 'text/html;profile=mcp-app',
    byteLength: 17,
    sha256: 'a'.repeat(64),
    encoding: 'utf8',
    html: '<main>safe</main>',
};

describe('NativeMcpAppFrameAdapter', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
    });

    it('renders one locked-down top WebView and denies arbitrary top-level navigation', () => {
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        act(() => { void adapter.mount({ resource, context, signal: new AbortController().signal, onSandboxReady: vi.fn(), onFailure: vi.fn(), onRequest: vi.fn() }); });
        const webView = renderer.root.findByType('WebView');

        expect(webView.props.testID).toBe('mcp-app-sandbox-frame');
        expect(webView.props.source.baseUrl).toBe('https://mcp-app-host.invalid/');
        // The wrapper must not pre-emptively hand a non-whitelisted URL to Linking.openURL;
        // every URL reaches our exact one-shot callback instead.
        expect(webView.props.originWhitelist).toEqual(['*']);
        expect(webView.props.javaScriptCanOpenWindowsAutomatically).toBe(false);
        expect(webView.props.setSupportMultipleWindows).toBe(false);
        expect(webView.props.allowFileAccess).toBe(false);
        expect(webView.props.allowFileAccessFromFileURLs).toBe(false);
        expect(webView.props.allowUniversalAccessFromFileURLs).toBe(false);
        expect(webView.props.mediaPlaybackRequiresUserAction).toBe(true);
        expect(webView.props.mediaCapturePermissionGrantType).toBe('deny');
        expect(webView.props.geolocationEnabled).toBe(false);
        expect(webView.props.allowsLinkPreview).toBe(false);
        expect(webView.props.onShouldStartLoadWithRequest({
            url: 'https://mcp-app-host.invalid/', isTopFrame: true,
        })).toBe(true);
        expect(webView.props.onShouldStartLoadWithRequest({
            url: 'https://example.com/escape', isTopFrame: true,
        })).toBe(false);
        expect(webView.props.onShouldStartLoadWithRequest({
            url: 'https://mcp-app-host.invalid/', isTopFrame: true,
        })).toBe(false);
        expect(webView.props.onShouldStartLoadWithRequest({
            url: 'https://mcp-app-host.invalid/child', isTopFrame: false,
        })).toBe(false);

        act(() => renderer.unmount());
    });

    it('inherits validated resource CSP for external assets while denying permissions and honoring its border preference', () => {
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        const externalResource: McpAppResource = {
            ...resource,
            html: '<link rel="stylesheet" href="https://cdn.example.test/app.css"><script src="https://cdn.example.test/app.js"></script>',
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
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        act(() => { void adapter.mount({ resource: externalResource, context, signal: new AbortController().signal, onSandboxReady: vi.fn(), onFailure: vi.fn(), onRequest: vi.fn() }); });
        const webView = renderer.root.findByType('WebView');

        expect(webView.props.source.html).toContain("script-src 'unsafe-inline' https://cdn.example.test");
        expect(webView.props.source.html).toContain("style-src 'unsafe-inline' https://cdn.example.test");
        expect(webView.props.source.html).toContain('connect-src https://api.example.test');
        expect(webView.props.source.html).toContain("frame-src data: blob: 'self' https://frame.example.test");
        expect(webView.props.mediaCapturePermissionGrantType).toBe('deny');
        expect(webView.props.geolocationEnabled).toBe(false);
        expect(webView.props.style).toMatchObject({ borderWidth: 1, borderColor: '#303030' });

        act(() => renderer.unmount());
    });

    it('uses postMessage commands only, initializes once, clamps/throttles resize, and disposes', async () => {
        vi.useFakeTimers();
        const posted: string[] = [];
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        const ready = vi.fn();
        let mounted!: Promise<any>;
        act(() => { mounted = adapter.mount({ resource, context, signal: new AbortController().signal, onSandboxReady: ready, onFailure: vi.fn(), onRequest: vi.fn() }); });
        const webView = renderer.root.findByType('WebView');
        act(() => webView.props.forwardedRef({ postMessage: (message: string) => posted.push(message) }));
        act(() => webView.props.onLoadEnd());

        expect(JSON.parse(posted[0])).toEqual({
            type: 'mount', instanceId: 'frame-1', html: resource.html, context,
        });
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'sandbox-ready', instanceId: 'frame-1',
        }) } }));
        expect(ready).toHaveBeenCalledTimes(1);
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'initialized', instanceId: 'frame-1',
        }) } }));
        const frame = await mounted;

        frame.sendToolInput({ city: 'Hangzhou' });
        frame.sendToolResult({ content: [] });
        frame.updateHostContext({ ...context, theme: 'light' });
        expect(posted.slice(1).map((message) => JSON.parse(message).type)).toEqual([
            'tool-input', 'tool-result', 'host-context',
        ]);
        expect((adapter as any).injectJavaScript).toBeUndefined();

        act(() => {
            webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
                type: 'resize', instanceId: 'frame-1', height: 300,
            }) } });
            webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
                type: 'resize', instanceId: 'frame-1', height: 99_999,
            }) } });
        });
        expect(renderer.root.findByType('WebView').props.style.height).not.toBe(MCP_APP_MAX_FRAME_HEIGHT);
        act(() => { vi.advanceTimersByTime(16); });
        expect(renderer.root.findByType('WebView').props.style.height).toBe(MCP_APP_MAX_FRAME_HEIGHT);

        const disposing = frame.teardown();
        expect(JSON.parse(posted.at(-1)!)).toEqual({ type: 'teardown', instanceId: 'frame-1' });
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'teardown-complete', instanceId: 'frame-1',
        }) } }));
        await disposing;
        expect(renderer.root.findAllByType('WebView')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('splits an oversized App document into bounded WebView messages', async () => {
        const posted: string[] = [];
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        const html = `<main>${'x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES * 2)}</main>`;
        let mounted!: Promise<any>;
        act(() => { mounted = adapter.mount({
            resource: { ...resource, byteLength: new TextEncoder().encode(html).byteLength, html },
            context,
            signal: new AbortController().signal,
            onSandboxReady: vi.fn(),
            onFailure: vi.fn(),
            onRequest: vi.fn(),
        }); });
        const webView = renderer.root.findByType('WebView');
        act(() => webView.props.forwardedRef({ postMessage: (message: string) => posted.push(message) }));
        act(() => webView.props.onLoadEnd());

        expect(posted.every((raw) => new TextEncoder().encode(raw).byteLength <= MCP_APP_MAX_BRIDGE_MESSAGE_BYTES)).toBe(true);
        expect(posted.map((raw) => JSON.parse(raw).type)).toEqual([
            'mount-start', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-complete',
        ]);

        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'sandbox-ready', instanceId: 'frame-1',
        }) } }));
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'initialized', instanceId: 'frame-1',
        }) } }));
        await expect(mounted).resolves.toBeDefined();
        act(() => renderer.unmount());
    });

    it('tears down the owned frame on malformed, wrong-instance, or oversized protocol data', async () => {
        for (const data of [
            '{not-json',
            JSON.stringify({ type: 'initialized', instanceId: 'other-frame' }),
            'x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES + 1),
        ]) {
            const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
            let renderer: any;
            act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
            let mounted!: Promise<any>;
            act(() => { mounted = adapter.mount({ resource, context, signal: new AbortController().signal, onSandboxReady: vi.fn(), onFailure: vi.fn(), onRequest: vi.fn() }); });
            const webView = renderer.root.findByType('WebView');
            act(() => webView.props.onMessage({ nativeEvent: { data } }));

            await expect(mounted).rejects.toMatchObject({ code: 'MCP_APP_BRIDGE_PROTOCOL' });
            expect(renderer.root.findAllByType('WebView')).toHaveLength(0);
            act(() => renderer.unmount());
        }
    });

    it('reports every post-active protocol failure and revokes the frame', async () => {
        const failures = [
            '{not-json',
            JSON.stringify({ type: 'initialized', instanceId: 'other-frame' }),
            'x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES + 1),
            JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }),
            JSON.stringify({ type: 'protocol-error', instanceId: 'frame-1' }),
        ];

        for (const data of failures) {
            const onFailure = vi.fn();
            const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
            let renderer: any;
            act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
            let mounted!: Promise<any>;
            act(() => {
                mounted = adapter.mount({
                    resource, context, signal: new AbortController().signal,
                    onSandboxReady: vi.fn(), onFailure, onRequest: vi.fn(),
                });
            });
            const webView = renderer.root.findByType('WebView');
            act(() => webView.props.forwardedRef({ postMessage: vi.fn() }));
            act(() => webView.props.onLoadEnd());
            act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
                type: 'sandbox-ready', instanceId: 'frame-1',
            }) } }));
            act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
                type: 'initialized', instanceId: 'frame-1',
            }) } }));
            await mounted;

            act(() => webView.props.onMessage({ nativeEvent: { data } }));

            expect(onFailure).toHaveBeenCalledTimes(1);
            expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
                code: 'MCP_APP_BRIDGE_PROTOCOL', retryable: false,
            }));
            expect(renderer.root.findAllByType('WebView')).toHaveLength(0);
            act(() => renderer.unmount());
        }
    });

    it('reports post-active load and process termination as retryable sandbox failures', async () => {
        for (const eventName of [
            'onError', 'onHttpError', 'onContentProcessDidTerminate', 'onRenderProcessGone',
        ]) {
            const onFailure = vi.fn();
            const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
            let renderer: any;
            act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
            let mounted!: Promise<any>;
            act(() => {
                mounted = adapter.mount({
                    resource, context, signal: new AbortController().signal,
                    onSandboxReady: vi.fn(), onFailure, onRequest: vi.fn(),
                });
            });
            const webView = renderer.root.findByType('WebView');
            act(() => webView.props.forwardedRef({ postMessage: vi.fn() }));
            act(() => webView.props.onLoadEnd());
            act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
                type: 'sandbox-ready', instanceId: 'frame-1',
            }) } }));
            act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
                type: 'initialized', instanceId: 'frame-1',
            }) } }));
            await mounted;

            expect(webView.props[eventName]).toEqual(expect.any(Function));
            act(() => webView.props[eventName]({ nativeEvent: {} }));

            expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
                code: 'MCP_APP_SANDBOX_UNAVAILABLE', retryable: true,
            }));
            expect(renderer.root.findAllByType('WebView')).toHaveLength(0);
            act(() => renderer.unmount());
        }
    });

    it('correlates a validated bridge request with a safe response', async () => {
        const posted: string[] = [];
        const onRequest = vi.fn(async () => ({
            content: [{ type: 'text', text: 'done' }],
        }));
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        let mounted!: Promise<any>;
        act(() => {
            mounted = adapter.mount({
                resource, context, signal: new AbortController().signal,
                onSandboxReady: vi.fn(), onFailure: vi.fn(), onRequest,
            });
        });
        const webView = renderer.root.findByType('WebView');
        act(() => webView.props.forwardedRef({ postMessage: (message: string) => posted.push(message) }));
        act(() => webView.props.onLoadEnd());
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'sandbox-ready', instanceId: 'frame-1',
        }) } }));
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'initialized', instanceId: 'frame-1',
        }) } }));
        await mounted;

        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'bridge-request',
            instanceId: 'frame-1',
            requestId: 'request-7',
            request: {
                method: 'tools/call',
                params: { name: 'refresh', arguments: { id: 1 } },
            },
        }) } }));

        await vi.waitFor(() => expect(onRequest).toHaveBeenCalledWith(
            {
                method: 'tools/call',
                params: { name: 'refresh', arguments: { id: 1 } },
            },
            expect.any(AbortSignal),
        ));
        await vi.waitFor(() => expect(posted.map((message) => JSON.parse(message))).toContainEqual({
            type: 'bridge-response',
            instanceId: 'frame-1',
            requestId: 'request-7',
            response: {
                ok: true,
                value: { content: [{ type: 'text', text: 'done' }] },
            },
        }));
        expect(JSON.stringify(posted)).not.toContain('call-1');
        expect(JSON.stringify(posted)).not.toContain('connector');

        act(() => renderer.unmount());
    });

    it('normalizes raw request errors and never posts a late response after teardown', async () => {
        let resolveLate!: (value: unknown) => void;
        let requestCount = 0;
        const onRequest = vi.fn(() => {
            requestCount += 1;
            if (requestCount === 1) {
                return Promise.reject(new Error('CANARY ui://secret raw error'));
            }
            return new Promise<unknown>((resolve) => { resolveLate = resolve; });
        });
        const posted: string[] = [];
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        let mounted!: Promise<any>;
        act(() => {
            mounted = adapter.mount({
                resource, context, signal: new AbortController().signal,
                onSandboxReady: vi.fn(), onFailure: vi.fn(), onRequest,
            });
        });
        const webView = renderer.root.findByType('WebView');
        act(() => webView.props.forwardedRef({ postMessage: (message: string) => posted.push(message) }));
        act(() => webView.props.onLoadEnd());
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'sandbox-ready', instanceId: 'frame-1' }) } }));
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }) } }));
        const frame = await mounted;

        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'bridge-request', instanceId: 'frame-1', requestId: 'request-error',
            request: { method: 'ping', params: {} },
        }) } }));
        await vi.waitFor(() => expect(posted.map((message) => JSON.parse(message))).toContainEqual({
            type: 'bridge-response', instanceId: 'frame-1', requestId: 'request-error',
            response: {
                ok: false,
                error: {
                    code: 'MCP_APP_INTERNAL',
                    retryable: false,
                    summary: 'The App request could not be completed.',
                },
            },
        }));
        expect(JSON.stringify(posted)).not.toContain('CANARY');
        expect(JSON.stringify(posted)).not.toContain('ui://secret');

        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'bridge-request', instanceId: 'frame-1', requestId: 'request-late',
            request: { method: 'ping', params: {} },
        }) } }));
        await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2));
        const disposing = frame.teardown();
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'teardown-complete', instanceId: 'frame-1',
        }) } }));
        await disposing;
        resolveLate({ canary: 'CANARY_LATE_RESPONSE' });
        await Promise.resolve();
        expect(JSON.stringify(posted)).not.toContain('CANARY_LATE_RESPONSE');

        act(() => renderer.unmount());
    });

    it('aborts a correlated request, releases it, and ignores cancel/response races', async () => {
        let resolveLate!: (value: unknown) => void;
        let requestSignal: AbortSignal | undefined;
        const onRequest = vi.fn((_request, signal?: AbortSignal) => {
            requestSignal = signal;
            return new Promise<unknown>((resolve) => { resolveLate = resolve; });
        });
        const posted: string[] = [];
        const onFailure = vi.fn();
        const adapter = new NativeMcpAppFrameAdapter({ createInstanceId: () => 'frame-1' });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<NativeMcpAppFrameView adapter={adapter} />); });
        let mounted!: Promise<any>;
        act(() => {
            mounted = adapter.mount({
                resource, context, signal: new AbortController().signal,
                onSandboxReady: vi.fn(), onFailure, onRequest,
            });
        });
        const webView = renderer.root.findByType('WebView');
        act(() => webView.props.forwardedRef({ postMessage: (message: string) => posted.push(message) }));
        act(() => webView.props.onLoadEnd());
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'sandbox-ready', instanceId: 'frame-1' }) } }));
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }) } }));
        await mounted;
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'bridge-request', instanceId: 'frame-1', requestId: 'request-cancelled',
            request: { method: 'tools/call', params: { name: 'late' } },
        }) } }));
        await vi.waitFor(() => expect(requestSignal).toEqual(expect.any(AbortSignal)));

        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'bridge-cancel', instanceId: 'frame-1', requestId: 'request-cancelled',
        }) } }));

        expect(requestSignal?.aborted).toBe(true);
        expect(renderer.root.findAllByType('WebView')).toHaveLength(1);
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({
            type: 'bridge-cancel', instanceId: 'frame-1', requestId: 'request-cancelled',
        }) } }));
        resolveLate({ content: [{ type: 'text', text: 'CANARY_LATE' }] });
        await Promise.resolve();
        expect(JSON.stringify(posted)).not.toContain('CANARY_LATE');
        expect(onFailure).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });
});
