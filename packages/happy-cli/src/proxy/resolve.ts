/**
 * Proxy decision engine.
 *
 * Decides, for one destination URL, which proxy (if any) Happy must use. The
 * decision follows the configured mode:
 *
 *   off      nothing is ever proxied
 *   env      HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (and lowercase variants)
 *   system   the OS proxy settings, falling back to the environment
 *   pac      the configured PAC script, resolved per destination
 *   manual   the configured proxy endpoint
 *
 * Loopback destinations and NO_PROXY matches are always used directly, because
 * Happy talks to its own daemon, local MCP servers and sandbox proxies locally.
 */
import type { Agent } from 'node:http';
import { createPacProxyAgent, createProxyAgent } from '@/proxy/agents';
import { matchesNoProxy, parseNoProxyList } from '@/proxy/noProxy';
import { detectSystemProxy, type SystemProxySettings } from '@/proxy/system';
import {
    buildProxyUrl,
    type ProxyConfig,
    type ResolvedProxy,
} from '@/proxy/types';

const SYSTEM_PROXY_CACHE_MS = 30_000;

let systemProxyCache: { settings: SystemProxySettings; at: number } | undefined;

/** Reads (and briefly caches) the OS proxy settings. */
export async function getSystemProxySettings(): Promise<SystemProxySettings> {
    const now = Date.now();
    if (systemProxyCache && now - systemProxyCache.at < SYSTEM_PROXY_CACHE_MS) {
        return systemProxyCache.settings;
    }
    const settings = await detectSystemProxy();
    systemProxyCache = { settings, at: now };
    return settings;
}

/** Clears the OS proxy cache, used when the configuration changes. */
export function clearSystemProxyCache(): void {
    systemProxyCache = undefined;
}

function proxyFromEnvironment(target: URL): ResolvedProxy | undefined {
    const env = process.env;
    const secure = target.protocol === 'https:' || target.protocol === 'wss:';
    const keys = secure
        ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
        : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy'];

    for (const key of keys) {
        const value = env[key]?.trim();
        if (value) {
            return { url: value, source: 'env' };
        }
    }
    return undefined;
}

function proxyFromSystemSettings(target: URL, settings: SystemProxySettings): ResolvedProxy | undefined {
    const secure = target.protocol === 'https:' || target.protocol === 'wss:';
    const url = (secure ? settings.httpsProxy ?? settings.httpProxy : settings.httpProxy ?? settings.httpsProxy)
        ?? settings.socksProxy;
    return url ? { url, source: 'system' } : undefined;
}

function bypassedPatterns(config: ProxyConfig, systemExceptions: readonly string[]): string[] {
    return [
        ...config.noProxy,
        ...parseNoProxyList(process.env.NO_PROXY ?? process.env.no_proxy),
        ...systemExceptions,
    ];
}

/**
 * Resolves the proxy for a destination.
 *
 * `config` defaults to `env` mode on purpose: Happy has always honoured the
 * standard proxy variables for its HTTP calls, and the proxy section only
 * changes where the proxy comes from.
 */
export async function resolveProxyForUrl(
    targetUrl: string,
    config: ProxyConfig,
): Promise<ResolvedProxy | undefined> {
    let target: URL;
    try {
        target = new URL(targetUrl);
    } catch {
        return undefined;
    }

    if (config.mode === 'off') {
        return undefined;
    }

    // The OS proxy settings are also the source of the user's own bypass list.
    const systemSettings = config.mode === 'system' ? await getSystemProxySettings() : undefined;
    const port = target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80');
    if (matchesNoProxy(target.hostname, port, bypassedPatterns(config, systemSettings?.exceptions ?? []))) {
        return undefined;
    }

    if (config.mode === 'manual') {
        return config.manual ? { url: buildProxyUrl(config.manual), source: 'manual' } : undefined;
    }

    if (config.mode === 'pac') {
        return config.pacUrl ? { url: config.pacUrl, source: 'pac' } : undefined;
    }

    if (config.mode === 'system' && systemSettings) {
        if (systemSettings.mode === 'pac' && systemSettings.pacUrl) {
            return { url: systemSettings.pacUrl, source: 'pac' };
        }
        const fromSystem = proxyFromSystemSettings(target, systemSettings);
        if (fromSystem) {
            return fromSystem;
        }
    }

    // `system` mode falls back to the environment so that a machine whose OS
    // settings are empty still honours the variables Clash/TUN-less setups use.
    return proxyFromEnvironment(target);
}

/**
 * Synchronous variant used where an agent is needed immediately (socket.io
 * builds its options synchronously). System proxy detection is asynchronous, so
 * that mode only resolves from the cache that `configureProxy()` warms up.
 */
export function resolveProxyForUrlSync(
    targetUrl: string,
    config: ProxyConfig,
): ResolvedProxy | undefined {
    let target: URL;
    try {
        target = new URL(targetUrl);
    } catch {
        return undefined;
    }

    if (config.mode === 'off') {
        return undefined;
    }

    const port = target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80');
    if (matchesNoProxy(target.hostname, port, bypassedPatterns(config, []))) {
        return undefined;
    }

    if (config.mode === 'manual') {
        return config.manual ? { url: buildProxyUrl(config.manual), source: 'manual' } : undefined;
    }
    if (config.mode === 'pac') {
        return config.pacUrl ? { url: config.pacUrl, source: 'pac' } : undefined;
    }
    if (config.mode === 'system' && systemProxyCache) {
        const { settings } = systemProxyCache;
        if (settings.mode === 'pac' && settings.pacUrl) {
            return { url: settings.pacUrl, source: 'pac' };
        }
        const fromSystem = proxyFromSystemSettings(target, settings);
        if (fromSystem) {
            return fromSystem;
        }
    }

    return proxyFromEnvironment(target);
}

/** Builds the agent for a resolved proxy, or undefined when there is none. */
export function agentForResolvedProxy(
    resolved: ResolvedProxy | undefined,
    targetUrl: string,
): Agent | undefined {
    if (!resolved) {
        return undefined;
    }
    if (resolved.source === 'pac') {
        return createPacProxyAgent(resolved.url);
    }
    return createProxyAgent(resolved.url, targetUrl);
}
