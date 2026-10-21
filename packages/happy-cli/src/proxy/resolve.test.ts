import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSystemProxyCache, resolveProxyForUrl, resolveProxyForUrlSync } from '@/proxy/resolve';
import { DEFAULT_PROXY_CONFIG, type ProxyConfig } from '@/proxy/types';

const ENV_KEYS = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy',
] as const;

function config(overrides: Partial<ProxyConfig>): ProxyConfig {
    return { ...DEFAULT_PROXY_CONFIG, ...overrides };
}

describe('proxy resolution', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) {
            vi.stubEnv(key, '');
        }
        clearSystemProxyCache();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        clearSystemProxyCache();
    });

    it('never proxies when the mode is off', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
        expect(await resolveProxyForUrl('https://api.cluster-fluster.com', config({ mode: 'off' }))).toBeUndefined();
    });

    it('uses a configured manual proxy', async () => {
        const resolved = await resolveProxyForUrl('https://api.cluster-fluster.com', config({
            mode: 'manual',
            manual: { protocol: 'http', host: '127.0.0.1', port: 7890 },
        }));
        expect(resolved).toEqual({ url: 'http://127.0.0.1:7890', source: 'manual' });
    });

    it('supports every manual protocol', async () => {
        for (const protocol of ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const) {
            const resolved = await resolveProxyForUrl('https://example.com', config({
                mode: 'manual',
                manual: { protocol, host: 'proxy.local', port: 1080 },
            }));
            expect(resolved?.url).toBe(`${protocol}://proxy.local:1080`);
        }
    });

    it('returns the PAC script for mode pac and lets the agent decide per request', async () => {
        const resolved = await resolveProxyForUrl('https://example.com', config({
            mode: 'pac',
            pacUrl: 'http://wpad.example.com/proxy.pac',
        }));
        expect(resolved).toEqual({ url: 'http://wpad.example.com/proxy.pac', source: 'pac' });
    });

    it('reads the proxy environment variables in the historical order', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://secure-proxy:8080');
        vi.stubEnv('ALL_PROXY', 'socks5://all-proxy:1080');
        vi.stubEnv('HTTP_PROXY', 'http://plain-proxy:8080');

        expect((await resolveProxyForUrl('https://example.com', config({ mode: 'env' })))?.url)
            .toBe('http://secure-proxy:8080');
        expect((await resolveProxyForUrl('http://example.com', config({ mode: 'env' })))?.url)
            .toBe('http://plain-proxy:8080');
    });

    it('falls back to ALL_PROXY and honours lowercase variables', async () => {
        vi.stubEnv('all_proxy', 'socks5h://127.0.0.1:1080');
        const resolved = await resolveProxyForUrl('https://example.com', config({ mode: 'env' }));
        expect(resolved).toEqual({ url: 'socks5h://127.0.0.1:1080', source: 'env' });
    });

    it('never proxies loopback or NO_PROXY matches', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
        vi.stubEnv('NO_PROXY', 'internal.example,.corp.example');
        const mode = config({ mode: 'env' });

        expect(await resolveProxyForUrl('http://127.0.0.1:53485/list', mode)).toBeUndefined();
        expect(await resolveProxyForUrl('https://localhost:3005', mode)).toBeUndefined();
        expect(await resolveProxyForUrl('https://internal.example', mode)).toBeUndefined();
        expect(await resolveProxyForUrl('https://api.corp.example', mode)).toBeUndefined();
        expect((await resolveProxyForUrl('https://api.cluster-fluster.com', mode))?.url).toBe('http://127.0.0.1:7890');
    });

    it('honours the configured bypass list', async () => {
        const mode = config({
            mode: 'manual',
            manual: { protocol: 'http', host: '127.0.0.1', port: 7890 },
            noProxy: ['cluster-fluster.com'],
        });
        expect(await resolveProxyForUrl('https://api.cluster-fluster.com', mode)).toBeUndefined();
        expect((await resolveProxyForUrl('https://example.com', mode))?.source).toBe('manual');
    });

    it('resolves synchronously for the modes socket.io needs', () => {
        const manual = config({ mode: 'manual', manual: { protocol: 'socks5h', host: '127.0.0.1', port: 1080 } });
        expect(resolveProxyForUrlSync('https://api.cluster-fluster.com', manual)?.url).toBe('socks5h://127.0.0.1:1080');

        vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
        expect(resolveProxyForUrlSync('https://api.cluster-fluster.com', config({ mode: 'env' }))?.url).toBe('http://127.0.0.1:7890');
        expect(resolveProxyForUrlSync('https://api.cluster-fluster.com', config({ mode: 'off' }))).toBeUndefined();
    });
});
