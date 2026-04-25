import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_ENV_KEYS = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
] as const;

export type HappyProxyAgent = HttpsProxyAgent<string>;

export function getProxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (const key of PROXY_ENV_KEYS) {
        const value = env[key];
        if (value) {
            return value;
        }
    }

    return undefined;
}

export function createProxyAgentFromEnv(env: NodeJS.ProcessEnv = process.env): HappyProxyAgent | undefined {
    const proxyUrl = getProxyUrlFromEnv(env);
    if (!proxyUrl) {
        return undefined;
    }

    try {
        return new HttpsProxyAgent(proxyUrl);
    } catch {
        return undefined;
    }
}

export function maskProxyUrl(proxyUrl: string): string {
    try {
        const url = new URL(proxyUrl);
        if (url.username || url.password) {
            url.username = '***';
            url.password = '***';
        }
        return url.toString();
    } catch {
        return '<invalid proxy url>';
    }
}
