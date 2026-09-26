/**
 * Admin API of the Browser Runtime: revocation, trusted reconciliation,
 * metrics and task spaces (`GET /admin/spaces`, `POST /admin/close-space
 * { taskSpaceId, force? }`). Never reachable with an agent grant or an interactive capability.
 *
 * Production: a unix socket only (host /run/abp/admin.sock, 0600) — file
 * permissions are the authentication. Harness: the PoC TCP port with a bearer
 * admin token, so the existing E2E suites keep working.
 */
import { timingSafeEqual } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { listenOnSocket } from './broker'
import { BrowserRuntimeError, type ActionId, type GrantId, type ProfileId, type TaskId, type TaskSpaceId } from './contracts'
import type { CdpDriver } from './drivers/cdpDriver'
import type { BrowserRuntime } from './runtime'
import type { TaskStore } from './taskStore'

function adminAuthorized(req: IncomingMessage, adminToken: string): boolean {
    const header = req.headers.authorization ?? ''
    const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    const expected = Buffer.from(adminToken)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = ''
    for await (const chunk of req) {
        raw += chunk
        if (raw.length > 64 * 1024) throw new BrowserRuntimeError('INVALID_REQUEST', 'body too large')
    }
    const value = raw ? JSON.parse(raw) as unknown : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserRuntimeError('INVALID_REQUEST', 'body must be an object')
    return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

export interface AdminServerInput {
    runtime: Pick<BrowserRuntime, 'revokeGrant' | 'reconcileAction' | 'pinnedProfiles'> & Partial<Pick<BrowserRuntime, 'spaceReport' | 'closeSpaceAsOperator'>>
    drivers: Map<ProfileId, Pick<CdpDriver, 'isConnected' | 'debugCounts'>>
    /** `server`: already listening on the admin socket (bound before the Runtime dropped root). */
    listen: { socketPath: string } | { server: Server } | { host: string; port: number; adminToken: string }
    metrics(): Promise<unknown>
    /** Immediate revocation of an interactive capability (e.g. a lost viewer). */
    revokeCapability(capabilityId: string): Promise<void>
}

export interface AdminServer { port?: number; close(): Promise<void> }

export async function startAdminServer(input: AdminServerInput): Promise<AdminServer> {
    const adminToken = 'adminToken' in input.listen ? input.listen.adminToken : undefined
    const server = 'server' in input.listen ? input.listen.server : createServer()
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            if (adminToken !== undefined && !adminAuthorized(req, adminToken)) return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED' } })
            const path = new URL(req.url ?? '/', 'http://admin').pathname
            try {
                if (req.method === 'GET' && path === '/admin/debug') {
                    const drivers = Object.fromEntries([...input.drivers].map(([id, driver]) => [id, {
                        connected: driver.isConnected(),
                        counts: driver.debugCounts(),
                    }]))
                    return sendJson(res, 200, { ok: true, result: { drivers, pinnedProfiles: input.runtime.pinnedProfiles(), memory: process.memoryUsage() } })
                }
                if (req.method === 'GET' && path === '/admin/metrics') return sendJson(res, 200, { ok: true, result: await input.metrics() })
                if (req.method === 'GET' && path === '/admin/spaces' && input.runtime.spaceReport)
                    return sendJson(res, 200, { ok: true, result: { spaces: input.runtime.spaceReport() } })
                if (req.method !== 'POST') return sendJson(res, 404, { ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
                const body = await readBody(req)
                if (path === '/admin/revoke-grant') {
                    await input.runtime.revokeGrant(String(body.grantId) as GrantId)
                    return sendJson(res, 200, { ok: true, result: { revoked: true } })
                }
                if (path === '/admin/revoke-capability') {
                    if (typeof body.capabilityId !== 'string' || !body.capabilityId) throw new BrowserRuntimeError('INVALID_REQUEST', 'capabilityId is required')
                    await input.revokeCapability(body.capabilityId)
                    return sendJson(res, 200, { ok: true, result: { revoked: true } })
                }
                if (path === '/admin/close-space' && input.runtime.closeSpaceAsOperator) {
                    if (typeof body.taskSpaceId !== 'string' || !body.taskSpaceId) throw new BrowserRuntimeError('INVALID_REQUEST', 'taskSpaceId is required')
                    const result = await input.runtime.closeSpaceAsOperator(body.taskSpaceId as TaskSpaceId, { force: body.force === true })
                    return sendJson(res, 200, { ok: true, result })
                }
                if (path === '/admin/reconcile-action') {
                    const task = await input.runtime.reconcileAction(body.taskId as TaskId, body.actionId as ActionId, body.confirmed === true)
                    return sendJson(res, 200, { ok: true, result: task })
                }
                return sendJson(res, 404, { ok: false, error: { code: 'UNSUPPORTED_OPERATION' } })
            } catch (error) {
                const body = error instanceof BrowserRuntimeError ? error.toBody() : { code: 'RUNTIME_UNAVAILABLE', message: 'admin operation failed', retryable: true, mayHaveSideEffects: true }
                return sendJson(res, 500, { ok: false, error: body })
            }
        })()
    })
    if ('socketPath' in input.listen) await listenOnSocket(server, input.listen.socketPath, 0o600)
    else if ('host' in input.listen) {
        const { host, port } = input.listen
        await new Promise<void>((resolve) => server.listen(port, host, resolve))
    }
    const address = server.address()
    return {
        ...(address && typeof address === 'object' ? { port: (address as AddressInfo).port } : {}),
        close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
    }
}

export interface RuntimeMetrics {
    tasks: Record<string, number>
    uncertainTasks: number
    uncertainActions: number
    fenceAck: { count: number; p50Ms?: number; maxMs?: number }
    browsers: Record<string, { connected: boolean }>
    disk: { freeBytes: number; totalBytes: number }
}

export async function collectRuntimeMetrics(input: {
    store: Pick<TaskStore, 'listTasks'>
    drivers: Map<string, Pick<CdpDriver, 'isConnected'>>
    stateDir: string
    /** Recent cancel fence ACK latencies. */
    fenceAcksMs: readonly number[]
}): Promise<RuntimeMetrics> {
    const tasks: Record<string, number> = {}
    let uncertainTasks = 0
    let uncertainActions = 0
    for (const task of input.store.listTasks()) {
        tasks[task.status] = (tasks[task.status] ?? 0) + 1
        if (task.uncertainActions.length) uncertainTasks++
        uncertainActions += task.uncertainActions.length
    }
    const sorted = [...input.fenceAcksMs].sort((a, b) => a - b)
    const disk = await statfs(input.stateDir)
    return {
        tasks, uncertainTasks, uncertainActions,
        fenceAck: { count: sorted.length, ...(sorted.length ? { p50Ms: sorted[Math.floor((sorted.length - 1) / 2)], maxMs: sorted.at(-1) } : {}) },
        browsers: Object.fromEntries([...input.drivers].map(([profileId, driver]) => [profileId, { connected: driver.isConnected() }])),
        disk: { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
    }
}
