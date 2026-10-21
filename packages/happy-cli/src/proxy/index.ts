/**
 * Proxy configuration entry point.
 *
 * `configureProxy()` is called once, before Happy performs any network work. It
 * loads the proxy section from settings, resolves the proxy for the relay, and
 * installs it into every transport Happy uses:
 *
 *   - socket.io relay sockets, through `createSocketProxyOptions()`
 *   - axios (REST, attachments, push), through a global request interceptor
 *   - global fetch, through `installProxiedFetch()`
 *   - spawned agents, through the standard proxy environment variables
 *
 * Everything is funnelled through the decision engine in `./resolve` so that
 * `off`, `env`, `system`, PAC and manual modes behave identically everywhere.
 */
import type { Agent } from 'node:http';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { configuration } from '@/configuration';
import { readSettings, updateSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { clearProxyAgentCache } from '@/proxy/agents';
import { installProxiedFetch } from '@/proxy/fetch';
import {
    agentForResolvedProxy,
    clearSystemProxyCache,
    getSystemProxySettings,
    resolveProxyForUrl,
    resolveProxyForUrlSync,
} from '@/proxy/resolve';
import type { SystemProxySettings, SystemProxyMode } from '@/proxy/system';
import {
    DEFAULT_PROXY_CONFIG,
    ProxyConfigSchema,
    maskProxyUrl,
    type ManualProxy,
    type ProxyConfig,
    type ResolvedProxy,
} from '@/proxy/types';

const PROXY_ENVIRONMENT_KEYS = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
] as const;

/** Options to spread into `io(...)` so the relay socket uses the proxy. */
export interface SocketProxyOptions {
    transportOptions?: {
        websocket: {
            agent: Agent;
        };
    };
}

export interface ProxyStatus {
    config: ProxyConfig;
    serverUrl: string;
    /** The proxy resolved for the relay server, when there is one. */
    resolved?: ResolvedProxy;
    /** True when an agent could be built for the relay server. */
    agentReady: boolean;
    /** The operating system's proxy configuration, when it is consulted. */
    system?: SystemProxySettings;
    /** Proxy environment variables currently exported to child processes. */
    environment: Record<string, string>;
}

let currentConfig: ProxyConfig = { ...DEFAULT_PROXY_CONFIG };
let axiosInterceptorInstalled = false;
const resolvedAgentCache = new Map<string, Agent | undefined>();

function originKey(targetUrl: string): string | undefined {
    try {
        const parsed = new URL(targetUrl);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return undefined;
    }
}

/** The proxy configuration currently in effect. */
export function getProxyConfig(): ProxyConfig {
    return currentConfig;
}

/**
 * Resolves the agent for a destination, caching per origin. PAC driven agents
 * are cached too: the PAC file itself is re-checked inside the agent.
 */
export async function getProxyAgentForUrl(targetUrl: string): Promise<Agent | undefined> {
    const key = originKey(targetUrl);
    if (key && resolvedAgentCache.has(key)) {
        return resolvedAgentCache.get(key);
    }
    const resolved = await resolveProxyForUrl(targetUrl, currentConfig);
    const agent = agentForResolvedProxy(resolved, targetUrl);
    if (key) {
        resolvedAgentCache.set(key, agent);
    }
    return agent;
}

/**
 * Synchronous variant for socket.io, whose options are built synchronously.
 * System proxy detection is asynchronous, so that mode resolves from the cache
 * warmed up by `configureProxy()`; misses are not cached so the next attempt
 * can succeed.
 */
export function getProxyAgentForUrlSync(targetUrl: string): Agent | undefined {
    const key = originKey(targetUrl);
    if (key && resolvedAgentCache.has(key)) {
        return resolvedAgentCache.get(key);
    }
    const agent = agentForResolvedProxy(resolveProxyForUrlSync(targetUrl, currentConfig), targetUrl);
    if (agent && key) {
        resolvedAgentCache.set(key, agent);
    }
    return agent;
}

