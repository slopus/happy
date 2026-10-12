/**
 * Proxy agent construction.
 *
 * Every proxy mode ends up as a Node `http.Agent`, which is the single object
 * both `socket.io-client` (through `transportOptions.websocket.agent`) and
 * `axios`/`fetch` accept. Agents are cached per proxy URL because they hold
 * connection pools and must not be recreated per request.
 */
import type { Agent } from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { PacProxyAgent } from 'pac-proxy-agent';

const agentCache = new Map<string, Agent>();

function isSocksProxy(proxyUrl: URL): boolean {
    return proxyUrl.protocol.startsWith('socks');
}

function isSecureTarget(targetUrl: URL): boolean {
    return targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:';
}

/**
 * Builds the agent for one proxy URL and destination, or undefined when the
 * proxy URL cannot be used.
 *
 * HTTP(S) proxies use CONNECT for https/wss destinations; SOCKS proxies tunnel
 * both. `socks5h`/`socks4a` resolve the destination host on the proxy side,
 * `socks5`/`socks4` resolve it locally.
 */
export function createProxyAgent(proxyUrl: string, targetUrl: string): Agent | undefined {
    let proxy: URL;
    let target: URL;
    try {
        proxy = new URL(proxyUrl);
        target = new URL(targetUrl);
    } catch {
        return undefined;
    }

    const cacheKey = `${proxy.href}|${isSecureTarget(target) ? 'secure' : 'plain'}`;
    const cached = agentCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    let agent: Agent;
    if (isSocksProxy(proxy)) {
        agent = new SocksProxyAgent(proxy);
    } else if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
        return undefined;
    } else if (isSecureTarget(target)) {
        agent = new HttpsProxyAgent(proxy);
    } else {
        agent = new HttpProxyAgent(proxy);
    }

    agentCache.set(cacheKey, agent);
    return agent;
}

/**
 * Builds a PAC driven agent. The PAC file is fetched (and re-checked) lazily by
 * the agent itself, and the decision is made per destination request.
 */
export function createPacProxyAgent(pacUrl: string): Agent | undefined {
    const uri = /^pac\+/i.test(pacUrl) ? pacUrl : `pac+${pacUrl}`;
    const cacheKey = `pac|${uri}`;
    const cached = agentCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    try {
        const agent = new PacProxyAgent(uri);
        agentCache.set(cacheKey, agent);
        return agent;
    } catch {
        return undefined;
    }
}

/** Drops cached agents, used when the configuration changes at runtime. */
export function clearProxyAgentCache(): void {
    agentCache.clear();
}
