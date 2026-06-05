/**
 * Prevents local MCP HTTP servers from being routed through a configured HTTP proxy
 * by appending 127.0.0.1, localhost, and ::1 (IPv6 loopback) to NO_PROXY if missing.
 *
 * Writes both NO_PROXY and no_proxy (undici reads no_proxy first).
 * When both exist, NO_PROXY takes precedence and the merged result is written to both.
 */
export function ensureLocalProxyBypass(env: Record<string, string | undefined>): void {
    const existing = env.NO_PROXY ?? env.no_proxy ?? ''
    const entries = existing.split(',').map(s => s.trim()).filter(Boolean)

    const toAdd = ['127.0.0.1', 'localhost', '::1'].filter(h => !entries.includes(h))
    if (toAdd.length === 0) return

    const updated = existing ? `${existing},${toAdd.join(',')}` : toAdd.join(',')
    env.NO_PROXY = updated
    env.no_proxy = updated
}