/**
 * Proxy options for a socket.io connection. When the proxy is not resolved yet
 * (system mode on the very first call), the resolution is triggered so the next
 * reconnect uses it.
 */
export function createSocketProxyOptions(targetUrl: string): SocketProxyOptions {
    const agent = getProxyAgentForUrlSync(targetUrl);
    if (!agent) {
        void getProxyAgentForUrl(targetUrl).catch(() => undefined);
        return {};
    }
    return { transportOptions: { websocket: { agent } } };
}

function requestTargetUrl(config: InternalAxiosRequestConfig): string | undefined {
    const url = config.url;
    if (!url) {
        return undefined;
    }
    try {
        return config.baseURL ? new URL(url, config.baseURL).href : new URL(url).href;
    } catch {
        return undefined;
    }
}

function installAxiosProxyInterceptor(): void {
    if (axiosInterceptorInstalled) {
        return;
    }
    axiosInterceptorInstalled = true;
    axios.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
        // Axios must not apply its own environment based proxy on top of ours.
        config.proxy = false;
        const target = requestTargetUrl(config);
        if (!target) {
            return config;
        }
        const agent = await getProxyAgentForUrl(target);
        if (agent) {
            config.httpAgent = agent;
            config.httpsAgent = agent;
        }
        return config;
    });
}

/**
 * Exports the resolved proxy to the standard environment variables so that
 * spawned agents (claude, codex, gemini, ...) inherit it. PAC cannot be
 * expressed as environment variables, so those runs keep their own settings.
 */
function exportProxyToChildProcesses(): void {
    if (!currentConfig.useForChildProcesses) {
        return;
    }
    if (currentConfig.mode === 'off') {
        for (const key of PROXY_ENVIRONMENT_KEYS) {
            delete process.env[key];
        }
        return;
    }

    const resolved = resolveProxyForUrlSync(configuration.serverUrl, currentConfig);
    if (!resolved || resolved.source === 'pac') {
        return;
    }

    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        process.env[key] = resolved.url;
    }
    const bypass = [...currentConfig.noProxy, '127.0.0.1', 'localhost', '::1'].join(',');
    process.env.NO_PROXY = bypass;
    process.env.no_proxy = bypass;
    logger.debug(`[proxy] agents inherit ${maskProxyUrl(resolved.url)}`);
}

/**
 * Applies a proxy configuration to the running process without touching
 * settings. Used by `configureProxy()`, by the app's `set-proxy-config` RPC and
 * by tests.
 */
export async function applyProxyConfig(config: ProxyConfig): Promise<ProxyConfig> {
    const parsed = ProxyConfigSchema.safeParse(config);
    currentConfig = parsed.success ? parsed.data : { ...DEFAULT_PROXY_CONFIG };

    clearProxyAgentCache();
    clearSystemProxyCache();
    resolvedAgentCache.clear();

    // Warm the relay destination so socket.io, which builds its options
    // synchronously, always has an agent available.
    await getProxyAgentForUrl(configuration.serverUrl).catch(() => undefined);

    installAxiosProxyInterceptor();
    installProxiedFetch((url) => getProxyAgentForUrl(url));
    exportProxyToChildProcesses();

    logger.debug(
        `[proxy] mode=${currentConfig.mode}`
        + (currentConfig.pacUrl ? ` pac=${currentConfig.pacUrl}` : '')
        + (currentConfig.manual ? ` manual=${currentConfig.manual.protocol}://${currentConfig.manual.host}:${currentConfig.manual.port}` : ''),
    );
    return currentConfig;
}

/**
 * Loads the proxy configuration from settings and applies it everywhere. Safe
 * to call more than once: later calls re-read settings and rebuild the caches.
 */
export async function configureProxy(): Promise<ProxyConfig> {
    const settings = await readSettings().catch(() => undefined);
    return applyProxyConfig(settings?.proxyConfig ?? { ...DEFAULT_PROXY_CONFIG });
}

