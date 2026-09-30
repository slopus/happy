/** Broker authentication, durable registrations, grants and revocation recovery. */
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeError, type GrantId, type PrincipalId, type ProfileId } from './contracts'
import { verifyToken } from './auth'
import { AttentionOutbox } from './attention'
import { BROKER_GRANT_TTL_MS, startBroker, withRevokingGrants, type Broker } from './broker'
import { TaskStore } from './taskStore'

const DAEMON_TOKEN = 'synthetic-daemon-token-0123456789abcdef'
const keys = { agentKey: 'synthetic-agent-key-0123456789abcdef' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

interface Reply { status: number; body: Record<string, any> }
function call(socketPath: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
            let raw = ''
            res.on('data', (chunk) => { raw += chunk })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }))
        })
        req.on('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
    })
}

const ASSIGNMENT = 'a'.repeat(32)
async function harness(options: { dir?: string; owner?: string; assignment?: string | null; admit?: () => Promise<void>; sessionHistory?: (agentSessionId: string) => Array<string | undefined>; revokeGrant?: (grantId: GrantId) => Promise<void>; recoveryRetryMs?: number; endSession?: (agentSessionId: string) => Promise<void>; sessionWaiting?: (agentSessionId: string) => Promise<boolean> } = {}) {
    const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'abp-broker-'))
    if (!options.dir) cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const store = await TaskStore.open(dir)
    const attention = await AttentionOutbox.open(dir)
    attention.attach(store)
    const revoked: GrantId[] = []
    const endedSessions: string[] = []
    const socketPath = join(dir, 'broker.sock')
    let now = 1_000_000
    const broker: Broker = await startBroker({
        socketPath, stateDir: dir, attention,
        daemonTokenSha256: createHash('sha256').update(DAEMON_TOKEN).digest('hex'),
        identity: { machineId: 'machine-h' as never, workspaceId: 'workspace-1' as never },
        profiles: new Map([['profile-a' as ProfileId, (options.owner ?? 'user-1') as PrincipalId]]),
        ...(options.assignment === null ? {} : { assignments: new Map([['profile-a' as ProfileId, options.assignment ?? ASSIGNMENT]]) }),
        ...(options.admit ? { admit: options.admit } : {}),
        ...(options.sessionHistory ? { sessionHistory: options.sessionHistory } : {}),
        allowedOrigins: ['https://shop.example'],
        agentKey: keys.agentKey,
        revokeGrant: async (grantId) => { await options.revokeGrant?.(grantId); await store.revoke(grantId); revoked.push(grantId) },
        now: () => now,
        recoveryRetryMs: options.recoveryRetryMs ?? 3_600_000,
        endSession: async (agentSessionId) => { await options.endSession?.(agentSessionId); endedSessions.push(agentSessionId) },
        ...(options.sessionWaiting ? { sessionWaiting: options.sessionWaiting } : {}),
    })
    const close = async () => { await broker.close(); await store.close() }
    cleanups.push(close)
    const daemon = { 'x-abp-daemon-token': DAEMON_TOKEN }
    const register = async (agentSessionId = 'session-1') => {
        const registered = await call(socketPath, 'POST', '/v1/sessions/register', daemon, { schemaVersion: 1 })
        expect(registered.status).toBe(200)
        const bound = await call(socketPath, 'POST', '/v1/sessions/bind', daemon, { schemaVersion: 1, registrationId: registered.body.result.registrationId, agentSessionId })
        expect(bound.status).toBe(200)
        return registered.body.result as { registrationId: string; sessionSecret: string }
    }
    const grant = (secret: string, body: Record<string, unknown> = {}) => call(socketPath, 'POST', '/v1/agent-grants', { 'x-abp-session-secret': secret },
        { schemaVersion: 1, agentSessionId: 'session-1', profileId: 'profile-a', ...body })
    return { dir, store, attention, socketPath, revoked, endedSessions, daemon, register, grant, close, broker, setNow: (value: number) => { now = value } }
}

