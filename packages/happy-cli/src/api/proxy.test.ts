import { describe, expect, it } from 'vitest';
import { createProxyAgentFromEnv, getProxyUrlFromEnv, maskProxyUrl, shouldBypassProxy } from './proxy';

describe('proxy helpers', () => {
    it('selects HTTPS proxy variables first for secure targets', () => {
        expect(getProxyUrlFromEnv('wss://server.test', {
            HTTPS_PROXY: 'http://127.0.0.1:5901',
            HTTP_PROXY: 'http://127.0.0.1:5902',
        })).toBe('http://127.0.0.1:5901');
    });

    it('selects HTTP proxy variables first for plain targets', () => {
        expect(getProxyUrlFromEnv('ws://server.test', {
            HTTPS_PROXY: 'http://127.0.0.1:5901',
            HTTP_PROXY: 'http://127.0.0.1:5902',
        })).toBe('http://127.0.0.1:5902');
    });

    it('falls back to ALL_PROXY when scheme-specific proxy variables are unset', () => {
        expect(getProxyUrlFromEnv('wss://server.test', {
            ALL_PROXY: 'http://127.0.0.1:5903',
        })).toBe('http://127.0.0.1:5903');
    });

    it('returns undefined when no proxy environment variable is set', () => {
        expect(getProxyUrlFromEnv('wss://server.test', {})).toBeUndefined();
    });

    it('creates a proxy agent when a proxy URL is configured', () => {
        expect(createProxyAgentFromEnv('wss://server.test', {
            HTTPS_PROXY: 'http://127.0.0.1:5901',
        })).toBeDefined();
    });

    it('redacts proxy URL credentials', () => {
        const masked = maskProxyUrl('http://user:pass@127.0.0.1:5901');

        expect(masked).toContain('***');
        expect(masked).not.toContain('user');
        expect(masked).not.toContain('pass');
    });

    it('does not leak invalid proxy URLs', () => {
        expect(maskProxyUrl('http://user:pass@%')).toBe('<invalid proxy url>');
    });

    it('bypasses all targets when NO_PROXY is wildcard', () => {
        expect(shouldBypassProxy('wss://server.test', {
            NO_PROXY: '*',
        })).toBe(true);
    });

    it('bypasses exact hosts, host ports, and dot-prefixed domains', () => {
        const env = {
            NO_PROXY: 'localhost,server.test:443,.internal.test',
        };

        expect(shouldBypassProxy('ws://localhost:3005', env)).toBe(true);
        expect(shouldBypassProxy('wss://server.test:443', env)).toBe(true);
        expect(shouldBypassProxy('wss://api.internal.test', env)).toBe(true);
        expect(shouldBypassProxy('wss://external.test', env)).toBe(false);
    });

    it('does not create a proxy agent for NO_PROXY targets', () => {
        expect(createProxyAgentFromEnv('wss://server.test', {
            HTTPS_PROXY: 'http://127.0.0.1:5901',
            NO_PROXY: 'server.test',
        })).toBeUndefined();
    });
});
