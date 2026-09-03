// @vitest-environment jsdom

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { App } from '@modelcontextprotocol/ext-apps';
import {
    EmptyResultSchema,
    ListPromptsResultSchema,
    ListResourceTemplatesResultSchema,
    ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
    MCP_APP_MAX_BRIDGE_MESSAGE_BYTES,
    MCP_APP_MAX_FRAME_HEIGHT,
    MCP_APP_MIN_FRAME_HEIGHT,
    createMcpAppMountCommands,
    createResizeEmitter,
    createSandboxedIframe,
    hostCommandSchema,
    nativeMessages,
    parseHostCommand,
    startHostShell,
} from '../../../../mcp-app-sandbox/hostShell';
import { MCP_APP_HOST_SHELL_HTML } from './generated/hostShellBundle';

const context = {
    theme: 'light' as const,
    locale: 'en',
    platform: 'android' as const,
    touch: true,
    hover: false,
    container: { width: 390, height: 640 },
    safeAreaInsets: { top: 24, right: 0, bottom: 16, left: 0 },
    displayMode: 'inline' as const,
};

describe('MCP App Host Shell protocol', () => {
    it('accepts only the reviewed native command variants and rejects generic eval', () => {
        const commands = [
            { type: 'mount', instanceId: 'frame-1', html: '<main>safe</main>', context },
            { type: 'tool-input', instanceId: 'frame-1', input: { city: 'Hangzhou' } },
            { type: 'tool-result', instanceId: 'frame-1', result: { content: [] } },
            { type: 'tool-cancelled', instanceId: 'frame-1', reason: 'Stopped' },
            { type: 'host-context', instanceId: 'frame-1', context },
            {
                type: 'bridge-response', instanceId: 'frame-1', requestId: 'request-1',
                response: { ok: true, value: {} },
            },
            {
                type: 'bridge-response', instanceId: 'frame-1', requestId: 'request-2',
                response: {
                    ok: false,
                    error: {
                        code: 'MCP_APP_PERMISSION_DENIED',
                        retryable: false,
                        summary: 'Permission was denied.',
                    },
                },
            },
            { type: 'teardown', instanceId: 'frame-1' },
        ];

        for (const command of commands) {
            expect(hostCommandSchema.safeParse(command).success).toBe(true);
        }
        expect(hostCommandSchema.safeParse({ type: 'eval', code: 'window.top.document' }).success).toBe(false);
        expect(hostCommandSchema.safeParse({ ...commands[1], nativeMethod: 'clipboard' }).success).toBe(false);
    });

    it('accepts only bounded shell events and tears down malformed or oversized input', () => {
        for (const message of [
            { type: 'sandbox-ready', instanceId: 'frame-1' },
            { type: 'initialized', instanceId: 'frame-1' },
            { type: 'resize', instanceId: 'frame-1', height: 320 },
            {
                type: 'bridge-request', instanceId: 'frame-1', requestId: 'request-1',
                request: { method: 'ping', params: {} },
            },
            { type: 'bridge-cancel', instanceId: 'frame-1', requestId: 'request-1' },
            { type: 'teardown-complete', instanceId: 'frame-1' },
            { type: 'protocol-error', instanceId: 'frame-1' },
        ]) {
            expect(nativeMessages.safeParse(message).success).toBe(true);
        }
        expect(nativeMessages.safeParse({ type: 'open-native', method: 'clipboard' }).success).toBe(false);
        expect(() => parseHostCommand('{broken-json')).toThrow();
        expect(() => parseHostCommand('x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES + 1))).toThrow();
    });

    it('creates one opaque-origin iframe with scripts as its only sandbox capability', () => {
        const iframe = createSandboxedIframe(document, '<button>View</button>');

        expect(iframe.getAttribute('sandbox')?.split(/\s+/)).toEqual(['allow-scripts']);
        expect(iframe.getAttribute('allow')).toBe("camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
        expect(iframe.srcdoc).toContain('<button>View</button>');
        expect(Object.keys(iframe.dataset)).toEqual([]);
    });

    it('reassembles a bounded multi-message mount before creating the opaque View', async () => {
        const posted: Array<{ type: string; instanceId: string }> = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = {
            postMessage: (value) => posted.push(JSON.parse(value)),
        };
        const stop = startHostShell(shellWindow);
        const html = `<main data-testid="large-view">${'界'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES)}</main>`;
        const commands = createMcpAppMountCommands('frame-large', html, context);

        expect(commands.map((command) => command.type)).toEqual([
            'mount-start', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-chunk', 'mount-complete',
        ]);
        for (const command of commands) {
            const raw = JSON.stringify(command);
            expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES);
            window.dispatchEvent(new MessageEvent('message', { data: raw, source: null }));
        }

        await vi.waitFor(() => expect(document.querySelector('iframe')?.srcdoc).toBe(html));
        expect(posted).toContainEqual({ type: 'sandbox-ready', instanceId: 'frame-large' });
        expect(posted).not.toContainEqual({ type: 'protocol-error', instanceId: 'frame-large' });

        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('fails closed on an out-of-order mount chunk', async () => {
        const posted: Array<{ type: string; instanceId: string }> = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = {
            postMessage: (value) => posted.push(JSON.parse(value)),
        };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            source: null,
            data: JSON.stringify({ type: 'mount-start', instanceId: 'frame-bad', byteLength: 1, context }),
        }));
        window.dispatchEvent(new MessageEvent('message', {
            source: null,
            data: JSON.stringify({ type: 'mount-chunk', instanceId: 'frame-bad', offset: 1, dataBase64: 'YQ==' }),
        }));

        await vi.waitFor(() => expect(posted).toContainEqual({
            type: 'protocol-error', instanceId: 'frame-bad',
        }));
        expect(document.querySelector('iframe')).toBeNull();

        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('coalesces resize events to one animation frame and clamps unsafe heights', () => {
        const callbacks: FrameRequestCallback[] = [];
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            callbacks.push(callback);
            return callbacks.length;
        });
        const emitted: number[] = [];
        const emit = createResizeEmitter((height) => emitted.push(height), requestFrame);

        emit(-10);
        emit(240);
        emit(Number.POSITIVE_INFINITY);
        emit(50_000);
        expect(requestFrame).toHaveBeenCalledTimes(1);
        expect(emitted).toEqual([]);

        callbacks[0](0);
        expect(emitted).toEqual([MCP_APP_MAX_FRAME_HEIGHT]);

        emit(0);
        callbacks[1](16);
        expect(emitted).toEqual([MCP_APP_MAX_FRAME_HEIGHT, MCP_APP_MIN_FRAME_HEIGHT]);
    });

    it('keeps native commands separate from a real official App initialize flow', async () => {
        const posted: Array<{ type: string; instanceId: string }> = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = {
            postMessage: (value) => posted.push(JSON.parse(value)),
        };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));

        const iframe = document.querySelector('iframe')!;
        expect(iframe).toBeTruthy();
        const target = iframe.contentWindow!;
        const viewTransport: any = {
            async start() {},
            async close() {},
            async send(message: unknown) {
                window.dispatchEvent(new MessageEvent('message', { data: message, source: target }));
            },
        };
        vi.spyOn(target, 'postMessage').mockImplementation((message: unknown) => {
            viewTransport.onmessage?.(message);
        });
        const app = new App({ name: 'Fixture View', version: '1.0.0' }, {}, { autoResize: false });
        await app.connect(viewTransport);

        expect(document.querySelector('iframe')).toBe(iframe);
        expect(posted.map((message) => message.type)).toEqual(['sandbox-ready', 'initialized']);
        expect(posted).not.toContainEqual({ type: 'protocol-error', instanceId: 'frame-1' });

        window.dispatchEvent(new MessageEvent('message', { data: '{malformed-native', source: null }));
        await vi.waitFor(() => expect(document.querySelector('iframe')).toBeNull());
        expect(posted.at(-1)).toEqual({ type: 'protocol-error', instanceId: 'frame-1' });

        await app.close();
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('relays official requests with correlation and returns stable success or error responses', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = {
            postMessage: (value) => {
                const message = JSON.parse(value);
                posted.push(message);
                if (message.type !== 'bridge-request') return;
                if (message.request.params?.name === 'late') return;
                const values: Record<string, unknown> = {
                    'resources/read': {
                        contents: [{ uri: 'ui://demo/detail', text: 'detail' }],
                    },
                    'tools/call': {
                        content: [{ type: 'text', text: 'done' }],
                    },
                    ping: {},
                    'ui/open-link': {},
                };
                queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
                    source: null,
                    data: JSON.stringify({
                        type: 'bridge-response',
                        instanceId: message.instanceId,
                        requestId: message.requestId,
                        response: message.request.params?.name === 'denied'
                            ? {
                                ok: false,
                                error: {
                                    code: 'MCP_APP_PERMISSION_DENIED',
                                    retryable: false,
                                    summary: 'Permission was denied.',
                                },
                            }
                            : { ok: true, value: values[message.request.method] },
                    }),
                })));
            },
        };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const target = ownedFrame.contentWindow!;
        const viewTransport: any = {
            async start() {},
            async close() {},
            async send(message: unknown) {
                window.dispatchEvent(new MessageEvent('message', { data: message, source: target }));
            },
        };
        vi.spyOn(target, 'postMessage').mockImplementation((message: unknown) => {
            viewTransport.onmessage?.(message);
        });
        const app = new App({ name: 'Fixture View', version: '1.0.0' }, {}, { autoResize: false });
        await app.connect(viewTransport);

        await expect(app.readServerResource({ uri: 'ui://demo/detail' })).resolves.toEqual({
            contents: [{ uri: 'ui://demo/detail', text: 'detail' }],
        });
        await expect(app.callServerTool({ name: 'refresh', arguments: { id: 1 } })).resolves.toEqual({
            content: [{ type: 'text', text: 'done' }],
        });
        await expect((app as any).request(
            { method: 'ping', params: {} },
            EmptyResultSchema,
        )).resolves.toEqual({});
        await expect(app.openLink({ url: 'https://example.com/path' })).resolves.toEqual({});
        await expect(app.callServerTool({
            name: 'denied', arguments: { secret: 'CANARY_ARGUMENT' },
        })).rejects.toMatchObject({
            data: expect.objectContaining({ code: 'MCP_APP_PERMISSION_DENIED' }),
        });

        const requests = posted.filter((message) => message.type === 'bridge-request');
        expect(requests.map((message) => message.request)).toEqual([
            { method: 'resources/read', params: { uri: 'ui://demo/detail' } },
            {
                method: 'tools/call',
                params: {
                    name: 'refresh',
                    arguments: { id: 1 },
                    _meta: { progressToken: expect.any(Number) },
                },
            },
            { method: 'ping', params: {} },
            { method: 'ui/open-link', params: { url: 'https://example.com/path' } },
            {
                method: 'tools/call',
                params: {
                    name: 'denied',
                    arguments: { secret: 'CANARY_ARGUMENT' },
                    _meta: { progressToken: expect.any(Number) },
                },
            },
        ]);
        expect(new Set(requests.map((message) => message.requestId)).size).toBe(requests.length);
        for (const request of requests) {
            expect(request).not.toHaveProperty('threadId');
            expect(request).not.toHaveProperty('server');
            expect(request).not.toHaveProperty('connectorId');
            expect(request).not.toHaveProperty('callId');
        }
        const logged = JSON.stringify([
            ...debug.mock.calls,
            ...warn.mock.calls,
            ...error.mock.calls,
        ]);
        expect(logged).not.toContain('CANARY_ARGUMENT');
        expect(logged).not.toContain('ui://demo/detail');
        expect(logged).not.toContain('Fixture View');

        const abortController = new AbortController();
        const late = app.callServerTool(
            { name: 'late' },
            { signal: abortController.signal },
        );
        await vi.waitFor(() => expect(posted.some((message) => (
            message.type === 'bridge-request' && message.request.params?.name === 'late'
        ))).toBe(true));
        const lateRequest = posted.find((message) => (
            message.type === 'bridge-request' && message.request.params?.name === 'late'
        ));
        abortController.abort();
        await expect(late).rejects.toBeTruthy();
        window.dispatchEvent(new MessageEvent('message', {
            source: null,
            data: JSON.stringify({
                type: 'bridge-response',
                instanceId: lateRequest.instanceId,
                requestId: lateRequest.requestId,
                response: { ok: true, value: { content: [] } },
            }),
        }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.querySelector('iframe')).toBeTruthy();
        expect(posted.at(-1)).not.toEqual({ type: 'protocol-error', instanceId: 'frame-1' });

        await app.close();
        stop();
        delete shellWindow.ReactNativeWebView;
        debug.mockRestore();
        warn.mockRestore();
        error.mockRestore();
    });

    it('returns method-not-found for unsupported fullscreen, download, model, sampling, prompt, list, and event methods', async () => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const target = ownedFrame.contentWindow!;
        const viewTransport: any = {
            async start() {}, async close() {},
            async send(message: unknown) {
                window.dispatchEvent(new MessageEvent('message', { data: message, source: target }));
            },
        };
        vi.spyOn(target, 'postMessage').mockImplementation((message: unknown) => viewTransport.onmessage?.(message));
        const app = new App({ name: 'Fixture View', version: '1.0.0' }, {}, { autoResize: false });
        await app.connect(viewTransport);

        const unsupported = [
            () => app.requestDisplayMode({ mode: 'fullscreen' }),
            () => app.requestDisplayMode({ mode: 'pip' }),
            () => app.downloadFile({ contents: [] }),
            () => app.updateModelContext({ structuredContent: { canary: true } }),
            () => app.createSamplingMessage({ messages: [], maxTokens: 1 }),
            () => app.listServerResources({}),
            () => app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
            () => (app as any).request({ method: 'tools/list', params: {} }, ListToolsResultSchema),
            () => (app as any).request(
                { method: 'resources/templates/list', params: {} },
                ListResourceTemplatesResultSchema,
            ),
            () => (app as any).request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema),
            () => (app as any).request(
                { method: 'ui/request-device-permission', params: { permission: 'camera' } },
                EmptyResultSchema,
            ),
            () => (app as any).request(
                { method: 'notifications/tools/list_changed', params: {} },
                EmptyResultSchema,
            ),
            () => (app as any).request(
                { method: 'ui/events/subscribe', params: { event: 'all' } },
                EmptyResultSchema,
            ),
        ];
        for (const request of unsupported) {
            await expect(request()).rejects.toMatchObject({ code: -32601 });
        }
        expect(posted.filter((message) => message.type === 'bridge-request')).toEqual([]);

        await app.close();
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it.each([
        ['oversized', {
            jsonrpc: '2.0', id: 1, method: 'ui/request-display-mode',
            params: { mode: 'fullscreen', padding: 'x'.repeat(MCP_APP_MAX_BRIDGE_MESSAGE_BYTES) },
        }],
        ['unknown-field', {
            jsonrpc: '2.0', id: 1, method: 'ui/request-display-mode',
            params: { mode: 'fullscreen' }, nativeMethod: 'clipboard',
        }],
    ])('revokes raw %s official ingress before the SDK transport consumes it', async (_case, envelope) => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const target = ownedFrame.contentWindow!;
        await Promise.resolve();

        window.dispatchEvent(new MessageEvent('message', { data: envelope, source: target }));

        await vi.waitFor(() => expect(ownedFrame.isConnected).toBe(false));
        expect(posted.at(-1)).toEqual({ type: 'protocol-error', instanceId: 'frame-1' });
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('does not charge notifications but revokes the thirty-first raw View request attempt', async () => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const target = ownedFrame.contentWindow!;
        await Promise.resolve();

        for (let index = 0; index < 40; index += 1) {
            window.dispatchEvent(new MessageEvent('message', {
                source: target,
                data: {
                    jsonrpc: '2.0', method: 'ui/notifications/size-changed',
                    params: { width: 390, height: 200 + index },
                },
            }));
        }
        for (let id = 1; id <= 30; id += 1) {
            window.dispatchEvent(new MessageEvent('message', {
                source: target,
                data: {
                    jsonrpc: '2.0', id, method: 'ui/request-display-mode',
                    params: { mode: 'fullscreen' },
                },
            }));
        }
        expect(document.querySelector('iframe')).toBeTruthy();

        window.dispatchEvent(new MessageEvent('message', {
            source: target,
            data: {
                jsonrpc: '2.0', id: 31, method: 'ui/request-display-mode',
                params: { mode: 'fullscreen' },
            },
        }));

        await vi.waitFor(() => expect(ownedFrame.isConnected).toBe(false));
        expect(posted.at(-1)).toEqual({ type: 'protocol-error', instanceId: 'frame-1' });
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('ignores a nested frame that forges a correlated native response', async () => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const target = ownedFrame.contentWindow!;
        await Promise.resolve();
        window.dispatchEvent(new MessageEvent('message', {
            source: target,
            data: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'late' } },
        }));
        await vi.waitFor(() => expect(posted.some((message) => message.type === 'bridge-request')).toBe(true));
        const pending = posted.find((message) => message.type === 'bridge-request');
        const foreignFrame = document.createElement('iframe');
        document.body.appendChild(foreignFrame);

        window.dispatchEvent(new MessageEvent('message', {
            source: foreignFrame.contentWindow,
            data: JSON.stringify({
                type: 'bridge-response', instanceId: 'frame-1', requestId: pending.requestId,
                response: { ok: true, value: { content: [] } },
            }),
        }));

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(ownedFrame.isConnected).toBe(true);
        expect(posted.filter((message) => message.type === 'bridge-request')).toHaveLength(1);
        expect(posted.some((message) => message.type === 'protocol-error')).toBe(false);
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('ignores a nested frame that forges native teardown', async () => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const foreignFrame = document.createElement('iframe');
        document.body.appendChild(foreignFrame);

        window.dispatchEvent(new MessageEvent('message', {
            source: foreignFrame.contentWindow,
            data: JSON.stringify({ type: 'teardown', instanceId: 'frame-1' }),
        }));

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(ownedFrame.isConnected).toBe(true);
        expect(posted.some((message) => message.type === 'protocol-error')).toBe(false);
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it.each([
        ['ordinary numeric', 7],
        ['zero', 0],
        ['empty string', ''],
    ])('propagates an official %s request ID cancellation exactly once', async (_case, requestId) => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const target = document.querySelector('iframe')!.contentWindow!;
        await Promise.resolve();
        window.dispatchEvent(new MessageEvent('message', {
            source: target,
            data: { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'late' } },
        }));
        await vi.waitFor(() => expect(posted.some((message) => message.type === 'bridge-request')).toBe(true));
        const pending = posted.find((message) => message.type === 'bridge-request');

        window.dispatchEvent(new MessageEvent('message', {
            source: target,
            data: {
                jsonrpc: '2.0', method: 'notifications/cancelled',
                params: { requestId, reason: 'View disposed' },
            },
        }));

        await vi.waitFor(() => expect(posted).toContainEqual({
            type: 'bridge-cancel', instanceId: 'frame-1', requestId: pending.requestId,
        }));
        window.dispatchEvent(new MessageEvent('message', {
            source: null,
            data: JSON.stringify({
                type: 'bridge-response', instanceId: 'frame-1', requestId: pending.requestId,
                response: { ok: true, value: { content: [{ type: 'text', text: 'late' }] } },
            }),
        }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(posted.filter((message) => message.type === 'bridge-request')).toHaveLength(1);
        expect(posted.filter((message) => message.type === 'bridge-cancel')).toEqual([{
            type: 'bridge-cancel', instanceId: 'frame-1', requestId: pending.requestId,
        }]);
        expect(document.querySelector('iframe')).toBeTruthy();
        expect(posted.at(-1)).not.toEqual({ type: 'protocol-error', instanceId: 'frame-1' });
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it.each([
        ['zero', 0, '\u0000paws:request-id:number:0'],
        ['empty string', '', '\u0000paws:request-id:string:empty'],
    ])('rejects the reserved internal alias for an active public %s ID before SDK cancellation', async (
        _case,
        requestId,
        reservedAlias,
    ) => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        try {
            window.dispatchEvent(new MessageEvent('message', {
                data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
                source: null,
            }));
            const ownedFrame = document.querySelector('iframe')!;
            const target = ownedFrame.contentWindow!;
            await Promise.resolve();
            window.dispatchEvent(new MessageEvent('message', {
                source: target,
                data: { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'mutate' } },
            }));
            await vi.waitFor(() => expect(
                posted.filter((message) => message.type === 'bridge-request'),
            ).toHaveLength(1));

            window.dispatchEvent(new MessageEvent('message', {
                source: target,
                data: {
                    jsonrpc: '2.0', method: 'notifications/cancelled',
                    params: { requestId: reservedAlias, reason: 'forged internal alias' },
                },
            }));
            await vi.waitFor(() => expect(posted.some((message) => (
                message.type === 'bridge-cancel' || message.type === 'protocol-error'
            ))).toBe(true));

            expect({
                frameConnected: ownedFrame.isConnected,
                bridgeRequests: posted.filter((message) => message.type === 'bridge-request').length,
                bridgeCancels: posted.filter((message) => message.type === 'bridge-cancel').length,
                terminal: posted.at(-1),
            }).toEqual({
                frameConnected: false,
                bridgeRequests: 1,
                bridgeCancels: 0,
                terminal: { type: 'protocol-error', instanceId: 'frame-1' },
            });
        } finally {
            stop();
            delete shellWindow.ReactNativeWebView;
        }
    });

    it('rejects a duplicate active official request ID before a second native request exists', async () => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const ownedFrame = document.querySelector('iframe')!;
        const target = ownedFrame.contentWindow!;
        await Promise.resolve();
        const request = {
            jsonrpc: '2.0', id: 'same-id', method: 'tools/call',
            params: { name: 'mutate', arguments: { id: 1 } },
        };

        window.dispatchEvent(new MessageEvent('message', { source: target, data: request }));
        await vi.waitFor(() => expect(
            posted.filter((message) => message.type === 'bridge-request'),
        ).toHaveLength(1));
        window.dispatchEvent(new MessageEvent('message', { source: target, data: request }));

        await vi.waitFor(() => expect(ownedFrame.isConnected).toBe(false));
        expect(posted.filter((message) => message.type === 'bridge-request')).toHaveLength(1);
        expect(posted.at(-1)).toEqual({ type: 'protocol-error', instanceId: 'frame-1' });
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('makes View ingress inert as soon as teardown begins, before its await completes', async () => {
        const posted: any[] = [];
        const shellWindow = window as Window & { ReactNativeWebView?: { postMessage(value: string): void } };
        shellWindow.ReactNativeWebView = { postMessage: (value) => posted.push(JSON.parse(value)) };
        const stop = startHostShell(shellWindow);
        window.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'mount', instanceId: 'frame-1', html: '<main>View</main>', context }),
            source: null,
        }));
        const target = document.querySelector('iframe')!.contentWindow!;
        await Promise.resolve();

        window.dispatchEvent(new MessageEvent('message', {
            source: null,
            data: JSON.stringify({ type: 'teardown', instanceId: 'frame-1' }),
        }));
        window.dispatchEvent(new MessageEvent('message', {
            source: target,
            data: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'during-close' } },
        }));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(posted.some((message) => (
            message.type === 'bridge-request' && message.request.params?.name === 'during-close'
        ))).toBe(false);
        stop();
        delete shellWindow.ReactNativeWebView;
    });

    it('commits the deterministic minified IIFE generated from the official AppBridge entry', () => {
        expect(MCP_APP_HOST_SHELL_HTML).toContain('<!doctype html>');
        expect(MCP_APP_HOST_SHELL_HTML).not.toMatch(/\bimport\s|sourceMappingURL/);
        expect(MCP_APP_HOST_SHELL_HTML.length).toBeGreaterThan(1_000);

        execFileSync(process.execPath, [
            resolve(process.cwd(), 'scripts/build-mcp-app-host-shell.cjs'),
            '--check',
        ], { cwd: process.cwd(), stdio: 'pipe' });
    });
});
