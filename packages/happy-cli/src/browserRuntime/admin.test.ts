import { mkdtemp, rm, stat } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskId } from './contracts'
import { collectRuntimeMetrics, startAdminServer, type AdminServer } from './admin'
import { TaskStore, type StoredTask } from './taskStore'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function call(target: { socketPath: string } | { port: number }, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = request({ ...('socketPath' in target ? { socketPath: target.socketPath } : { host: '127.0.0.1', port: target.port }), method, path, headers }, (res) => {
            let raw = ''
            res.on('data', (chunk) => { raw += chunk })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }))
        })
        req.on('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
    })
}

function storedTask(taskId: string, patch: Partial<StoredTask>): StoredTask {
    return {
        schemaVersion: 1, taskId: taskId as TaskId, taskSpaceId: 'space' as never, profileId: 'profile' as never, agentSessionId: 'session' as never,
        status: 'queued', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0, tabs: [], uncertainActions: [], createdAtMs: 1, updatedAtMs: 1,
        owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' }, actions: {}, approvals: {}, batches: {}, dedupe: {}, ...patch,
    }
}

const fakeRuntime = (log: string[]) => ({
    revokeGrant: async (grantId: string) => { log.push(`grant:${grantId}`) },
    reconcileAction: async () => ({}) as never,
    pinnedProfiles: () => [],
})

describe('admin server', () => {
    it('serves admin operations on a 0600 unix socket without a bearer token', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-admin-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
        const log: string[] = []
        const socketPath = join(dir, 'admin.sock')
        const server: AdminServer = await startAdminServer({
            runtime: fakeRuntime(log), drivers: new Map(), listen: { socketPath },
            metrics: async () => ({ tasks: { queued: 1 } }),
            revokeCapability: async (capabilityId) => { log.push(`capability:${capabilityId}`) },
        })
        cleanups.push(() => server.close())
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
        expect(await call({ socketPath }, 'GET', '/admin/metrics')).toEqual({ status: 200, body: { ok: true, result: { tasks: { queued: 1 } } } })
        expect((await call({ socketPath }, 'POST', '/admin/revoke-capability', {}, { capabilityId: 'cap-1' })).status).toBe(200)
        expect((await call({ socketPath }, 'POST', '/admin/revoke-grant', {}, { grantId: 'g-1' })).status).toBe(200)
        expect(log).toEqual(['capability:cap-1', 'grant:g-1'])
    })

    it('lists spaces and closes one for the operator (abp-stack spaces list|close)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-admin-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
        const closes: string[] = []
        const socketPath = join(dir, 'admin.sock')
        const server = await startAdminServer({
            runtime: { ...fakeRuntime([]),
                spaceReport: () => [{ taskSpaceId: 'space-1', agentSessionId: 'session-a', tasks: [], tabs: ['tab-1'] }] as never,
                closeSpaceAsOperator: async (taskSpaceId: string, options?: { force?: boolean }) => {
                    closes.push(`${taskSpaceId}:${options?.force === true}`)
                    return { taskSpaceId, reason: 'operator', closed: true, closedTabs: ['tab-1'] } as never
                } },
            drivers: new Map(), listen: { socketPath }, metrics: async () => ({}), revokeCapability: async () => undefined,
        })
        cleanups.push(() => server.close())
        expect((await call({ socketPath }, 'GET', '/admin/spaces')).body).toEqual({ ok: true, result: { spaces: [{ taskSpaceId: 'space-1', agentSessionId: 'session-a', tasks: [], tabs: ['tab-1'] }] } })
        expect((await call({ socketPath }, 'POST', '/admin/close-space', {}, { taskSpaceId: 'space-1' })).body.result).toMatchObject({ closed: true, closedTabs: ['tab-1'] })
        expect((await call({ socketPath }, 'POST', '/admin/close-space', {}, { taskSpaceId: 'space-1', force: true })).status).toBe(200)
        expect((await call({ socketPath }, 'POST', '/admin/close-space', {}, {})).status).toBe(500)
        expect(closes).toEqual(['space-1:false', 'space-1:true'])
    })

    it('keeps the bearer token on the harness TCP listener', async () => {
        const log: string[] = []
        const server = await startAdminServer({
            runtime: fakeRuntime(log), drivers: new Map(), listen: { host: '127.0.0.1', port: 0, adminToken: 'synthetic-admin-token-0123456789abcdef' },
            metrics: async () => ({}), revokeCapability: async () => undefined,
        })
        cleanups.push(() => server.close())
        const port = server.port!
        expect((await call({ port }, 'GET', '/admin/metrics')).status).toBe(401)
        expect((await call({ port }, 'GET', '/admin/metrics', { authorization: 'Bearer synthetic-admin-token-0123456789abcdef' })).status).toBe(200)
    })
})

describe('collectRuntimeMetrics', () => {
    it('counts tasks by status and uncertain actions, and reports fence ACK latency and disk space', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-metrics-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
        const store = await TaskStore.open(dir); cleanups.push(() => store.close())
        const created = { type: 'task-created' as const, atMs: 1, leaseEpoch: 0, data: {} }
        await store.createTask(storedTask('t1', { status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: ['a1', 'a2'] as never }), created)
        await store.createTask(storedTask('t2', { status: 'paused', pauseReason: 'awaiting-agent' }), created)
        await store.createTask(storedTask('t3', { status: 'succeeded' }), created)
        const metrics = await collectRuntimeMetrics({ store, drivers: new Map([['profile-a', { isConnected: () => true }]]), stateDir: dir, fenceAcksMs: [5, 30, 12] })
        expect(metrics).toMatchObject({
            tasks: { paused: 2, succeeded: 1 }, uncertainActions: 2, uncertainTasks: 1,
            fenceAck: { count: 3, maxMs: 30, p50Ms: 12 }, browsers: { 'profile-a': { connected: true } },
        })
        expect(metrics.disk.freeBytes).toBeGreaterThan(0)
    })
})
