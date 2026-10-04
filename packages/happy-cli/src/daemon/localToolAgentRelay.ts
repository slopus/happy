import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { readDaemonControlPort } from './browserClient'
import { readCredentials } from '@/persistence'

/** Discovery is not caller authorization. Desktop verifies caller/session on every request. */
export function attachLocalToolAgentRelayRoutes(app: FastifyInstance, now = Date.now) {
    let relay: { version: 1; port: number; secret: string; expiresAt: number } | null = null
    const typed = app.withTypeProvider<ZodTypeProvider>()
    const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
    typed.put('/local-tools/relay', { schema: { body: z.object({ version: z.literal(1), port: z.number().int().min(1).max(65535), secret }).strict() } }, async request => {
        // Another live Desktop cannot silently take over the physical control broker.
        if (relay && relay.expiresAt > now() && relay.secret !== request.body.secret) throw new Error('RELAY_BUSY')
        relay = { ...request.body, expiresAt: now() + 30000 }; return { version: 1 }
    })
    typed.get('/local-tools/relay', async (_request, reply) => {
        if (!relay || relay.expiresAt <= now()) { reply.code(404); return { code: 'DESKTOP_REQUIRED' } }
        return relay
    })
    typed.delete('/local-tools/relay', { schema: { body: z.object({ secret }).strict() } }, async request => {
        if (relay?.secret === request.body.secret) relay = null
        return { version: 1 }
    })
}
export interface LocalToolAgentContext {
    serverUrl: string; machineId: string; sessionId: string; projectId: string | null
    callerGrant?: string; callerToken?: string
}
export async function localToolAgentContext(sessionId: string, machineId?: string): Promise<LocalToolAgentContext | null> {
    const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    if (!configured || !machineId || !sessionId) return null
    let url: URL
    try { url = new URL(configured) } catch { return null }
    if (url.pathname !== '/api/me/mcp-config' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const callerGrant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT
    // Standalone uses the same authenticated local credentials as mcp-config; Cloud
    // requires a signed caller grant and never substitutes the machine owner token.
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    const callerToken = !callerGrant && local ? (await readCredentials())?.token : undefined
    if (!callerGrant && !callerToken) return null
    return { serverUrl: url.origin, machineId, sessionId, projectId: url.searchParams.get('project_id'),
        ...(callerGrant ? { callerGrant } : { callerToken }) }
}
export async function requestLocalToolAgent(context: LocalToolAgentContext, operation: Record<string, unknown>, signal?: AbortSignal, dependencies = {
    daemon: readDaemonControlPort, fetch: globalThis.fetch,
}): Promise<Record<string, unknown>> {
    const daemon = await dependencies.daemon()
    if (!daemon) throw new Error('DESKTOP_REQUIRED')
    const response = await dependencies.fetch(`http://127.0.0.1:${daemon.port}/local-tools/relay`, {
        headers: { Authorization: `Bearer ${daemon.controlSecret}` }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3000)]),
    })
    if (!response.ok) throw new Error('DESKTOP_REQUIRED')
    const relay = await response.json() as { version?: unknown; port?: unknown; secret?: unknown; expiresAt?: unknown }
    if (relay.version !== 1 || !Number.isInteger(relay.port) || Number(relay.port) < 1 || Number(relay.port) > 65535
        || typeof relay.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(relay.secret)
        || typeof relay.expiresAt !== 'number' || relay.expiresAt <= Date.now() || relay.expiresAt > Date.now() + 31000) throw new Error('INVALID_RELAY')
    const result = await dependencies.fetch(`http://127.0.0.1:${relay.port}/call`, {
        method: 'POST', headers: { Authorization: `Bearer ${relay.secret}`, 'Content-Type': 'application/json' },
        // Fixed context wins over any tool argument; agents cannot choose another caller/session.
        body: JSON.stringify({ ...operation, ...context, version: 1 }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35000)]),
    })
    const body = await result.json() as Record<string, unknown>
    if (!result.ok) throw new Error(typeof body.code === 'string' && /^[A-Z_]{1,80}$/.test(body.code) ? body.code : 'LOCAL_TOOL_FAILED')
    if (body.version !== 1) throw new Error('INVALID_RELAY_RESPONSE')
    return body
}
