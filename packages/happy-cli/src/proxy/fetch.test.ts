import { afterEach, describe, expect, it } from 'vitest';
import { applyProxyConfig } from '@/proxy';
import { uninstallProxiedFetch } from '@/proxy/fetch';
import { DEFAULT_PROXY_CONFIG } from '@/proxy/types';
import {
    localExternalAddress,
    proxyParts,
    startTargetServer,
    startTestProxy,
    type TestProxy,
} from '@/proxy/testing/testProxy';

const externalAddress = localExternalAddress();

describe.skipIf(!externalAddress)('proxy aware fetch', () => {
    const cleanups: Array<() => Promise<void>> = [];
    let proxy: TestProxy | undefined;

    afterEach(async () => {
        await applyProxyConfig({ ...DEFAULT_PROXY_CONFIG, mode: 'off', useForChildProcesses: false });
        uninstallProxiedFetch();
        while (cleanups.length > 0) {
            await cleanups.pop()?.();
        }
        proxy = undefined;
    });

    async function useProxy(proxyUrl: string, noProxy: string[] = []): Promise<void> {
        const { host, port } = proxyParts(proxyUrl);
        await applyProxyConfig({
            mode: 'manual',
            manual: { protocol: 'http', host, port },
            noProxy,
            useForChildProcesses: false,
        });
    }

    it('sends HTTP requests through the configured proxy', async () => {
        const target = await startTargetServer(externalAddress!);
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useProxy(proxy.url);

        const response = await fetch(`${target.url}/hello`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        await expect(response.json()).resolves.toMatchObject({ ok: true, path: '/hello' });
        expect(proxy.requests.map((entry) => entry.target)).toContain(`${target.url}/hello`);
    });

    it('posts bodies through the proxy', async () => {
        const target = await startTargetServer(externalAddress!);
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useProxy(proxy.url);

        const response = await fetch(`${target.url}/submit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hello: 'world' }),
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ method: 'POST', path: '/submit' });
        expect(proxy.requests).toHaveLength(1);
    });

    it('goes direct when the proxy mode is off', async () => {
        const target = await startTargetServer(externalAddress!);
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await applyProxyConfig({ ...DEFAULT_PROXY_CONFIG, mode: 'off', useForChildProcesses: false });

        const response = await fetch(`${target.url}/direct`);
        expect(response.status).toBe(200);
        expect(proxy.requests).toHaveLength(0);
    });

    it('keeps loopback destinations direct even with a proxy configured', async () => {
        const target = await startTargetServer('127.0.0.1');
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useProxy(proxy.url);

        const response = await fetch(`${target.url}/local`);
        expect(response.status).toBe(200);
        expect(proxy.requests).toHaveLength(0);
    });

    it('honours the configured bypass list', async () => {
        const target = await startTargetServer(externalAddress!);
        cleanups.push(target.close);
        proxy = await startTestProxy();
        cleanups.push(proxy.close);
        await useProxy(proxy.url, [externalAddress!]);

        const response = await fetch(`${target.url}/bypassed`);
        expect(response.status).toBe(200);
        expect(proxy.requests).toHaveLength(0);
    });
});
