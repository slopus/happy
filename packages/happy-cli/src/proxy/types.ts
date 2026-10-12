/**
 * Proxy configuration shapes.
 *
 * The configuration is persisted in ~/.happy/settings.json under `proxyConfig`,
 * edited interactively by `happy proxy configure`, or remotely by the mobile app
 * through the `set-proxy-config` machine RPC.
 *
 * `mode` decides where a proxy comes from:
 *   off      never use a proxy
 *   env      standard proxy environment variables (historical behaviour)
 *   system   the operating system's proxy configuration (manual or PAC)
 *   pac      a specific PAC (proxy auto-config) script URL
 *   manual   an explicitly configured HTTP(S) or SOCKS proxy
 */
import * as z from 'zod';

export const ProxyProtocolSchema = z.enum(['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']);
export type ProxyProtocol = z.infer<typeof ProxyProtocolSchema>;

export const ManualProxySchema = z.object({
    protocol: ProxyProtocolSchema.default('http'),
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().optional(),
    password: z.string().optional(),
});
export type ManualProxy = z.infer<typeof ManualProxySchema>;

export const ProxyModeSchema = z.enum(['off', 'env', 'system', 'pac', 'manual']);
export type ProxyMode = z.infer<typeof ProxyModeSchema>;

export const ProxyConfigSchema = z.object({
    mode: ProxyModeSchema.default('env'),
    manual: ManualProxySchema.optional(),
    /** PAC script URL, used when mode is `pac`. */
    pacUrl: z.string().trim().min(1).optional(),
    /** Additional destinations that must never be proxied. */
    noProxy: z.array(z.string()).default([]),
    /** Export the resolved proxy to spawned agents so they inherit it. */
    useForChildProcesses: z.boolean().default(true),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

export const DEFAULT_PROXY_CONFIG: ProxyConfig = ProxyConfigSchema.parse({});

/** A proxy that has been resolved for a concrete destination. */
export interface ResolvedProxy {
    /** Full proxy URL, e.g. `http://127.0.0.1:7890` or `socks5h://127.0.0.1:1080`. */
    url: string;
    source: 'manual' | 'pac' | 'system' | 'env';
}

/** Builds the proxy URL for a manually configured proxy, credentials included. */
export function buildProxyUrl(manual: ManualProxy): string {
    const credentials = manual.username
        ? `${encodeURIComponent(manual.username)}:${encodeURIComponent(manual.password ?? '')}@`
        : '';
    return `${manual.protocol}://${credentials}${manual.host}:${manual.port}`;
}

/** Redacts credentials so proxy URLs can be logged or shown safely. */
export function maskProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '***';
        }
        return parsed.toString();
    } catch {
        return '<invalid proxy url>';
    }
}
