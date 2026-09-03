import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

import {
    MCP_APP_SANDBOX_MAX_CSP_BYTES,
    WebMcpAppFrameAdapter,
    WebMcpAppFrameView,
    resolveWebMcpAppSandbox,
} from './WebMcpAppFrameAdapter.web';
import { MCP_APP_MAX_BRIDGE_MESSAGE_BYTES } from '../../../../mcp-app-sandbox/protocol';
import type { McpAppHostContext, McpAppResource } from './types';

type MessageListener = (event: MessageEvent) => void;

class FakeWindow {
    listeners = new Set<MessageListener>();

    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === 'message') this.listeners.add(listener as MessageListener);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === 'message') this.listeners.delete(listener as MessageListener);
    }

    dispatch(event: Pick<MessageEvent, 'data' | 'origin' | 'source'>) {
        for (const listener of [...this.listeners]) listener(event as MessageEvent);
    }
}

const context: McpAppHostContext = {
    theme: 'dark', locale: 'en', platform: 'web', touch: false, hover: true,
    container: { width: 1024, height: 768 },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 }, displayMode: 'inline',
};

const resource: McpAppResource = {
    resourceId: 'resource-secret', uri: 'ui://private/app.html',
    mimeType: 'text/html;profile=mcp-app', byteLength: 17, sha256: 'a'.repeat(64),
    encoding: 'utf8', html: '<link rel="stylesheet" href="https://cdn.example/app.css"><script src="https://cdn.example/app.js"></script>',
    ui: { csp: {
        connectDomains: ['https://api.example'],
        resourceDomains: ['https://cdn.example'],
        frameDomains: ['https://frame.example'],
    }, permissions: { camera: {}, clipboardWrite: {} }, prefersBorder: true },
};

function mountInput(overrides: Partial<Parameters<WebMcpAppFrameAdapter['mount']>[0]> = {}) {
    return {
        resource,
        context,
        signal: new AbortController().signal,
        onSandboxReady: vi.fn(),
        onFailure: vi.fn(),
        onRequest: vi.fn(async () => ({})),
        ...overrides,
    };
}

function parseCspFromUrl(src: string) {
    const encoded = new URL(src).searchParams.get('csp')!;
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    return JSON.parse(Buffer.from(base64 + padding, 'base64').toString('utf8'));
}

