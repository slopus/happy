/**
 * Proxy configuration utilities for HTTP and WebSocket connections
 *
 * Reads proxy settings from standard environment variables:
 * - HTTP_PROXY / http_proxy: Proxy for HTTP connections
 * - HTTPS_PROXY / https_proxy: Proxy for HTTPS connections
 * - ALL_PROXY / all_proxy: Fallback proxy for all connections
 * - NO_PROXY / no_proxy: Comma-separated list of hosts to bypass proxy
 */

import { URL } from 'node:url';
import type { Agent as HttpAgent } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { logger } from '@/ui/logger';

export interface ProxyConfig {
    url: string;
    protocol: 'http' | 'https' | 'socks4' | 'socks5';
    hostname: string;
    port: number;
    auth?: {
        username: string;
        password: string;
    };
}

/**
 * Get proxy URL from environment variables
 * Selects proxy based on target URL scheme:
 * - https:// or wss:// → HTTPS_PROXY
 * - http:// or ws:// → HTTP_PROXY
 * - Fallback → ALL_PROXY
 */
export function getProxyUrl(targetUrl?: string): string | undefined {
    // Check if target should bypass proxy
    if (targetUrl && shouldBypassProxy(targetUrl)) {
        return undefined;
    }

    let proxyUrl: string | undefined;

    // Select proxy based on target URL scheme
    if (targetUrl) {
        try {
            const url = new URL(targetUrl);
            const isSecure = url.protocol === 'https:' || url.protocol === 'wss:';

            if (isSecure) {
                // For HTTPS/WSS, prefer HTTPS_PROXY
                proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
            } else {
                // For HTTP/WS, prefer HTTP_PROXY
                proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy;
            }
        } catch {
            // If URL parsing fails, fall through to default behavior
        }
    }

    // Fallback: try all proxy env vars
    if (!proxyUrl) {
        proxyUrl =
            process.env.HTTPS_PROXY ||
            process.env.https_proxy ||
            process.env.HTTP_PROXY ||
            process.env.http_proxy ||
            process.env.ALL_PROXY ||
            process.env.all_proxy;
    }

    if (proxyUrl) {
        logger.debug(`[PROXY] Using proxy: ${proxyUrl}`);
    }

    return proxyUrl;
}

/**
 * Check if a URL should bypass the proxy based on NO_PROXY settings
 */
export function shouldBypassProxy(targetUrl: string): boolean {
    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    if (!noProxy) {
        return false;
    }

    const noProxyList = noProxy.split(',').map(h => h.trim().toLowerCase());

    // Handle NO_PROXY=* to disable all proxying
    if (noProxyList.includes('*')) {
        return true;
    }

    try {
        const url = new URL(targetUrl);
        const hostname = url.hostname.toLowerCase();

        for (const pattern of noProxyList) {
            if (!pattern) continue;

            // Handle wildcard patterns like *.example.com
            if (pattern.startsWith('*.')) {
                const suffix = pattern.slice(1); // .example.com
                if (hostname.endsWith(suffix) || hostname === pattern.slice(2)) {
                    return true;
                }
            }
            // Handle leading-dot patterns like .example.com (common format)
            else if (pattern.startsWith('.')) {
                // .example.com should match sub.example.com and example.com
                const domain = pattern.slice(1); // example.com
                if (hostname === domain || hostname.endsWith(pattern)) {
                    return true;
                }
            }
            // Handle exact matches or suffix matches (e.g., example.com matches sub.example.com)
            else if (hostname === pattern || hostname.endsWith('.' + pattern)) {
                return true;
            }
        }
    } catch (e) {
        // If URL parsing fails, don't bypass
        logger.debug(`[PROXY] Failed to parse URL for NO_PROXY check: ${targetUrl}`);
    }

    return false;
}

/**
 * Parse proxy URL into structured config
 */
