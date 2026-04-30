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

function getProxyEnvKeys(targetUrl?: string): readonly typeof PROXY_ENV_KEYS[number][] {
    if (!targetUrl) {
        return PROXY_ENV_KEYS;
    }

    try {
        const url = new URL(targetUrl);
        if (url.protocol === 'http:' || url.protocol === 'ws:') {
            return ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
        }
        if (url.protocol === 'https:' || url.protocol === 'wss:') {
            return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
        }
    } catch {
        // Fall back to the default proxy env order when the target is not parseable.
    }

    return PROXY_ENV_KEYS;
}

export function shouldBypassProxy(targetUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const noProxy = env.NO_PROXY ?? env.no_proxy;
    if (!noProxy) {
        return false;
    }

    const patterns = noProxy.split(',').map((pattern) => pattern.trim().toLowerCase()).filter(Boolean);
    if (patterns.includes('*')) {
        return true;
    }

    try {
        const url = new URL(targetUrl);
        const hostname = url.hostname.toLowerCase();
        let port = url.port;
        if (!port && (url.protocol === 'https:' || url.protocol === 'wss:')) {
            port = '443';
        } else if (!port && (url.protocol === 'http:' || url.protocol === 'ws:')) {
            port = '80';
        }
        const hostWithPort = port ? `${hostname}:${port}` : hostname;

        return patterns.some((pattern) => {
            if (pattern === hostWithPort || pattern === hostname) {
                return true;
            }
            if (pattern.startsWith('.')) {
                const domain = pattern.slice(1);
                return hostname === domain || hostname.endsWith(pattern);
            }
            return hostname.endsWith(`.${pattern}`);
        });
    } catch {
        return false;
    }
}

export function getProxyUrlFromEnv(targetUrl?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (targetUrl && shouldBypassProxy(targetUrl, env)) {
        return undefined;
    }

    for (const key of getProxyEnvKeys(targetUrl)) {
        const value = env[key];
        if (value) {
            return value;
        }
    }

    return undefined;
}

export function createProxyAgentFromEnv(targetUrl?: string, env: NodeJS.ProcessEnv = process.env): HappyProxyAgent | undefined {
    const proxyUrl = getProxyUrlFromEnv(targetUrl, env);
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
