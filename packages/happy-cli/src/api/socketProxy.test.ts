import { describe, expect, it } from 'vitest';
import { noProxyMatches, proxyForSocketUrl, socketProxyOptions } from './socketProxy';

describe('socket proxy options', () => {
    it('uses HTTPS_PROXY for secure websocket URLs', () => {
        const env = {
            HTTPS_PROXY: 'http://127.0.0.1:7897',
            HTTP_PROXY: 'http://127.0.0.1:8080',
        };

        expect(proxyForSocketUrl('wss://api.cluster-fluster.com', env)).toBe('http://127.0.0.1:7897');
    });

    it('falls back to HTTP_PROXY for secure websocket URLs', () => {
        const env = {
            HTTP_PROXY: 'http://127.0.0.1:8080',
        };

        expect(proxyForSocketUrl('wss://api.cluster-fluster.com', env)).toBe('http://127.0.0.1:8080');
    });

    it('skips proxy when NO_PROXY matches the host', () => {
        const env = {
            HTTPS_PROXY: 'http://127.0.0.1:7897',
            NO_PROXY: 'localhost,api.cluster-fluster.com',
        };

        expect(proxyForSocketUrl('wss://api.cluster-fluster.com', env)).toBeNull();
    });

    it('matches common NO_PROXY wildcard forms', () => {
        expect(noProxyMatches('api.cluster-fluster.com', '*.cluster-fluster.com')).toBe(true);
        expect(noProxyMatches('api.cluster-fluster.com', '.cluster-fluster.com')).toBe(true);
        expect(noProxyMatches('172.31.12.1', '172.31.*')).toBe(true);
        expect(noProxyMatches('::1', '::1')).toBe(true);
    });

    it('returns socket.io transport options when a proxy is configured', () => {
        const options = socketProxyOptions('wss://api.cluster-fluster.com', {
            HTTPS_PROXY: 'http://127.0.0.1:7897',
        });

        expect(options).toHaveProperty('agent');
        expect(options).toHaveProperty('transportOptions.websocket.agent');
    });
});
