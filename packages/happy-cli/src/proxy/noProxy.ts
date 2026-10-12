/**
 * Bypass matching for proxy decisions.
 *
 * Implements the NO_PROXY grammar used by curl and proxy-from-env (exact host,
 * host with port, `.suffix`, bare suffix, `*`) and treats every loopback
 * destination as bypassed, because Happy always talks to a local daemon, local
 * MCP servers and local sandbox proxies on 127.0.0.1 / ::1.
 */
import { isIP } from 'node:net';

/** Splits a NO_PROXY style string ("a.com, .b.com:8443") into patterns. */
export function parseNoProxyList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** True for localhost, 127.0.0.0/8, ::1 and other loopback spellings. */
export function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
        return true;
    }
    if (isIP(host) === 4) {
        return host.startsWith('127.');
    }
    return false;
}

/** True when the destination matches any pattern in the bypass list. */
export function matchesNoProxy(hostname: string, port: string, patterns: readonly string[]): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopbackHost(host)) {
        return true;
    }

    for (const rawPattern of patterns) {
        const pattern = rawPattern.toLowerCase();
        if (pattern === '*') {
            return true;
        }
        // "<local>" and "<-loopback>" are Windows proxy-override spellings.
        if (pattern === '<local>' || pattern === '<-loopback>') {
            return true;
        }

        const separator = pattern.lastIndexOf(':');
        const hasPort = separator > 0 && /^\d+$/.test(pattern.slice(separator + 1));
        const patternHost = hasPort ? pattern.slice(0, separator) : pattern;
        const patternPort = hasPort ? pattern.slice(separator + 1) : undefined;

        if (patternPort && patternPort !== port) {
            continue;
        }
        if (patternHost.startsWith('.')) {
            const domain = patternHost.slice(1);
            if (host === domain || host.endsWith(patternHost)) {
                return true;
            }
            continue;
        }
        if (host === patternHost || host.endsWith(`.${patternHost}`)) {
            return true;
        }
    }

    return false;
}
