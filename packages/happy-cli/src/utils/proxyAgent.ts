/**
 * Proxy agent utility for socket.io-client connections
 *
 * Supports standard proxy environment variables:
 * - HTTPS_PROXY / https_proxy: Proxy for HTTPS connections
 * - HTTP_PROXY / http_proxy: Proxy for HTTP connections
 * - ALL_PROXY / all_proxy: Fallback proxy for all protocols
 * - NO_PROXY / no_proxy: Comma-separated list of hosts to bypass proxy
 *
 * Also supports explicit configuration via HAPPY_PROXY_URL environment variable
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { URL } from 'node:url';

export interface ProxyConfig {
  /** Explicit proxy URL (overrides environment variables) */
  url?: string;
  /** Hosts to bypass proxy (comma-separated or array) */
  noProxy?: string | string[];
}

/**
 * Get proxy URL from environment variables
 * Priority: HAPPY_PROXY_URL > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
 */
export function getProxyUrlFromEnv(targetUrl: string): string | undefined {
  // Check if target should bypass proxy
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy && shouldBypassProxy(targetUrl, noProxy)) {
    return undefined;
  }

  // Happy-specific proxy takes highest priority
  if (process.env.HAPPY_PROXY_URL) {
    return process.env.HAPPY_PROXY_URL;
  }

  const parsedUrl = new URL(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'wss:';

  if (isHttps) {
    // For HTTPS/WSS, prefer HTTPS_PROXY
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
    );
  } else {
    // For HTTP/WS, prefer HTTP_PROXY
    return (
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
    );
  }
}

/**
 * Check if a target URL should bypass the proxy
 */
export function shouldBypassProxy(targetUrl: string, noProxy: string): boolean {
  if (!noProxy) return false;

  const parsedUrl = new URL(targetUrl);
  const hostname = parsedUrl.hostname.toLowerCase();

  const noProxyHosts = noProxy.split(',').map(h => h.trim().toLowerCase());

  for (const pattern of noProxyHosts) {
    if (!pattern) continue;

    // Handle wildcard patterns like *.example.com
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    // Handle exact match or suffix match
    else if (hostname === pattern || hostname.endsWith('.' + pattern)) {
      return true;
    }
    // Handle localhost and 127.0.0.1 specially
    else if (pattern === 'localhost' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      return true;
    }
  }

  return false;
}

/**
 * Create an HTTP/HTTPS agent for proxy connections
 * Returns undefined if no proxy is configured
 *
 * @param targetUrl - The target URL to connect to (determines HTTP vs HTTPS)
 * @param config - Optional explicit proxy configuration
 */
export function createProxyAgent(
  targetUrl: string,
  config?: ProxyConfig
): HttpAgent | HttpsAgent | undefined {
  // Check for explicit config first
  let proxyUrl = config?.url;

  // Fall back to environment variables
  if (!proxyUrl) {
    // Check explicit noProxy config
    if (config?.noProxy) {
      const noProxyStr = Array.isArray(config.noProxy)
        ? config.noProxy.join(',')
        : config.noProxy;
      if (shouldBypassProxy(targetUrl, noProxyStr)) {
        return undefined;
      }
    }

    proxyUrl = getProxyUrlFromEnv(targetUrl);
  }

  if (!proxyUrl) {
    return undefined;
  }

  const parsedTarget = new URL(targetUrl);
  const isTargetSecure = parsedTarget.protocol === 'https:' || parsedTarget.protocol === 'wss:';

  // Create appropriate agent based on target protocol
  if (isTargetSecure) {
    return new HttpsProxyAgent(proxyUrl);
  } else {
    return new HttpProxyAgent(proxyUrl);
  }
}

/**
 * Get socket.io-client compatible options with proxy agent
 *
 * Note: socket.io-client's TypeScript definitions define `agent` as `string | boolean`
 * for browser compatibility, but it actually accepts http.Agent in Node.js.
 * We cast to `false` type to satisfy TypeScript while passing the actual agent.
 *
 * @param targetUrl - The target URL to connect to
 * @param config - Optional explicit proxy configuration
 * @returns Object with agent property if proxy is configured, empty object otherwise
 */
export function getSocketProxyOptions(
  targetUrl: string,
  config?: ProxyConfig
): { agent?: false } {
  const agent = createProxyAgent(targetUrl, config);

  if (agent) {
    // Cast to `false` type - socket.io accepts http.Agent but types say string | boolean
    // See engine.io-client source: "http.Agent to use, defaults to false (NodeJS only)"
    return { agent: agent as unknown as false };
  }

  return {};
}
