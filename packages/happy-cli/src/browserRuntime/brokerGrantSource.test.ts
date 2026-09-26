import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError } from './contracts'
import { brokerRequest, createBrokerGrantSource } from './brokerGrantSource'

const SECRET = 'synthetic-session-secret-0123456789abcdef'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A fake broker on a real unix socket; `reply` decides each response. */
async function fakeBroker(reply: (body: Record<string, unknown>, req: IncomingMessage, count: number) => { status: number; body: unknown }) {
    const dir = await mkdtemp(join(tmpdir(), 'abp-grant-source-'))
    const socketPath = join(dir, 'broker.sock')
    const requests: Array<{ path: string; secret: string | undefined; body: Record<string, unknown> }> = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
            const body = JSON.parse(raw || '{}') as Record<string, unknown>
            requests.push({ path: req.url ?? '', secret: req.headers['x-abp-session-secret'] as string | undefined, body })
            const answer = reply(body, req, requests.length)
            res.writeHead(answer.status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(answer.body))
        })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    cleanups.push(() => rm(dir, { recursive: true, force: true }), () => new Promise((resolve) => server.close(resolve)))
    return { socketPath, requests }
}

const ok = (token: string, expiresAtMs: number) => ({ status: 200, body: { ok: true, result: { token, grantId: `g-${token}`, expiresAtMs } } })

describe('broker grant source', () => {
    it('requests a grant for this session and profile with the session secret, and caches it', async () => {
        let now = 1_000_000
        const broker = await fakeBroker((_body, _req, count) => ok(`t${count}`, 1_000_000 + 55 * 60_000))
        const token = createBrokerGrantSource({ socketPath: broker.socketPath, sessionSecret: SECRET, agentSessionId: () => 'session-1', profileId: 'profile-a', now: () => now })
        expect(await token()).toBe('t1')
        now += 49 * 60_000
        expect(await token()).toBe('t1')
        expect(broker.requests).toEqual([{ path: '/v1/agent-grants', secret: SECRET, body: { schemaVersion: 1, agentSessionId: 'session-1', profileId: 'profile-a' } }])
    })

    it('renews five minutes before expiry, once for concurrent callers', async () => {
        let now = 1_000_000
        const broker = await fakeBroker((_body, _req, count) => ok(`t${count}`, now + 55 * 60_000))
        const token = createBrokerGrantSource({ socketPath: broker.socketPath, sessionSecret: SECRET, agentSessionId: () => 'session-1', profileId: 'profile-a', now: () => now })
        await token()
        now += 50 * 60_000
        expect(await Promise.all([token(), token(), token()])).toEqual(['t2', 't2', 't2'])
        expect(broker.requests).toHaveLength(2)
    })

    it('waits while the daemon has not bound the session yet', async () => {
        const broker = await fakeBroker((_body, _req, count) => count < 3
            ? { status: 409, body: { ok: false, error: { code: 'CONFLICT', message: 'not bound', retryable: true, mayHaveSideEffects: false } } }
            : ok('t3', Date.now() + 55 * 60_000))
        const token = createBrokerGrantSource({ socketPath: broker.socketPath, sessionSecret: SECRET, agentSessionId: () => 'session-1', profileId: 'profile-a', retryDelaysMs: [1, 1, 1] })
        expect(await token()).toBe('t3')
    })

    it('fails closed as UNAUTHORIZED after a revoke, without echoing the secret', async () => {
        const broker = await fakeBroker(() => ({ status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'session is not registered', retryable: false, mayHaveSideEffects: false } } }))
        const token = createBrokerGrantSource({ socketPath: broker.socketPath, sessionSecret: SECRET, agentSessionId: () => 'session-1', profileId: 'profile-a' })
        const error = await token().catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(BrowserRuntimeError)
        expect(error).toMatchObject({ code: 'UNAUTHORIZED' })
        expect(String((error as Error).message)).not.toContain(SECRET)
    })

    it('reports an unreachable broker as UNAUTHORIZED grant unavailability', async () => {
        const token = createBrokerGrantSource({ socketPath: join(tmpdir(), 'abp-no-such-broker.sock'), sessionSecret: SECRET, agentSessionId: () => 'session-1', profileId: 'profile-a', retryDelaysMs: [] })
        await expect(token()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it('exposes a daemon-side request helper that sends the daemon token', async () => {
        const broker = await fakeBroker((_body, req) => ({ status: 200, body: { ok: true, result: { seen: req.headers['x-abp-daemon-token'] } } }))
        expect(await brokerRequest(broker.socketPath, 'POST', '/v1/sessions/register', { 'x-abp-daemon-token': 'synthetic' }, { schemaVersion: 1 }))
            .toEqual({ status: 200, body: { ok: true, result: { seen: 'synthetic' } } })
    })
})
