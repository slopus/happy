import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROXY_CONFIG,
    ProxyConfigSchema,
    buildProxyUrl,
    maskProxyUrl,
} from '@/proxy/types';

describe('proxy configuration schema', () => {
    it('defaults to the proxy environment variables', () => {
        expect(DEFAULT_PROXY_CONFIG).toEqual({
            mode: 'env',
            manual: undefined,
            pacUrl: undefined,
            noProxy: [],
            useForChildProcesses: true,
        });
    });

    it('accepts every mode and both protocol families', () => {
        for (const mode of ['off', 'env', 'system', 'pac', 'manual'] as const) {
            expect(ProxyConfigSchema.parse({ mode }).mode).toBe(mode);
        }
        for (const protocol of ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const) {
            const parsed = ProxyConfigSchema.parse({ mode: 'manual', manual: { protocol, host: 'h', port: 1080 } });
            expect(parsed.manual?.protocol).toBe(protocol);
        }
    });

    it('rejects invalid manual proxies', () => {
        expect(ProxyConfigSchema.safeParse({ mode: 'manual', manual: { host: '', port: 0 } }).success).toBe(false);
        expect(ProxyConfigSchema.safeParse({ mode: 'manual', manual: { host: 'h', port: 70000 } }).success).toBe(false);
        expect(ProxyConfigSchema.safeParse({ mode: 'nope' }).success).toBe(false);
    });

    it('builds proxy URLs with encoded credentials', () => {
        expect(buildProxyUrl({ protocol: 'http', host: '127.0.0.1', port: 7890 })).toBe('http://127.0.0.1:7890');
        expect(buildProxyUrl({ protocol: 'socks5h', host: 'proxy', port: 1080, username: 'u ser', password: 'p@ss' }))
            .toBe('socks5h://u%20ser:p%40ss@proxy:1080');
    });

    it('never leaks proxy credentials when masking', () => {
        const masked = maskProxyUrl('http://user:secret@127.0.0.1:7890');
        expect(masked).not.toContain('secret');
        expect(masked).not.toContain('user');
        expect(maskProxyUrl('not a url')).toBe('<invalid proxy url>');
    });
});
