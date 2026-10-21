import { describe, expect, it } from 'vitest';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { PacProxyAgent } from 'pac-proxy-agent';
import { clearProxyAgentCache, createPacProxyAgent, createProxyAgent } from '@/proxy/agents';

describe('proxy agents', () => {
    it('uses CONNECT for secure destinations and absolute-form for plain ones', () => {
        expect(createProxyAgent('http://127.0.0.1:7890', 'https://api.cluster-fluster.com'))
            .toBeInstanceOf(HttpsProxyAgent);
        expect(createProxyAgent('http://127.0.0.1:7890', 'wss://api.cluster-fluster.com'))
            .toBeInstanceOf(HttpsProxyAgent);
        expect(createProxyAgent('http://127.0.0.1:7890', 'http://example.com'))
            .toBeInstanceOf(HttpProxyAgent);
    });

    it('supports SOCKS4, SOCKS5 and their remote DNS variants', () => {
        for (const protocol of ['socks4', 'socks4a', 'socks5', 'socks5h']) {
            expect(createProxyAgent(`${protocol}://127.0.0.1:1080`, 'https://example.com'))
                .toBeInstanceOf(SocksProxyAgent);
        }
    });

    it('reuses agents so connection pools stay intact', () => {
        const first = createProxyAgent('http://127.0.0.1:7890', 'https://example.com');
        const second = createProxyAgent('http://127.0.0.1:7890', 'https://example.com');
        expect(second).toBe(first);

        clearProxyAgentCache();
        expect(createProxyAgent('http://127.0.0.1:7890', 'https://example.com')).not.toBe(first);
    });

    it('rejects proxies it cannot use', () => {
        expect(createProxyAgent('ftp://127.0.0.1:21', 'https://example.com')).toBeUndefined();
        expect(createProxyAgent('nonsense', 'https://example.com')).toBeUndefined();
        expect(createProxyAgent('http://127.0.0.1:7890', 'not a url')).toBeUndefined();
    });

    it('builds one PAC agent per PAC script', () => {
        const agent = createPacProxyAgent('http://wpad.example.com/proxy.pac');
        expect(agent).toBeInstanceOf(PacProxyAgent);
        expect(createPacProxyAgent('pac+http://wpad.example.com/proxy.pac')).toBe(agent);
    });
});