describe('broker socket', () => {
    it('lists only public registration metadata with daemon auth, preserving owners across restart', async () => {
        const h = await harness()
        const owner = { bootId: 'boot-a', pid: 123, pidStartTime: '98765' }
        const unbound = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1, owner })
        const bound = await h.register()
        await h.grant(bound.sessionSecret)
        // Binding can attach ownership after spawn, including an idempotent bind retry.
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, {
            schemaVersion: 1, registrationId: bound.registrationId, agentSessionId: 'session-1', owner,
        })).status).toBe(200)
        const legacy = await h.register('legacy')
        const booted = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1, bootId: 'boot-a' })
        const unauthorizedHeaders: Record<string, string>[] = [{}, { 'x-abp-daemon-token': 'wrong' }, { 'x-abp-session-secret': bound.sessionSecret }]
        for (const headers of unauthorizedHeaders) {
            expect((await call(h.socketPath, 'GET', '/v1/sessions', headers)).status).toBe(401)
        }
        const expected = [
            { registrationId: unbound.body.result.registrationId, owner, createdAtMs: 1_000_000, revoking: false },
            { registrationId: bound.registrationId, agentSessionId: 'session-1', owner, createdAtMs: 1_000_000, revoking: false },
            { registrationId: legacy.registrationId, agentSessionId: 'legacy', createdAtMs: 1_000_000, revoking: false },
            { registrationId: booted.body.result.registrationId, bootId: 'boot-a', createdAtMs: 1_000_000, revoking: false },
        ]
        // Exact equality excludes secrets, hashes and grant ids.
        expect((await call(h.socketPath, 'GET', '/v1/sessions', h.daemon)).body.result).toEqual(expected)
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const restarted = await harness({ dir: h.dir })
        expect((await call(restarted.socketPath, 'GET', '/v1/sessions', restarted.daemon)).body.result).toEqual(expected)
    })

    it('requires the daemon token to register a session', async () => {
        const h = await harness()
        expect((await call(h.socketPath, 'POST', '/v1/sessions/register', {}, { schemaVersion: 1 })).status).toBe(401)
        expect((await call(h.socketPath, 'POST', '/v1/sessions/register', { 'x-abp-daemon-token': 'wrong' }, { schemaVersion: 1 })).status).toBe(401)
    })

    it('issues a 55 minute agent grant bound to the registered session and the profile owner', async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        expect(sessionSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
        const reply = await h.grant(sessionSecret)
        expect(reply.status).toBe(200)
        const { token, grantId, expiresAtMs } = reply.body.result
        expect(expiresAtMs).toBe(1_000_000 + BROKER_GRANT_TTL_MS)
        const auth = verifyToken(token, keys, 1_000_000)
        expect(auth.credential).toMatchObject({ kind: 'agent-grant', grantId, agentSessionId: 'session-1', principalId: 'user-1',
            workspaceId: 'workspace-1', machineId: 'machine-h', profileId: 'profile-a', allowedOrigins: ['https://shop.example'], assignmentId: ASSIGNMENT })
        expect(auth.credential.operations).not.toContain('approve')
    })

    it('rejects a forged session secret and an unbound registration', async () => {
        const h = await harness()
        await h.register()
        expect((await h.grant('A'.repeat(43))).status).toBe(401)
        const unbound = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
        const reply = await h.grant(unbound.body.result.sessionSecret)
        expect(reply.status).toBe(409)
        expect(reply.body.error.retryable).toBe(true)
    })

    it("rejects one session's secret used for another session or an unlisted profile", async () => {
        const h = await harness()
        const first = await h.register('session-1')
        await h.register('session-2')
        expect((await h.grant(first.sessionSecret, { agentSessionId: 'session-2' })).status).toBe(403)
        expect((await h.grant(first.sessionSecret, { profileId: 'profile-b' })).status).toBe(403)
    })

    it('refuses to bind a registration twice or two registrations to one session', async () => {
        const h = await harness()
        const first = await h.register('session-1')
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId: first.registrationId, agentSessionId: 'session-9' })).status).toBe(409)
        const second = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId: second.body.result.registrationId, agentSessionId: 'session-1' })).status).toBe(409)
    })

    it('revokes every grant of a session and refuses renewal afterwards', async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        const issued = [(await h.grant(sessionSecret)).body.result.grantId, (await h.grant(sessionSecret)).body.result.grantId]
        const revoked = await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
        expect(revoked.status).toBe(200)
        expect(h.revoked.sort()).toEqual(issued.sort())
        expect((await h.grant(sessionSecret)).status).toBe(401)
    })

    it('refuses a grant whose request body finishes after the session was revoked', async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        const body = JSON.stringify({ schemaVersion: 1, agentSessionId: 'session-1', profileId: 'profile-a' })
        let sent!: () => void
        const headersSent = new Promise<void>((resolve) => { sent = resolve })
        const reply = new Promise<Reply>((resolve, reject) => {
            const req = request({ socketPath: h.socketPath, method: 'POST', path: '/v1/agent-grants',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-abp-session-secret': sessionSecret } }, (res) => {
                let raw = ''
                res.on('data', (chunk) => { raw += chunk })
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }))
            })
            req.on('error', reject)
            req.flushHeaders()
            req.write(body.slice(0, 10), () => sent())
            void (async () => {
                await headersSent
                await new Promise((resolve) => setTimeout(resolve, 50))
                const revoked = await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
                expect(revoked.body.result).toEqual({ revoked: true, grants: 0 })
                req.end(body.slice(10))
            })()
        })
        expect((await reply).status).toBe(401)
        expect(h.revoked).toEqual([])
    })

    it('keeps a revoking tombstone with its grant ids when grant revocation fails, and a retry finishes it', async () => {
        let failing = true
        const h = await harness({ revokeGrant: async () => { if (failing) throw new Error('journal down') } })
        const { sessionSecret } = await h.register()
        const issued = (await h.grant(sessionSecret)).body.result.grantId
        const failed = await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
        expect(failed.status).toBe(503)
        expect(failed.body.error.retryable).toBe(true)
        expect((await call(h.socketPath, 'GET', '/v1/sessions', h.daemon)).body.result).toEqual([
            { registrationId: expect.any(String), agentSessionId: 'session-1', createdAtMs: 1_000_000, revoking: true },
        ])
        const onDisk = JSON.parse(await readFile(join(h.dir, 'broker-sessions.json'), 'utf8'))
        expect(Object.values(onDisk.registrations)).toEqual([expect.objectContaining({ agentSessionId: 'session-1', revoking: true, grantIds: [issued] })])
        expect((await h.grant(sessionSecret)).status).toBe(401)
        failing = false
        const retried = await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
        expect(retried.body.result).toEqual({ revoked: true, grants: 1 })
        expect(h.revoked).toEqual([issued])
    })

    it('blocks issuance in memory when the tombstone itself cannot be persisted', async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        await h.grant(sessionSecret)
        await chmod(h.dir, 0o500)
        try {
            const failed = await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
            expect(failed.status).toBe(503)
            expect((await h.grant(sessionSecret)).status).toBe(401)
            expect(h.revoked).toEqual([])
        } finally {
            await chmod(h.dir, 0o700)
        }
        expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })).body.result).toEqual({ revoked: true, grants: 1 })
    })

    it('persists the tombstone again on a retry after its first write failed, so a restart still finishes the revocation', async () => {
        let revokeFails = false
        const h = await harness({ revokeGrant: async () => { if (revokeFails) throw new Error('crashed mid-revoke') } })
        const { sessionSecret } = await h.register()
        const issued = (await h.grant(sessionSecret)).body.result.grantId
        await chmod(h.dir, 0o500)
        try {
            expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })).status).toBe(503)
        } finally {
            await chmod(h.dir, 0o700)
        }
        // The daemon retries; this attempt is interrupted while revoking grants.
        revokeFails = true
        expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })).status).toBe(503)
        expect(Object.values(JSON.parse(await readFile(join(h.dir, 'broker-sessions.json'), 'utf8')).registrations)).toEqual([expect.objectContaining({ revoking: true, grantIds: [issued] })])
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const restarted = await harness({ dir: h.dir })
        expect((await restarted.grant(sessionSecret)).status).toBe(401)
        await vi.waitFor(() => expect(restarted.broker.pendingRevocations()).toBe(0))
        expect(restarted.revoked).toEqual([issued])
    })

    it('finishes a revocation interrupted after its tombstone was persisted when the Runtime restarts', async () => {
        const h = await harness({ revokeGrant: async () => { throw new Error('crashed mid-revoke') } })
        const { sessionSecret } = await h.register()
        const issued = [(await h.grant(sessionSecret)).body.result.grantId, (await h.grant(sessionSecret)).body.result.grantId]
        expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })).status).toBe(503)
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const restarted = await harness({ dir: h.dir })
        expect((await restarted.grant(sessionSecret)).status).toBe(401)
        await vi.waitFor(() => expect(restarted.broker.pendingRevocations()).toBe(0))
        expect(restarted.revoked.sort()).toEqual(issued.sort())
        expect((await restarted.grant(sessionSecret)).status).toBe(401)
        expect(JSON.parse(await readFile(join(h.dir, 'broker-sessions.json'), 'utf8')).registrations).toEqual({})
        expect((await call(restarted.socketPath, 'POST', '/v1/sessions/revoke', restarted.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })).body.result).toEqual({ revoked: false, grants: 0 })
    })

    /** A session with one grant whose revocation stopped after the tombstone; returns the grant token and id. */
    async function interruptedRevocation() {
        const h = await harness({ revokeGrant: async () => { throw new Error('crashed mid-revoke') } })
        const { sessionSecret } = await h.register()
        const { token, grantId } = (await h.grant(sessionSecret)).body.result
        expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })).status).toBe(503)
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        return { dir: h.dir, token: token as string, grantId: grantId as string }
    }
    const apiAccepts = (token: string, restarted: { store: TaskStore; broker: Broker }) => {
        try { verifyToken(token, keys, 1_000_000, withRevokingGrants(restarted.store.getRevocations(), restarted.broker)); return true } catch { return false }
    }

    it('denies tombstoned grants to the task API from start-up while the replay is still running', async () => {
        const interrupted = await interruptedRevocation()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const restarted = await harness({ dir: interrupted.dir, revokeGrant: () => gate })
        expect(restarted.broker.revokingGrantIds()).toEqual(new Set([interrupted.grantId]))
        expect(restarted.broker.pendingRevocations()).toBe(1)
        expect(apiAccepts(interrupted.token, restarted)).toBe(false)
        release()
        await vi.waitFor(() => expect(restarted.broker.pendingRevocations()).toBe(0))
        expect(restarted.revoked).toEqual([interrupted.grantId])
        // Now denied through the Runtime's own durable revocation list.
        expect(apiAccepts(interrupted.token, restarted)).toBe(false)
    })

    it('keeps tombstoned grants denied and reports them pending when the replay fails, and retries it', async () => {
        const interrupted = await interruptedRevocation()
        let failing = true
        const restarted = await harness({ dir: interrupted.dir, recoveryRetryMs: 20, revokeGrant: async () => { if (failing) throw new Error('journal down') } })
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(restarted.broker.pendingRevocations()).toBe(1)
        expect(apiAccepts(interrupted.token, restarted)).toBe(false)
        failing = false
        await vi.waitFor(() => expect(restarted.broker.pendingRevocations()).toBe(0))
        expect(restarted.revoked).toEqual([interrupted.grantId])
    })

    it('ends the bound session (task and space reclamation) before it forgets the registration, and retries a failed end', async () => {
        let failing = true
        const h = await harness({ endSession: async () => { if (failing) throw new Error('journal down') } })
        await h.register('session-1')
        const unbound = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
        const failed = await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1', endSession: true })
        expect([failed.status, failed.body.error.retryable]).toEqual([503, true])
        expect(h.broker.pendingRevocations()).toBe(1)
        failing = false
        expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1', endSession: true })).body.result).toEqual({ revoked: true, grants: 0 })
        expect(h.endedSessions).toEqual(['session-1'])
        // A registration never bound to a session has no session to end.
        await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, registrationId: unbound.body.result.registrationId })
        expect(h.endedSessions).toEqual(['session-1'])
    })

    it('keeps orphaned tasks until TTL, persists the mark, and clears it on resume', async () => {
        const h = await harness()
        await h.register()
        await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
        expect(h.endedSessions).toEqual([])
        expect(JSON.parse(await readFile(join(h.dir, 'broker-sessions.json'), 'utf8')).orphanedSessions).toEqual({ 'session-1': 1_000_000 })
        await h.close(); cleanups.splice(cleanups.indexOf(h.close), 1)
        const restarted = await harness({ dir: h.dir })
        restarted.setNow(1_000_000 + 60 * 60_000 - 1)
        await restarted.broker.sweepOrphans()
        expect(restarted.endedSessions).toEqual([])
        await restarted.register()
        restarted.setNow(1_000_000 + 60 * 60_000 + 1)
        await restarted.broker.sweepOrphans()
        expect(restarted.endedSessions).toEqual([])
        await call(restarted.socketPath, 'POST', '/v1/sessions/revoke', restarted.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
        restarted.setNow(1_000_000 + 2 * 60 * 60_000 + 2)
        await restarted.broker.sweepOrphans()
        expect(restarted.endedSessions).toEqual(['session-1'])
    })

    it('keeps registrations across a Runtime restart', async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const restarted = await harness({ dir: h.dir })
        expect((await restarted.grant(sessionSecret)).status).toBe(200)
    })

    it('permanently refuses the old secret and grant after reassignment, including A to B to A', async () => {
        const h = await harness({ assignment: '1'.repeat(32) })
        const { sessionSecret } = await h.register()
        const { token } = (await h.grant(sessionSecret)).body.result
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const reassigned = await harness({ dir: h.dir, owner: 'user-2', assignment: '2'.repeat(32) })
        // Revoked at start-up (tombstoned first), its session ended.
        expect((await reassigned.grant(sessionSecret)).status).toBe(401)
        await vi.waitFor(() => expect(reassigned.endedSessions).toEqual(['session-1']))
        await reassigned.close()
        cleanups.splice(cleanups.indexOf(reassigned.close), 1)
        const back = await harness({ dir: h.dir, owner: 'user-1', assignment: '3'.repeat(32) })
        expect((await back.grant(sessionSecret)).status).toBe(401)
        // The first assignment's grant, unexpired and signed by the same key, fails the assignment check.
        const policy = { authMode: 'production' as const, profileAssignments: new Map([['profile-a' as ProfileId, '3'.repeat(32)]]) }
        expect(() => verifyToken(token, keys, 1_000_000, new Set(), policy)).toThrow(/earlier assignment/)
        expect(verifyToken(token, keys, 1_000_000, new Set(), { ...policy, profileAssignments: new Map([['profile-a' as ProfileId, '1'.repeat(32)]]) })).toBeTruthy()
        // A resumed chat of the first assignment registers anew but cannot bind its old session id.
        const fresh = await call(back.socketPath, 'POST', '/v1/sessions/register', back.daemon, { schemaVersion: 1 })
        const rebind = await call(back.socketPath, 'POST', '/v1/sessions/bind', back.daemon, { schemaVersion: 1, registrationId: fresh.body.result.registrationId, agentSessionId: 'session-1' })
        expect(rebind.status).toBe(403)
        expect(rebind.body.error.message).toMatch(/earlier assignment/)
        // A new chat works.
        const bound = await call(back.socketPath, 'POST', '/v1/sessions/bind', back.daemon, { schemaVersion: 1, registrationId: fresh.body.result.registrationId, agentSessionId: 'session-new' })
        expect(bound.status).toBe(200)
        expect((await back.grant(fresh.body.result.sessionSecret, { agentSessionId: 'session-new' })).body.result.token).toBeTruthy()
    })

    it('keeps a resumed session of the same assignment bindable, and refuses one whose records are of an earlier assignment', async () => {
        const history: Record<string, Array<string | undefined>> = { 'session-old': ['9'.repeat(32)], 'session-untagged': [undefined], 'session-1': [ASSIGNMENT] }
        const h = await harness({ sessionHistory: (id) => history[id] ?? [] })
        const first = await h.register('session-1')
        await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, agentSessionId: 'session-1' })
        // Resume in the same assignment: a new registration binds the same logical session.
        const resumed = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId: resumed.body.result.registrationId, agentSessionId: 'session-1' })).status).toBe(200)
        expect(first.sessionSecret).not.toBe(resumed.body.result.sessionSecret)
        for (const id of ['session-old', 'session-untagged']) {
            const other = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
            expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId: other.body.result.registrationId, agentSessionId: id })).status).toBe(403)
        }
    })

    it('lets a bind be retried (same registration, same session), also after a restart in the same assignment', async () => {
        const h = await harness()
        const registered = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
        const bind = (target: typeof h) => call(target.socketPath, 'POST', '/v1/sessions/bind', target.daemon,
            { schemaVersion: 1, registrationId: registered.body.result.registrationId, agentSessionId: 'session-1' })
        expect((await bind(h)).status).toBe(200)
        expect((await bind(h)).status).toBe(200)
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const restarted = await harness({ dir: h.dir })
        expect((await bind(restarted)).status).toBe(200)
        expect((await restarted.grant(registered.body.result.sessionSecret)).status).toBe(200)
        expect(restarted.broker.isRetired('session-1')).toBe(false)
    })

    it('refuses a fork or recovery of an earlier assignment\'s conversation under a new session id, and allows one of the current assignment', async () => {
        const first = await harness({ assignment: '1'.repeat(32) })
        await first.register('session-a1')
        // A fork in the first assignment records the Claude conversation it continues.
        const fork1 = await call(first.socketPath, 'POST', '/v1/sessions/register', first.daemon,
            { schemaVersion: 1, lineage: { parentSessionIds: ['session-a1'], conversationIds: ['claude:conv-1'] } })
        expect(fork1.status).toBe(200)
        expect((await call(first.socketPath, 'POST', '/v1/sessions/bind', first.daemon,
            { schemaVersion: 1, registrationId: fork1.body.result.registrationId, agentSessionId: 'session-a1-fork' })).status).toBe(200)
        await first.close()
        cleanups.splice(cleanups.indexOf(first.close), 1)

        // The same owner is back in a third assignment.
        const back = await harness({ dir: first.dir, assignment: '3'.repeat(32) })
        const register = (lineage: { parentSessionIds?: string[]; conversationIds?: string[] }) => call(back.socketPath, 'POST', '/v1/sessions/register', back.daemon, { schemaVersion: 1, lineage })
        for (const lineage of [
            { parentSessionIds: ['session-a1'] },
            { parentSessionIds: ['session-a1-fork'], conversationIds: ['claude:conv-2'] },
            // The provider conversation alone (its parent unknown here) is enough.
            { parentSessionIds: ['session-unknown'], conversationIds: ['claude:conv-1'] },
        ]) {
            const denied = await register(lineage)
            expect([denied.status, denied.body.error.code]).toEqual([403, 'SCOPE_DENIED'])
        }
        // A fork of a conversation of the current assignment works, and so does a fork of that fork.
        const fresh = await back.register('session-a3')
        expect(fresh.sessionSecret).toBeTruthy()
        const fork3 = await register({ parentSessionIds: ['session-a3'], conversationIds: ['claude:conv-3'] })
        expect(fork3.status).toBe(200)
        expect((await call(back.socketPath, 'POST', '/v1/sessions/bind', back.daemon,
            { schemaVersion: 1, registrationId: fork3.body.result.registrationId, agentSessionId: 'session-a3-fork' })).status).toBe(200)
        expect((await register({ parentSessionIds: ['session-a3-fork'], conversationIds: ['claude:conv-3'] })).status).toBe(200)
        // Lineage is bounded input.
        expect((await register({ parentSessionIds: Array.from({ length: 17 }, (_, index) => `s-${index}`) })).status).toBe(400)
    })

    it("refuses a fork whose parent's retained records belong to an earlier assignment (a session the ledger never saw)", async () => {
        const h = await harness({ sessionHistory: (id) => (id === 'session-before' ? [undefined] : id === 'session-old' ? ['9'.repeat(32)] : []) })
        for (const parent of ['session-before', 'session-old']) {
            const denied = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1, lineage: { parentSessionIds: [parent] } })
            expect(denied.status).toBe(403)
        }
        // A parent the ledgers never saw cannot be vouched for either.
        expect((await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1, lineage: { parentSessionIds: ['session-never-seen'] } })).status).toBe(403)
    })

    it('admits a resume or fork only when the current assignment vouches for its lineage; unknown history fails closed', async () => {
        const h = await harness()
        await h.register('session-current')
        const register = (lineage?: { parentSessionIds?: string[]; conversationIds?: string[] }) =>
            call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1, ...lineage ? { lineage } : {} })
        // Resume of a session bound in this assignment (the daemon names the session itself as parent).
        expect((await register({ parentSessionIds: ['session-current'] })).status).toBe(200)
        // Fork of it that resumes a provider conversation never seen before: vouched for by the parent, then recorded.
        const fork = await register({ parentSessionIds: ['session-current'], conversationIds: ['claude:conv-new'] })
        expect(fork.status).toBe(200)
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId: fork.body.result.registrationId, agentSessionId: 'session-fork' })).status).toBe(200)
        // Now known in this assignment, the conversation alone is enough.
        expect((await register({ conversationIds: ['claude:conv-new'] })).status).toBe(200)
        // Unknown: a session from before the ledger, a provider conversation alone, an unknown parent with it.
        for (const lineage of [{ parentSessionIds: ['session-pre-v2'] }, { conversationIds: ['claude:conv-unknown'] },
            { parentSessionIds: ['session-pre-v2'], conversationIds: ['claude:conv-new'] },
            { parentSessionIds: ['session-current', 'session-pre-v2'] }]) {
            expect((await register(lineage)).status).toBe(403)
        }
        // A fresh chat has no lineage.
        expect((await register()).status).toBe(200)
    })

    it('after a lost state volume (no ledger), refuses to resume any earlier session, and still starts fresh chats', async () => {
        const before = await harness()
        await before.register('session-1')
        await before.close()
        cleanups.splice(cleanups.indexOf(before.close), 1)
        const lost = await harness()
        const resume = await call(lost.socketPath, 'POST', '/v1/sessions/register', lost.daemon, { schemaVersion: 1, lineage: { parentSessionIds: ['session-1'] } })
        expect([resume.status, resume.body.error.message]).toEqual([403, expect.stringMatching(/current assignment/)])
        expect((await call(lost.socketPath, 'POST', '/v1/sessions/register', lost.daemon, { schemaVersion: 1 })).status).toBe(200)
    })

    it('revokes registrations made before assignments were recorded (first schema 2 start), and retires their sessions', async () => {
        const legacy = await harness({ assignment: null })
        await legacy.register('session-legacy')
        await legacy.close()
        cleanups.splice(cleanups.indexOf(legacy.close), 1)
        const h = await harness({ dir: legacy.dir })
        await vi.waitFor(() => expect(h.endedSessions).toEqual(['session-legacy']))
        expect(h.broker.isRetired('session-legacy')).toBe(true)
        expect(h.broker.isRetired('session-unknown')).toBe(false)
        expect((await call(h.socketPath, 'GET', '/v1/sessions/waiting?agentSessionId=session-legacy', h.daemon)).body.result).toEqual({ waiting: false })
        const fresh = await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId: fresh.body.result.registrationId, agentSessionId: 'session-legacy' })).status).toBe(403)
        // Durable: still retired after another restart in the same assignment.
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const again = await harness({ dir: legacy.dir })
        expect(again.broker.isRetired('session-legacy')).toBe(true)
    })

    it('admits no register, bind, grant or attention while the Runtime is closed; list and revoke still work', async () => {
        let open = true
        const h = await harness({ admit: async () => { if (!open) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'held', true) } })
        const { registrationId, sessionSecret } = await h.register()
        open = false
        expect((await call(h.socketPath, 'POST', '/v1/sessions/register', h.daemon, { schemaVersion: 1 })).body.error.code).toBe('RUNTIME_UNAVAILABLE')
        expect((await call(h.socketPath, 'POST', '/v1/sessions/bind', h.daemon, { schemaVersion: 1, registrationId, agentSessionId: 'session-1' })).body.error.code).toBe('RUNTIME_UNAVAILABLE')
        expect((await h.grant(sessionSecret)).body.error.code).toBe('RUNTIME_UNAVAILABLE')
        expect((await call(h.socketPath, 'GET', '/v1/attention?afterSeq=0&waitMs=0', h.daemon)).body.error.code).toBe('RUNTIME_UNAVAILABLE')
        expect((await call(h.socketPath, 'GET', '/v1/sessions', h.daemon)).status).toBe(200)
        expect((await call(h.socketPath, 'POST', '/v1/sessions/revoke', h.daemon, { schemaVersion: 1, registrationId })).status).toBe(200)
        open = true
        expect((await h.grant(sessionSecret)).status).toBe(401)
    })

    it("refuses a registration from before owners were recorded (whose owner cannot be told)", async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        await h.close()
        cleanups.splice(cleanups.indexOf(h.close), 1)
        const file = join(h.dir, 'broker-sessions.json')
        const registry = JSON.parse(await readFile(file, 'utf8'))
        for (const registration of Object.values(registry.registrations) as Array<Record<string, unknown>>) delete registration.principals
        await writeFile(file, JSON.stringify(registry))
        const restarted = await harness({ dir: h.dir })
        expect((await restarted.grant(sessionSecret)).body.error.code).toBe('SCOPE_DENIED')
    })

    it('tells the daemon token only whether a session has a task waiting for the user', async () => {
        const asked: string[] = []
        const h = await harness({ sessionWaiting: async (agentSessionId) => { asked.push(agentSessionId); return agentSessionId === 'session-1' } })
        const waiting = (id: string, headers = h.daemon) => call(h.socketPath, 'GET', `/v1/sessions/waiting?agentSessionId=${encodeURIComponent(id)}`, headers)
        expect((await waiting('session-1')).body.result).toEqual({ waiting: true })
        expect((await waiting('session-2')).body.result).toEqual({ waiting: false })
        expect((await waiting('session-1', {} as typeof h.daemon)).status).toBe(401)
        expect((await call(h.socketPath, 'GET', '/v1/sessions/waiting', h.daemon)).status).toBe(400)
        expect(asked).toEqual(['session-1', 'session-2'])
        // A Runtime without the query answers "not waiting", so a host never parks on a guess.
        const plain = await harness()
        expect((await call(plain.socketPath, 'GET', '/v1/sessions/waiting?agentSessionId=session-1', plain.daemon)).body.result).toEqual({ waiting: false })
    })

    it('serves the attention feed to the daemon token only', async () => {
        const h = await harness()
        const { sessionSecret } = await h.register()
        expect((await call(h.socketPath, 'GET', '/v1/attention?afterSeq=0&waitMs=0', { 'x-abp-session-secret': sessionSecret })).status).toBe(401)
        const feed = await call(h.socketPath, 'GET', '/v1/attention?afterSeq=0&waitMs=0', h.daemon)
        expect(feed).toEqual({ status: 200, body: { ok: true, result: { events: [], nextSeq: 0, oldestSeq: 1 } } })
        expect((await call(h.socketPath, 'GET', '/v1/attention?afterSeq=0&waitMs=30001', h.daemon)).status).toBe(400)
    })

    it('creates the socket group-accessible only', async () => {
        const h = await harness()
        expect((await stat(h.socketPath)).mode & 0o777).toBe(0o660)
    })
})