export function parseProxyUrl(proxyUrl: string): ProxyConfig | null {
    try {
        const url = new URL(proxyUrl);

        let protocol: ProxyConfig['protocol'] = 'http';
        if (url.protocol === 'https:') {
            protocol = 'https';
        } else if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
            protocol = 'socks5';
        } else if (url.protocol === 'socks4:' || url.protocol === 'socks4a:' || url.protocol === 'socks:') {
            protocol = 'socks4';
        }

        // Default ports: HTTP=80, HTTPS=443, SOCKS=1080
        let defaultPort = 80;
        if (protocol === 'https') {
            defaultPort = 443;
        } else if (protocol === 'socks4' || protocol === 'socks5') {
            defaultPort = 1080;
        }

        const config: ProxyConfig = {
            url: proxyUrl,
            protocol,
            hostname: url.hostname,
            port: parseInt(url.port) || defaultPort
        };

        if (url.username || url.password) {
            config.auth = {
                username: decodeURIComponent(url.username),
                password: decodeURIComponent(url.password)
            };
        }

        return config;
    } catch (e) {
        logger.debug(`[PROXY] Failed to parse proxy URL: ${proxyUrl}`);
        return null;
    }
}

/**
 * Check if proxy is configured in environment
 */
export function isProxyConfigured(): boolean {
    return !!(
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy
    );
}

/**
 * Create an HTTPS proxy agent for WebSocket/HTTPS connections
 * Used for socket.io-client and axios
 */
export function createHttpsProxyAgent(targetUrl?: string): HttpsProxyAgent<string> | undefined {
    const proxyUrl = getProxyUrl(targetUrl);
    if (!proxyUrl) {
        return undefined;
    }

    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) {
        return undefined;
    }

    // For SOCKS proxies, we would need socks-proxy-agent
    // For now, log a warning and return undefined
    if (proxyConfig.protocol === 'socks4' || proxyConfig.protocol === 'socks5') {
        logger.debug(`[PROXY] SOCKS proxy detected (${proxyConfig.protocol}). Currently only HTTP/HTTPS proxies are fully supported.`);
        // Note: To support SOCKS, add 'socks-proxy-agent' dependency and use SocksProxyAgent
        return undefined;
    }

    logger.debug(`[PROXY] Creating HttpsProxyAgent for: ${proxyConfig.hostname}:${proxyConfig.port}`);
    return new HttpsProxyAgent(proxyUrl);
}

/**
 * Get axios proxy configuration
 * Returns false to disable proxy, or proxy config object
 */
export function getAxiosProxyConfig(targetUrl?: string): false | { host: string; port: number; auth?: { username: string; password: string }; protocol?: string } | undefined {
    if (targetUrl && shouldBypassProxy(targetUrl)) {
        return false; // Explicitly disable proxy for this request
    }

    const proxyUrl = getProxyUrl(targetUrl);
    if (!proxyUrl) {
        return undefined; // Let axios use default behavior (respects env vars)
    }

    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) {
        return undefined;
    }

    // For SOCKS proxies, axios doesn't have native support
    // We would need to use a custom agent
    if (proxyConfig.protocol === 'socks4' || proxyConfig.protocol === 'socks5') {
        logger.debug(`[PROXY] SOCKS proxy requires custom agent for axios.`);
        return undefined;
    }

    const axiosProxy: { host: string; port: number; auth?: { username: string; password: string }; protocol?: string } = {
        host: proxyConfig.hostname,
        port: proxyConfig.port,
        protocol: proxyConfig.protocol
    };

    if (proxyConfig.auth) {
        axiosProxy.auth = {
            username: proxyConfig.auth.username,
            password: proxyConfig.auth.password
        };
    }

    return axiosProxy;
}

/**
 * Get proxy agents for axios requests
 * Returns httpAgent and httpsAgent for use in axios config
 */
export function getAxiosProxyAgents(targetUrl?: string): { httpAgent?: HttpAgent; httpsAgent?: HttpsAgent } | undefined {
    const agent = createHttpsProxyAgent(targetUrl);
    if (!agent) {
        return undefined;
    }

    // HttpsProxyAgent can be used for both HTTP and HTTPS connections
    return {
        httpAgent: agent as unknown as HttpAgent,
        httpsAgent: agent
    };
}
