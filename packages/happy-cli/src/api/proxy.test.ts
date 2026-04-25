import { describe, expect, it } from 'vitest';
import { createProxyAgentFromEnv, getProxyUrlFromEnv, maskProxyUrl } from './proxy';

describe('proxy helpers', () => {
    it('falls back through standard proxy environment variables in order', () => {
        const ordered = [
            'HTTPS_PROXY',
            'https_proxy',
            'HTTP_PROXY',
            'http_proxy',
            'ALL_PROXY',
            'all_proxy',
        ] as const;

        for (const [index, key] of ordered.entries()) {
            expect(getProxyUrlFromEnv({
                [key]: `http://127.0.0.1:${5901 + index}`,
            })).toBe(`http://127.0.0.1:${5901 + index}`);
        }
    });

    it('returns undefined when no proxy environment variable is set', () => {
        expect(getProxyUrlFromEnv({})).toBeUndefined();
    });

    it('creates a proxy agent when a proxy URL is configured', () => {
        expect(createProxyAgentFromEnv({
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
});