/**
 * Persists a new proxy configuration and applies it immediately.
 */
export async function setProxyConfig(config: ProxyConfig): Promise<ProxyConfig> {
    const validated = ProxyConfigSchema.parse(config);
    await updateSettings((settings) => ({ ...settings, proxyConfig: validated }));
    return applyProxyConfig(validated);
}

/** Details for `happy proxy status` and `happy doctor`. */
export async function describeProxy(): Promise<ProxyStatus> {
    const resolved = await resolveProxyForUrl(configuration.serverUrl, currentConfig);
    const agent = agentForResolvedProxy(resolved, configuration.serverUrl);
    const system = currentConfig.mode === 'system' ? await getSystemProxySettings() : undefined;
    const environment: Record<string, string> = {};
    for (const key of PROXY_ENVIRONMENT_KEYS) {
        const value = process.env[key];
        if (value) {
            // Bypass lists are not URLs and must be shown verbatim.
            environment[key] = key.toLowerCase() === 'no_proxy' ? value : maskProxyUrl(value);
        }
    }
    return {
        config: currentConfig,
        serverUrl: configuration.serverUrl,
        resolved,
        agentReady: Boolean(agent),
        system,
        environment,
    };
}

/**
 * Proxy configuration as exposed to remote clients (the mobile app): the same
 * shape without the proxy password, plus a flag saying whether one is stored.
 */
export interface RemoteProxyConfig extends Omit<ProxyConfig, 'manual'> {
    manual?: Omit<ManualProxy, 'password'> & { hasPassword: boolean };
}

/** Snapshot of the proxy state for the mobile app. */
export interface RemoteProxyStatus {
    config: RemoteProxyConfig;
    relayUrl: string;
    /** Proxy URL in effect for the relay, when it is not a PAC script. */
    proxyUrl?: string;
    /** PAC script URL in effect for the relay. */
    pacUrl?: string;
    /** Where the proxy decision came from. */
    source?: ResolvedProxy['source'];
    /** Whether a usable agent could be built for the relay. */
    agentReady: boolean;
    systemSource?: SystemProxySettings['source'];
    systemMode?: SystemProxyMode;
}

/** Mirrors a proxy configuration for remote clients, hiding credentials. */
export function toRemoteProxyConfig(config: ProxyConfig): RemoteProxyConfig {
    return {
        ...config,
        manual: config.manual
            ? {
                protocol: config.manual.protocol,
                host: config.manual.host,
                port: config.manual.port,
                username: config.manual.username,
                hasPassword: Boolean(config.manual.password),
            }
            : undefined,
    };
}

/**
 * Merges a remote proxy update onto the stored configuration. Remote clients
 * never receive the proxy password, so an update that omits it keeps the stored
 * one; sending an empty string clears it.
 */
export function mergeRemoteProxyConfig(incoming: unknown, current: ProxyConfig): ProxyConfig {
    const candidate = (incoming ?? {}) as Partial<ProxyConfig> & { manual?: Partial<ManualProxy> };
    const manual = candidate.manual
        ? {
            ...current.manual,
            ...candidate.manual,
            password: candidate.manual.password ?? current.manual?.password,
        }
        : current.manual;

    return ProxyConfigSchema.parse({ ...current, ...candidate, manual });
}

/** Proxy state for the mobile app's proxy settings screen. */
export async function describeProxyForRemote(): Promise<RemoteProxyStatus> {
    const status = await describeProxy();
    const isPac = status.resolved?.source === 'pac';
    return {
        config: toRemoteProxyConfig(status.config),
        relayUrl: status.serverUrl,
        proxyUrl: status.resolved && !isPac ? status.resolved.url : undefined,
        pacUrl: isPac ? status.resolved?.url : undefined,
        source: status.resolved?.source,
        agentReady: status.agentReady,
        systemSource: status.system?.source,
        systemMode: status.system?.mode,
    };
}
