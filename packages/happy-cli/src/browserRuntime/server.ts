/**
 * HTTP transport for the Browser Runtime. Verifies bearer tokens, validates
 * request DTOs and forwards to BrowserRuntimeApi. No business rules here.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { BrowserRuntimeError, type AuthContext, type BrowserRuntimeApi, type ErrorCode, type Operation, type ProfileId, type RuntimeErrorBody, type TaskId } from './contracts'
import { renderConsolePage } from './consolePage'
import { VIEWER_ASSET_PREFIX, VIEWER_WEBSOCKET_PATH, serveViewerAsset, type ViewerProxy } from './viewerProxy'

const MAX_BODY_BYTES = 1024 * 1024
export const MAX_BATCH_WAIT_MS = 120_000
export const MAX_SUBSCRIBE_WAIT_MS = 30_000

const id = z.string().min(1).max(256)
const waitPredicate = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }).strict(),
    z.object({ kind: z.literal('ref'), ref: id }).strict(),
    z.object({ kind: z.literal('url'), urlPrefix: z.string() }).strict(),
])
const batchStep = z.object({
    stepId: id, actionId: id, tabId: id,
    kind: z.enum(['navigate', 'observe', 'screenshot', 'fill', 'click', 'waitFor']),
    timeoutMs: z.number().int().positive(),
    url: z.string().optional(), ref: z.string().optional(), snapshotId: id.optional(), value: z.string().optional(),
    name: z.string().optional(), until: waitPredicate.optional(),
}).strict()
const version = z.number().int().nonnegative()

export const REQUEST_SCHEMAS: Record<Operation, z.ZodType> = {
    createSpace: z.object({ profileId: id, requestId: id }).strict(),
    createTask: z.object({ taskSpaceId: id, requestId: id }).strict(),
    openPage: z.object({ taskId: id, url: z.string().min(1), requestId: id }).strict(),
    closePage: z.object({ taskSpaceId: id, tabId: id, requestId: id }).strict(),
    observe: z.object({ taskId: id, tabId: id, maxElements: z.number().int().positive().optional(), scopeRef: id.optional() }).strict(),
    screenshot: z.object({ taskId: id, tabId: id }).strict(),
    submitBatch: z.object({
        taskId: id, expectedVersion: version, requestId: id, steps: z.array(batchStep),
        waitMs: z.number().int().nonnegative().max(MAX_BATCH_WAIT_MS).optional(),
    }).strict(),
    finishTask: z.object({ taskId: id, expectedVersion: version, requestId: id }).strict(),
    getTask: z.object({ taskId: id }).strict(),
    subscribe: z.object({ taskId: id, afterSeq: version, waitMs: z.number().int().nonnegative().max(MAX_SUBSCRIBE_WAIT_MS).optional() }).strict(),
    approve: z.object({ taskId: id, approvalId: id, bindingHash: z.string().min(1), requestId: id, decision: z.enum(['approve', 'reject']) }).strict(),
    takeOver: z.object({ taskId: id, tabId: id, expectedEpoch: version, requestId: id }).strict(),
    releaseControl: z.object({ taskId: id, tabId: id, expectedEpoch: version, requestId: id }).strict(),
    resume: z.object({ taskId: id, expectedVersion: version, requestId: id }).strict(),
    cancel: z.object({ taskId: id, requestId: id }).strict(),
    closeSpace: z.object({ taskSpaceId: id, requestId: id }).strict(),
    viewerTicket: z.object({ profileId: id }).strict(),
    listTasks: z.object({ profileId: id }).strict(),
}

const STATUS: Partial<Record<ErrorCode, number>> = {
    UNAUTHORIZED: 401, SCOPE_DENIED: 403, ORIGIN_DENIED: 403,
    CONFLICT: 409, STALE_LEASE: 409, STALE_REF: 409, QUOTA_EXCEEDED: 429,
    RUNTIME_UNAVAILABLE: 503, JOURNAL_UNAVAILABLE: 503, INVALID_REQUEST: 400,
}
export function httpStatusFor(code: ErrorCode): number {
    return STATUS[code] ?? 500
}

export interface RuntimeServerOptions {
    /** waitForEvents is only used as a wake-up signal after an authorized subscribe; its result is ignored. */
    api: Omit<BrowserRuntimeApi, 'waitForEvents'> & { waitForEvents?(taskId: TaskId, afterSeq: number, waitMs: number): Promise<unknown> }
    verifyToken: (bearer: string) => AuthContext
    host?: string
    port: number
    health: () => object
    /** Readiness checks (browser connection, writer lock, disk); every value must be true. */
    ready?: () => Promise<Record<string, boolean>>
    log?: (line: string) => void
    /** Runtime viewer (D2). Without it viewerTicket answers RUNTIME_UNAVAILABLE. */
    viewer?: Pick<ViewerProxy, 'issueTicket' | 'handleUpgrade' | 'close'>
    /** Pinned noVNC client files served at /viewer/. */
    viewerAssetsDir?: string
}

export interface RuntimeServer { url: string; port: number; close(): Promise<void> }