describe('resolveWebMcpAppSandbox', () => {
    it.each([
        ['missing config', undefined, 'https://paws.example', false],
        ['same origin', 'https://paws.example', 'https://paws.example', false],
        ['HTTP production sandbox', 'http://sandbox.paws.example', 'https://paws.example', false],
        ['credentials', 'https://user:secret@sandbox.paws.example', 'https://paws.example', false],
        ['path', 'https://sandbox.paws.example/path', 'https://paws.example', false],
        ['wildcard', 'https://*.paws.example', 'https://paws.example', false],
        ['query', 'https://sandbox.paws.example?mode=1', 'https://paws.example', false],
        ['empty query delimiter', 'https://sandbox.paws.example?', 'https://paws.example', false],
        ['fragment', 'https://sandbox.paws.example#host', 'https://paws.example', false],
        ['empty fragment delimiter', 'https://sandbox.paws.example#', 'https://paws.example', false],
        ['non-canonical localhost', 'http://LOCALHOST:3005', 'http://localhost:8081', true],
    ])('fails closed for %s', (_label, sandboxOrigin, appOrigin, development) => {
        expect(resolveWebMcpAppSandbox({ sandboxOrigin, appOrigin, development })).toEqual({
            enabled: false,
            code: 'MCP_APP_SANDBOX_UNAVAILABLE',
        });
    });

    it('accepts exact different HTTPS origins and canonical development localhost origins', () => {
        expect(resolveWebMcpAppSandbox({
            sandboxOrigin: 'https://sandbox.paws.example:443/',
            appOrigin: 'https://paws.example',
            development: false,
        })).toEqual({ enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' });
        expect(resolveWebMcpAppSandbox({
            sandboxOrigin: 'http://localhost:3005',
            appOrigin: 'http://localhost:8081',
            development: true,
        })).toEqual({ enabled: true, sandboxOrigin: 'http://localhost:3005', appOrigin: 'http://localhost:8081' });
        expect(resolveWebMcpAppSandbox({
            sandboxOrigin: 'http://[::1]:3005',
            appOrigin: 'http://[::1]:8081',
            development: true,
        })).toEqual({ enabled: true, sandboxOrigin: 'http://[::1]:3005', appOrigin: 'http://[::1]:8081' });
    });
});

describe('WebMcpAppFrameAdapter', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
    });

    it('creates one restrictive exact-origin iframe with canonical CSP and no authority in DOM attributes', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'instance-secret',
        });
        const child = { postMessage: vi.fn() };
        let renderer: any;
        let mounted!: Promise<unknown>;
        act(() => {
            mounted = adapter.mount(mountInput());
            renderer = TestRenderer.create(<WebMcpAppFrameView adapter={adapter} />, {
                createNodeMock: (element: { type: string }) => element.type === 'iframe' ? { contentWindow: child } : null,
            });
        });

        const iframe = renderer.root.findByType('iframe');
        expect(iframe.props.testID).toBeUndefined();
        expect(iframe.props['data-testid']).toBe('mcp-app-sandbox-frame');
        expect(iframe.props.sandbox).toBe('allow-scripts allow-same-origin');
        expect(iframe.props.referrerPolicy).toBe('origin');
        expect(iframe.props.allow).toContain("camera 'none'");
        expect(iframe.props.allow).toContain("clipboard-write 'none'");
        expect(iframe.props.style.border).toBe('1px solid currentColor');
        expect(iframe.props.src).toMatch(/^https:\/\/sandbox\.paws\.example\/mcp-app-sandbox\/host\?/);
        expect(new URL(iframe.props.src).searchParams.get('parentOrigin')).toBe('https://paws.example');
        expect(parseCspFromUrl(iframe.props.src)).toEqual({
            connectDomains: ['https://api.example'],
            resourceDomains: ['https://cdn.example'],
            frameDomains: ['https://frame.example'],
        });
        expect(JSON.stringify(iframe.props)).not.toContain('instance-secret');
        expect(JSON.stringify(iframe.props)).not.toContain('resource-secret');
        expect(JSON.stringify(iframe.props)).not.toContain('ui://private/app.html');
        expect(JSON.stringify(iframe.props)).not.toContain('cdn.example/app.js');
        act(() => renderer.unmount());
        await expect(mounted).rejects.toMatchObject({ code: 'MCP_APP_SANDBOX_UNAVAILABLE' });
    });

    it('accepts only the owned window and exact sandbox origin, then posts only to that exact origin', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const input = mountInput();
        const mounted = adapter.mount(input);

        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' }),
        });
        expect(input.onSandboxReady).not.toHaveBeenCalled();
        expect(child.postMessage).toHaveBeenCalledTimes(1);
        expect(child.postMessage.mock.calls[0][1]).toBe('https://sandbox.paws.example');
        expect(JSON.parse(child.postMessage.mock.calls[0][0])).toEqual({
            type: 'mount', instanceId: 'frame-1', html: resource.html, context,
        });

        eventWindow.dispatch({
            source: child as unknown as MessageEventSource, origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'sandbox-ready', instanceId: 'frame-1' }),
        });
        expect(input.onSandboxReady).toHaveBeenCalledTimes(1);
        eventWindow.dispatch({
            source: child as unknown as MessageEventSource, origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }),
        });
        const frame = await mounted;
        frame.sendToolInput({ city: 'Hangzhou' });
        expect(child.postMessage.mock.calls.at(-1)?.[1]).toBe('https://sandbox.paws.example');
    });

    it('splits an oversized App document into bounded mount commands', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const html = `<main>${'x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES * 2)}</main>`;
        const mounted = adapter.mount(mountInput({ resource: {
            ...resource,
            byteLength: new TextEncoder().encode(html).byteLength,
            html,
        } }));

        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' }),
        });

        const rawCommands = child.postMessage.mock.calls.map(([raw]) => raw as string);
        expect(rawCommands.every((raw) => new TextEncoder().encode(raw).byteLength <= MCP_APP_MAX_BRIDGE_MESSAGE_BYTES)).toBe(true);
        expect(rawCommands.map((raw) => JSON.parse(raw).type)).toEqual([
            'mount-start', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-complete',
        ]);

        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'sandbox-ready', instanceId: 'frame-1' }),
        });
        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }),
        });
        await expect(mounted).resolves.toBeDefined();
    });

    it.each([
        ['wrong origin', { source: null, origin: 'https://lookalike.paws.example', data: JSON.stringify({ type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' }) }],
        ['wrong referrer acknowledgement', { source: null, origin: 'https://sandbox.paws.example', data: JSON.stringify({ type: 'sandbox-proxy-ready', parentOrigin: 'https://other.example' }) }],
        ['malformed data', { source: null, origin: 'https://sandbox.paws.example', data: '{bad' }],
        ['oversize data', { source: null, origin: 'https://sandbox.paws.example', data: 'x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES + 1) }],
    ])('tears down a pending frame after %s', async (_label, event) => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const mounted = adapter.mount(mountInput());
        eventWindow.dispatch({ ...event, source: event.source ?? child as unknown as MessageEventSource });

        await expect(mounted).rejects.toMatchObject({ code: 'MCP_APP_BRIDGE_PROTOCOL' });
        expect(adapter.getSnapshot().visible).toBe(false);
        expect(eventWindow.listeners).toHaveLength(0);
    });

    it('ignores unrelated WindowProxy messages but still rejects a wrong origin from its owned source', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const mounted = adapter.mount(mountInput());

        eventWindow.dispatch({
            source: { postMessage: vi.fn() } as unknown as MessageEventSource,
            origin: 'https://unrelated.example',
            data: '{malformed-but-unowned',
        });
        expect(adapter.getSnapshot().visible).toBe(true);
        expect(eventWindow.listeners).toHaveLength(1);

        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://lookalike.paws.example',
            data: JSON.stringify({ type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' }),
        });
        await expect(mounted).rejects.toMatchObject({ code: 'MCP_APP_BRIDGE_PROTOCOL' });
        expect(adapter.getSnapshot().visible).toBe(false);
        expect(eventWindow.listeners).toHaveLength(0);
    });

    it('routes simultaneous iframe messages only to their owning adapter', async () => {
        const eventWindow = new FakeWindow();
        const createAdapter = (instanceId: string) => new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => instanceId,
        });
        const adapterA = createAdapter('frame-a');
        const adapterB = createAdapter('frame-b');
        const childA = { postMessage: vi.fn() };
        const childB = { postMessage: vi.fn() };
        adapterA.attachFrame({ contentWindow: childA });
        adapterB.attachFrame({ contentWindow: childB });
        const inputA = mountInput();
        const inputB = mountInput();
        const mountedA = adapterA.mount(inputA);
        const mountedB = adapterB.mount(inputB);

        const dispatchOwned = (source: typeof childA, data: unknown) => eventWindow.dispatch({
            source: source as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify(data),
        });
        dispatchOwned(childA, { type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' });
        expect(adapterB.getSnapshot().visible).toBe(true);
        expect(childA.postMessage).toHaveBeenCalledTimes(1);
        expect(childB.postMessage).not.toHaveBeenCalled();
        dispatchOwned(childB, { type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' });
        expect(adapterA.getSnapshot().visible).toBe(true);

        dispatchOwned(childA, { type: 'sandbox-ready', instanceId: 'frame-a' });
        expect(inputA.onSandboxReady).toHaveBeenCalledTimes(1);
        expect(inputB.onSandboxReady).not.toHaveBeenCalled();
        dispatchOwned(childB, { type: 'sandbox-ready', instanceId: 'frame-b' });
        dispatchOwned(childA, { type: 'initialized', instanceId: 'frame-a' });
        dispatchOwned(childB, { type: 'initialized', instanceId: 'frame-b' });
        const frameA = await mountedA;
        const frameB = await mountedB;
        frameA.sendToolInput({ owner: 'a' });
        frameB.sendToolInput({ owner: 'b' });

        expect(JSON.parse(childA.postMessage.mock.calls.at(-1)?.[0])).toMatchObject({
            type: 'tool-input', instanceId: 'frame-a', input: { owner: 'a' },
        });
        expect(JSON.parse(childB.postMessage.mock.calls.at(-1)?.[0])).toMatchObject({
            type: 'tool-input', instanceId: 'frame-b', input: { owner: 'b' },
        });

        const tearingDownA = frameA.teardown();
        dispatchOwned(childA, { type: 'teardown-complete', instanceId: 'frame-a' });
        await tearingDownA;
        expect(adapterB.getSnapshot().visible).toBe(true);
        expect(eventWindow.listeners).toHaveLength(1);
        const tearingDownB = frameB.teardown();
        dispatchOwned(childB, { type: 'teardown-complete', instanceId: 'frame-b' });
        await tearingDownB;
        expect(eventWindow.listeners).toHaveLength(0);
    });

    it('rejects stale instance messages and makes late events inert after teardown cleanup', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const mounted = adapter.mount(mountInput());
        eventWindow.dispatch({ source: child as unknown as MessageEventSource, origin: 'https://sandbox.paws.example', data: JSON.stringify({ type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' }) });
        eventWindow.dispatch({ source: child as unknown as MessageEventSource, origin: 'https://sandbox.paws.example', data: JSON.stringify({ type: 'sandbox-ready', instanceId: 'stale-frame' }) });

        await expect(mounted).rejects.toMatchObject({ code: 'MCP_APP_BRIDGE_PROTOCOL' });
        const posted = child.postMessage.mock.calls.length;
        eventWindow.dispatch({ source: child as unknown as MessageEventSource, origin: 'https://sandbox.paws.example', data: JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }) });
        expect(child.postMessage).toHaveBeenCalledTimes(posted);
        expect(eventWindow.listeners).toHaveLength(0);
    });

    it('removes the listener and frame after exact-origin graceful teardown', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const mounted = adapter.mount(mountInput());
        for (const data of [
            { type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' },
            { type: 'sandbox-ready', instanceId: 'frame-1' },
            { type: 'initialized', instanceId: 'frame-1' },
        ]) {
            eventWindow.dispatch({
                source: child as unknown as MessageEventSource,
                origin: 'https://sandbox.paws.example',
                data: JSON.stringify(data),
            });
        }
        const frame = await mounted;
        const tearingDown = frame.teardown();
        expect(JSON.parse(child.postMessage.mock.calls.at(-1)?.[0])).toEqual({
            type: 'teardown', instanceId: 'frame-1',
        });
        expect(child.postMessage.mock.calls.at(-1)?.[1]).toBe('https://sandbox.paws.example');
        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'teardown-complete', instanceId: 'frame-1' }),
        });
        await tearingDown;

        expect(adapter.getSnapshot().visible).toBe(false);
        expect(eventWindow.listeners).toHaveLength(0);
        const posted = child.postMessage.mock.calls.length;
        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example',
            data: JSON.stringify({ type: 'initialized', instanceId: 'frame-1' }),
        });
        expect(child.postMessage).toHaveBeenCalledTimes(posted);
    });

    it('routes a post-active wrong-origin event through the common failure callback', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
            createInstanceId: () => 'frame-1',
        });
        const child = { postMessage: vi.fn() };
        adapter.attachFrame({ contentWindow: child });
        const input = mountInput();
        const mounted = adapter.mount(input);
        for (const data of [
            { type: 'sandbox-proxy-ready', parentOrigin: 'https://paws.example' },
            { type: 'sandbox-ready', instanceId: 'frame-1' },
            { type: 'initialized', instanceId: 'frame-1' },
        ]) {
            eventWindow.dispatch({
                source: child as unknown as MessageEventSource,
                origin: 'https://sandbox.paws.example',
                data: JSON.stringify(data),
            });
        }
        await mounted;

        eventWindow.dispatch({
            source: child as unknown as MessageEventSource,
            origin: 'https://sandbox.paws.example.evil.test',
            data: JSON.stringify({ type: 'resize', instanceId: 'frame-1', height: 300 }),
        });

        expect(input.onFailure).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MCP_APP_BRIDGE_PROTOCOL', retryable: false,
        }));
        expect(adapter.getSnapshot().visible).toBe(false);
        expect(eventWindow.listeners).toHaveLength(0);
    });

    it('fails before navigation when CSP metadata is unsafe or exceeds the server limit', async () => {
        const eventWindow = new FakeWindow();
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow,
        });
        await expect(adapter.mount(mountInput({ resource: {
            ...resource,
            ui: { csp: { connectDomains: ['https://api.example/path'] } },
        } }))).rejects.toMatchObject({ code: 'MCP_APP_SANDBOX_UNAVAILABLE' });
        expect(adapter.getSnapshot().visible).toBe(false);

        await expect(adapter.mount(mountInput({ resource: {
            ...resource,
            ui: { csp: {
                connectDomains: Array.from({ length: 32 }, (_, index) => `https://${'a'.repeat(240)}-${index}.example`),
            } },
        } }))).rejects.toMatchObject({ code: 'MCP_APP_SANDBOX_UNAVAILABLE' });
        expect(MCP_APP_SANDBOX_MAX_CSP_BYTES).toBe(8 * 1024);
        expect(eventWindow.listeners).toHaveLength(0);
    });

    it.each([
        'https://api.example?mode=1',
        'https://api.example?',
        'https://api.example#section',
        'https://api.example#',
    ])('rejects raw CSP query or fragment delimiters before URL normalization: %s', async (domain) => {
        const adapter = new WebMcpAppFrameAdapter({
            config: { enabled: true, sandboxOrigin: 'https://sandbox.paws.example', appOrigin: 'https://paws.example' },
            eventWindow: new FakeWindow(),
        });
        await expect(adapter.mount(mountInput({ resource: {
            ...resource,
            ui: { csp: { connectDomains: [domain] } },
        } }))).rejects.toMatchObject({ code: 'MCP_APP_SANDBOX_UNAVAILABLE' });
        expect(adapter.getSnapshot().visible).toBe(false);
    });
});
