/** Dead-owner reconciliation using procfs fixtures and the real durable revocation queue. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrokerReply } from '@/browserRuntime/brokerGrantSource'
import type { SessionOwner } from '@/browserRuntime/sessionRegistration'
import { createBrowserTaskSessionBroker, startBrowserTaskReconciliation } from './browserTaskBroker'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(owner?: SessionOwner, agentSessionId?: string, bootId?: string) {
    const dir = await mkdtemp(join(tmpdir(), 'abp-reconcile-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const procRoot = join(dir, 'proc')
    await mkdir(join(procRoot, 'sys/kernel/random'), { recursive: true })
    await writeFile(join(procRoot, 'sys/kernel/random/boot_id'), 'boot-current\n')
    const tokenFile = join(dir, 'token')
    await writeFile(tokenFile, 'daemon-token')
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    let listAvailable = true
    let revokeAvailable = true
    const request = async (_socket: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown): Promise<BrokerReply> => {
        expect(headers).toEqual({ 'x-abp-daemon-token': 'daemon-token' })
        calls.push({ method, path, body })
        if (path === '/v1/sessions') {
            if (!listAvailable) throw new Error('ECONNREFUSED')
            return { status: 200, body: { ok: true, result: [{ registrationId: 'reg-1', agentSessionId, owner, ...(bootId ? { bootId } : {}), createdAtMs: 1, revoking: false }] } }
        }
        if (path === '/v1/sessions/revoke' && !revokeAvailable) throw new Error('ECONNREFUSED')
        return { status: 200, body: { ok: true, result: {} } }
    }
    const pendingRevocationsFile = join(dir, 'pending.json')
    const env = { HAPPY_BROWSER_TASK_BROKER_SOCKET: '/unused.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: tokenFile }
    const options = { procRoot, pendingRevocationsFile, retryBaseMs: 3_600_000 }
    const broker = createBrowserTaskSessionBroker(env, request, options)!
    const processStat = async (pid: number, startTime: string): Promise<string> => {
        await mkdir(join(procRoot, String(pid)), { recursive: true })
        const file = join(procRoot, String(pid), 'stat')
        // field 2 deliberately contains whitespace and parentheses; field 22 is starttime.
        await writeFile(file, `${pid} (happy (session) child) S ${Array(18).fill('0').join(' ')} ${startTime} 0 0\n`)
        return file
    }
    return { broker, calls, procRoot, processStat, pendingRevocationsFile,
        restart: () => createBrowserTaskSessionBroker(env, request, options)!,
        setListAvailable: (value: boolean) => { listAvailable = value },
        setRevokeAvailable: (value: boolean) => { revokeAvailable = value },
        revoked: () => calls.filter((call) => call.path === '/v1/sessions/revoke').map((call) => call.body),
    }
}

const owner: SessionOwner = { bootId: 'boot-current', pid: 123, pidStartTime: '9876543210123456789' }
const revoked = [{ schemaVersion: 1, registrationId: 'reg-1' }]

describe('browser registration reconciliation', () => {
    it('revokes a previous boot even when that pid is alive now', async () => {
        const h = await harness({ ...owner, bootId: 'boot-old' })
        await h.processStat(owner.pid, owner.pidStartTime)
        await h.broker.reconcile()
        expect(h.revoked()).toEqual(revoked)
    })

    it.each(['session-1', undefined])('revokes a missing pid by registration id (bound session: %s)', async (sessionId) => {
        const h = await harness(owner, sessionId)
        await h.broker.reconcile()
        expect(h.revoked()).toEqual(revoked)
    })

    it('revokes a reused pid with a different start time', async () => {
        const h = await harness(owner)
        await h.processStat(owner.pid, '1234')
        await h.broker.reconcile()
        expect(h.revoked()).toEqual(revoked)
    })

    it('keeps a live session across daemon restart', async () => {
        const h = await harness(owner)
        await h.processStat(owner.pid, owner.pidStartTime)
        await h.broker.reconcile()
        await h.restart().reconcile()
        expect(h.revoked()).toEqual([])
    })

    it('keeps legacy registrations with neither an owner nor a registration boot id', async () => {
        const h = await harness()
        await h.broker.reconcile()
        expect(h.revoked()).toEqual([])
    })

    it('revokes an owner-less registration made in a previous boot (no process survives a reboot), whatever the clock says', async () => {
        const h = await harness(undefined, 'session-1', 'boot-old')
        await h.broker.reconcile()
        expect(h.revoked()).toEqual(revoked)
    })

    it('keeps an owner-less registration made in this boot', async () => {
        const h = await harness(undefined, 'session-1', 'boot-current')
        await h.broker.reconcile()
        expect(h.revoked()).toEqual([])
    })

    it('sends the host boot id at registration', async () => {
        const h = await harness()
        await h.broker.register()
        expect(h.calls.find((call) => call.path === '/v1/sessions/register')?.body).toMatchObject({ bootId: 'boot-current' })
    })

    it('attaches the child identity at bind, preserving the stat start time exactly', async () => {
        const h = await harness()
        await h.processStat(owner.pid, owner.pidStartTime)
        expect(await h.broker.bind('reg-1', 'session-1', owner.pid)).toBe(true)
        expect(h.calls.at(-1)?.body).toEqual({ schemaVersion: 1, registrationId: 'reg-1', agentSessionId: 'session-1', owner })
    })

    it.each(['boot-unavailable', 'stat-malformed', 'stat-unreadable'])('keeps ownership when liveness is unknown: %s', async (failure) => {
        const h = await harness(owner)
        const file = await h.processStat(owner.pid, owner.pidStartTime)
        if (failure === 'boot-unavailable') await rm(join(h.procRoot, 'sys/kernel/random/boot_id'))
        if (failure === 'stat-malformed') await writeFile(file, 'invalid stat')
        if (failure === 'stat-unreadable') await chmod(file, 0o000)
        try {
            await expect(h.broker.reconcile()).resolves.toBeUndefined()
            expect(h.revoked()).toEqual([])
        } finally {
            await chmod(file, 0o600)
        }
    })

    it('contains an unavailable broker and retries on the next tick', async () => {
        const h = await harness(owner)
        h.setListAvailable(false)
        const stop = startBrowserTaskReconciliation(h.broker, 20)
        cleanups.push(stop)
        await vi.waitFor(() => expect(h.calls.filter((call) => call.path === '/v1/sessions').length).toBeGreaterThanOrEqual(2))
        expect(h.revoked()).toEqual([])
        h.setListAvailable(true)
        await vi.waitFor(() => expect(h.revoked().length).toBeGreaterThan(0))
        stop()
    })

    it('durably queues an unconfirmed reconciliation revoke and retries it across restart', async () => {
        const h = await harness(owner)
        h.setRevokeAvailable(false)
        await expect(h.broker.reconcile()).resolves.toBeUndefined()
        expect(JSON.parse(await readFile(h.pendingRevocationsFile, 'utf8'))).toEqual({ schemaVersion: 1, pending: [{ registrationId: 'reg-1' }] })
        h.setRevokeAvailable(true)
        expect(await h.restart().retryPendingRevocations()).toBe(0)
        expect(JSON.parse(await readFile(h.pendingRevocationsFile, 'utf8')).pending).toEqual([])
    })
})