class HttpError extends Error {
    constructor(readonly status: number, readonly body: RuntimeErrorBody) { super(body.message) }
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => {
            size += c.length
            if (size > MAX_BODY_BYTES) {
                reject(new BrowserRuntimeError('INVALID_REQUEST', 'request body too large'))
                req.destroy()
                return
            }
            chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function errorBody(err: unknown): { status: number; body: RuntimeErrorBody } {
    if (err instanceof HttpError) return { status: err.status, body: err.body }
    if (err instanceof BrowserRuntimeError) return { status: httpStatusFor(err.code), body: err.toBody() }
    // Unknown errors may carry anything (including secrets); never echo them.
    return { status: 500, body: { code: 'RUNTIME_UNAVAILABLE', message: 'internal error', retryable: true, mayHaveSideEffects: true } }
}

/** The request target, or undefined when it does not parse (e.g. `//[`). */
function parseTarget(target: string | undefined): URL | undefined {
    try {
        return new URL(target ?? '/', 'http://localhost')
    } catch {
        return undefined
    }
}

export async function startRuntimeServer(opts: RuntimeServerOptions): Promise<RuntimeServer> {
    const { api, verifyToken } = opts
    const log = opts.log ?? (() => {})

    const handleOp = async (req: IncomingMessage, op: string): Promise<unknown> => {
        if (!Object.prototype.hasOwnProperty.call(REQUEST_SCHEMAS, op)) {
            throw new HttpError(404, { code: 'UNSUPPORTED_OPERATION', message: 'unknown operation', retryable: false, mayHaveSideEffects: false })
        }
        const header = req.headers.authorization ?? ''
        const match = /^Bearer (\S+)$/.exec(header)
        if (!match) throw new BrowserRuntimeError('UNAUTHORIZED', 'missing bearer token')
        let auth: AuthContext
        try {
            auth = verifyToken(match[1])
        } catch (e) {
            if (e instanceof BrowserRuntimeError) throw e
            throw new BrowserRuntimeError('UNAUTHORIZED', 'invalid token')
        }
        const raw = await readBody(req)
        let json: unknown
        try {
            json = raw.length === 0 ? {} : JSON.parse(raw)
        } catch {
            throw new BrowserRuntimeError('INVALID_REQUEST', 'body is not valid JSON')
        }
        const parsed = REQUEST_SCHEMAS[op as Operation].safeParse(json)
        if (!parsed.success) {
            const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 5).join('; ')
            throw new BrowserRuntimeError('INVALID_REQUEST', `invalid ${op} request: ${detail}`)
        }
        const { waitMs, ...dto } = parsed.data as { waitMs?: number } & Record<string, unknown>
        if (op === 'viewerTicket') {
            if (!opts.viewer) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'viewer is not configured')
            return opts.viewer.issueTicket(auth, dto as { profileId: ProfileId })
        }
        const call = api[op as keyof typeof api] as (a: AuthContext, r: unknown, o?: unknown) => Promise<unknown>
        if (op === 'submitBatch') return call.call(api, auth, dto, waitMs !== undefined ? { waitMs } : undefined)
        if (op === 'subscribe') {
            const first = (await call.call(api, auth, dto)) as { kind: string; events?: unknown[] }
            if (!waitMs || !api.waitForEvents || first.kind !== 'events' || (first.events?.length ?? 0) > 0) return first
            await api.waitForEvents(dto.taskId as TaskId, dto.afterSeq as number, waitMs)
            return call.call(api, auth, dto)
        }
        return call.call(api, auth, dto)
    }

    const server = createServer(async (req, res) => {
        const url = parseTarget(req.url)
        if (!url) return send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'malformed request target', retryable: false, mayHaveSideEffects: false } })
        try {
            if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, ...opts.health() })
            if (req.method === 'GET' && url.pathname === '/v1/ready' && opts.ready) {
                const checks = await opts.ready()
                const ready = Object.values(checks).every(Boolean)
                return send(res, ready ? 200 : 503, { ok: ready, ready, checks })
            }
            if (req.method === 'GET' && url.pathname === '/console') {
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
                    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
                })
                return res.end(renderConsolePage())
            }
            if (req.method === 'GET' && url.pathname.startsWith(VIEWER_ASSET_PREFIX) && opts.viewerAssetsDir
                && await serveViewerAsset(opts.viewerAssetsDir, url.pathname, res)) return
            const m = /^\/v1\/ops\/([A-Za-z]+)$/.exec(url.pathname)
            if (req.method === 'POST' && m) return send(res, 200, { ok: true, result: await handleOp(req, m[1]) })
            send(res, 404, { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'not found', retryable: false, mayHaveSideEffects: false } })
        } catch (err) {
            const { status, body } = errorBody(err)
            // Path only: query strings and headers may carry credentials.
            log(`[browserRuntime] ${req.method} ${url.pathname} -> ${status} ${body.code}`)
            if (!res.headersSent) send(res, status, { ok: false, error: body })
        }
    })

    // Clients (undici pools, ~4 s idle) reuse keep-alive sockets; with Node's 5 s default the server can close a
    // socket just as a client sends a mutation on it, which then fails as "maybe reached". Keep idle sockets
    // well beyond any client pool idle time; shutdown closes them explicitly (closeAllConnections).
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000

    // Unauthenticated input: nothing here may throw past this handler.
    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => socket.destroy())
        try {
            const url = parseTarget(req.url)
            if (!url) return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            if (opts.viewer && url.pathname === VIEWER_WEBSOCKET_PATH) return opts.viewer.handleUpgrade(req, socket, head)
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        } catch {
            log('[browserRuntime] upgrade handler failed')
            socket.destroy()
        }
    })

    await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return {
        url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
        port,
        close: async () => {
            await opts.viewer?.close()
            await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
        },
    }
}
