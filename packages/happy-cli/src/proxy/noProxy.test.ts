import { describe, expect, it } from 'vitest';
import { isLoopbackHost, matchesNoProxy, parseNoProxyList } from '@/proxy/noProxy';

describe('proxy bypass matching', () => {
    it('always bypasses loopback destinations', () => {
        expect(matchesNoProxy('127.0.0.1', '8788', [])).toBe(true);
        expect(matchesNoProxy('127.9.9.9', '80', [])).toBe(true);
        expect(matchesNoProxy('localhost', '80', [])).toBe(true);
        expect(matchesNoProxy('api.localhost', '80', [])).toBe(true);
        expect(matchesNoProxy('::1', '443', [])).toBe(true);
        expect(isLoopbackHost('1.2.3.4')).toBe(false);
        expect(matchesNoProxy('example.com', '443', [])).toBe(false);
    });

    it('matches exact hosts, hosts with ports, suffixes and wildcards', () => {
        expect(matchesNoProxy('api.cluster-fluster.com', '443', ['api.cluster-fluster.com'])).toBe(true);
        expect(matchesNoProxy('api.cluster-fluster.com', '443', ['.cluster-fluster.com'])).toBe(true);
        expect(matchesNoProxy('cluster-fluster.com', '443', ['.cluster-fluster.com'])).toBe(true);
        expect(matchesNoProxy('sub.cluster-fluster.com', '443', ['cluster-fluster.com'])).toBe(true);
        expect(matchesNoProxy('api.cluster-fluster.com', '443', ['api.cluster-fluster.com:8443'])).toBe(false);
        expect(matchesNoProxy('api.cluster-fluster.com', '8443', ['api.cluster-fluster.com:8443'])).toBe(true);
        expect(matchesNoProxy('anything.example', '80', ['*'])).toBe(true);
        expect(matchesNoProxy('internal.example', '80', ['<local>'])).toBe(true);
        expect(matchesNoProxy('external.test', '443', ['internal.test'])).toBe(false);
    });

    it('parses comma separated bypass lists', () => {
        expect(parseNoProxyList(' a.com, .b.com ,, c:8080 ')).toEqual(['a.com', '.b.com', 'c:8080']);
        expect(parseNoProxyList(undefined)).toEqual([]);
        expect(parseNoProxyList('')).toEqual([]);
    });
});
