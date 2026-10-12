import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { applyProxyConfig, createSocketProxyOptions } from '@/proxy';
import { DEFAULT_PROXY_CONFIG } from '@/proxy/types';
import {
    localExternalAddress,
    proxyParts,
    startTestProxy,
    type TestProxy,
} from '@/proxy/testing/testProxy';

const externalAddress = localExternalAddress();

async function startEchoServer(host: string): Promise<{ url: string; close(): Promise<void> }> {
    const server = new WebSocketServer({ host, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => {
        socket.on('message', (data) => socket.send(`pong:${String(data)}`));
    });
    const address = server.address() as AddressInfo;
    return {
        url: `ws://${host}:${address.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

function roundTrip(url: string, agent?: import('node:http').Agent): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, agent ? { agent } : undefined);
        socket.on('open', () => socket.send('ping'));
        socket.on('message', (data) => {
            socket.close();
            resolve(String(data));
        });
        socket.on('error', reject);
    });
}

describe.skipIf(!externalAddress)('relay websocket proxying', () => {
    const cleanups: Array<() => Promise<void>> = [];
    let proxy: TestProxy | undefined;

    afterEach(async () => {
        await applyProxyConfig({ ...DEFAULT_PROXY_CONFIG, mode: 'off', useForChildProcesses: false });
        while (cleanups.length > 0) {
            await cleanups.pop()?.();
        }
        proxy = undefined;
    });

    async function useManualProxy(proxyUrl: string): Promise<void> {
        const { host, port } = proxyParts(proxyUrl);
        await applyProxyConfig({
            mode: 'manual',
            manual: { protocol: 'http', host, port },
            noProxy: [],
            useForChildProcesses: false,
        });
    }

    it('hands socket.io a websocket agent for the relay connection', async () => {
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useManualProxy(proxy.url);

        const options = createSocketProxyOptions('https://api.cluster-fluster.com');
        expect(options.transportOptions?.websocket.agent).toBeDefined();

        await applyProxyConfig({ ...DEFAULT_PROXY_CONFIG, mode: 'off', useForChildProcesses: false });
        expect(createSocketProxyOptions('https://api.cluster-fluster.com').transportOptions).toBeUndefined();
    });

    it('connects a websocket through the configured proxy', async () => {
        const target = await startEchoServer(externalAddress!);
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useManualProxy(proxy.url);

        const agent = createSocketProxyOptions(target.url).transportOptions?.websocket.agent;
        expect(agent).toBeDefined();
        await expect(roundTrip(target.url, agent)).resolves.toBe('pong:ping');
        // The proxy sees the relay as an absolute-form upgrade to the relay host.
        const targetHost = new URL(target.url).host;
        expect(proxy.requests.some((entry) => entry.kind === 'upgrade' && entry.target.includes(targetHost))).toBe(true);
    });

    it('connects a websocket directly when no proxy is configured', async () => {
        const target = await startEchoServer(externalAddress!);
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await applyProxyConfig({ ...DEFAULT_PROXY_CONFIG, mode: 'off', useForChildProcesses: false });

        const options = createSocketProxyOptions(target.url);
        expect(options.transportOptions).toBeUndefined();
        await expect(roundTrip(target.url)).resolves.toBe('pong:ping');
        expect(proxy.requests).toHaveLength(0);
    });

    it('bypasses the proxy for loopback websocket destinations', async () => {
        const target = await startEchoServer('127.0.0.1');
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useManualProxy(proxy.url);

        const options = createSocketProxyOptions(target.url);
        expect(options.transportOptions).toBeUndefined();
        await expect(roundTrip(target.url)).resolves.toBe('pong:ping');
        expect(proxy.requests).toHaveLength(0);
    });
});
