import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HttpsProxyAgent } = require('https-proxy-agent') as typeof import('https-proxy-agent');

function normalizeHostname(hostname: string): string {
    return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function stripPort(pattern: string): string {
    if (pattern.startsWith('[')) {
        const end = pattern.indexOf(']');
        return end > 0 ? pattern.slice(1, end) : pattern;
    }

    const colon = pattern.lastIndexOf(':');
    if (colon > 0 && pattern.indexOf(':') === colon && /^\d+$/.test(pattern.slice(colon + 1))) {
        return pattern.slice(0, colon);
    }

    return pattern;
}

export function noProxyMatches(hostname: string, noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ''): boolean {
    const host = normalizeHostname(hostname);

    return noProxy
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
        .some((entry) => {
            if (entry === '*') return true;

            const pattern = stripPort(entry);
            if (!pattern) return false;
            if (pattern.endsWith('*')) return host.startsWith(pattern.slice(0, -1));
            if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
            if (pattern.startsWith('.')) return host.endsWith(pattern);

            return host === pattern || host.endsWith(`.${pattern}`);
        });
}

export function proxyForSocketUrl(serverUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
    try {
        const parsed = new URL(serverUrl);
        if (noProxyMatches(parsed.hostname, env.NO_PROXY ?? env.no_proxy ?? '')) return null;

        if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
            return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? null;
        }

        return env.HTTP_PROXY ?? env.http_proxy ?? null;
    } catch {
        return null;
    }
}

export function socketProxyOptions(serverUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
    const proxyUrl = proxyForSocketUrl(serverUrl, env);
    if (!proxyUrl) return {};

    const agent = new HttpsProxyAgent(proxyUrl);
    return {
        agent,
        transportOptions: {
            websocket: { agent },
        },
    };
}
