import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AuthContext, type BrowserRuntimeApi, type TaskEvent, type TaskView } from './contracts'
import { startRuntimeServer, type RuntimeServer } from './server'

const TOKEN = 'secret-agent-token-123'

function task(): TaskView {
    return {
        schemaVersion: 1, taskId: 't1', taskSpaceId: 's1', profileId: 'p1', agentSessionId: 'a1', status: 'running',
        cancelRequested: false, stateVersion: 1, highWatermarkSeq: 0, tabs: [], uncertainActions: [], createdAtMs: 0, updatedAtMs: 0,
    } as unknown as TaskView
}

function makeFake() {
    const calls: Array<{ op: string; auth: AuthContext; req: unknown; opts?: unknown }> = []
    const events: TaskEvent[] = []
    const waiters: Array<() => void> = []
    const record = (op: string) => async (auth: AuthContext, req: unknown, opts?: unknown) => {
        calls.push({ op, auth, req, opts })
        if (op === 'getTask' && (req as { taskId: string }).taskId === 'conflict') throw new BrowserRuntimeError('STALE_LEASE', 'stale')
        if (op === 'getTask' && (req as { taskId: string }).taskId === 'boom') throw new Error(`internal ${TOKEN}`)
        if (op === 'subscribe') {
            const after = (req as { afterSeq: number }).afterSeq
            const evs = events.filter((e) => e.seq > after)
            return { kind: 'events', events: evs, highWatermarkSeq: events.length }
        }
        return task()
    }
    const ops = ['createSpace', 'createTask', 'openPage', 'closePage', 'observe', 'screenshot', 'submitBatch', 'finishTask', 'getTask',
        'subscribe', 'approve', 'takeOver', 'releaseControl', 'resume', 'cancel', 'closeSpace']
    const api = Object.fromEntries(ops.map((op) => [op, record(op)])) as unknown as Omit<BrowserRuntimeApi, 'waitForEvents'> & {
        waitForEvents(taskId: string, afterSeq: number, waitMs: number): Promise<void>
    }
    api.waitForEvents = (_taskId, afterSeq, waitMs) => new Promise<void>((resolve) => {
        if (events.some((e) => e.seq > afterSeq)) return resolve()
        const t = setTimeout(resolve, waitMs)
        waiters.push(() => { clearTimeout(t); resolve() })
    })
    const push = () => {
        events.push({ schemaVersion: 1, taskId: 't1', seq: events.length + 1, type: 'state-changed', atMs: 0, stateVersion: 1, leaseEpoch: 0, data: {} } as unknown as TaskEvent)
        waiters.splice(0).forEach((w) => w())
    }
    return { api, calls, push }
}

const verifyToken = (bearer: string): AuthContext => {
    if (bearer !== TOKEN) throw new BrowserRuntimeError('UNAUTHORIZED', 'bad token')
    return { credential: { kind: 'agent-grant' } as AuthContext['credential'], verifiedAtMs: 1 }
}

let server: RuntimeServer | undefined
afterEach(async () => { await server?.close(); server = undefined })

async function start() {
    const fake = makeFake()
    server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({ writer: true }) })
    return { ...fake, base: server.url }
}

async function post(base: string, op: string, body: unknown, token: string | null = TOKEN) {
    const res = await fetch(`${base}/v1/ops/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, json: JSON.parse(text) }
}

describe('runtime HTTP server', () => {
    it('keeps an idle keep-alive connection open well past client pool idle times, so a reused socket is not closed under a mutation', async () => {
        const { base } = await start()
        const socket = connect(Number(new URL(base).port), '127.0.0.1')
        const replies: string[] = []
        let buffer = ''
        socket.on('data', (chunk) => { buffer += chunk.toString(); if (buffer.includes('\r\n\r\n')) { replies.push(buffer); buffer = '' } })
        const closed = new Promise<boolean>((resolve) => socket.on('close', () => resolve(true)))
        const request = 'GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n'
        socket.write(request)
        await new Promise((r) => setTimeout(r, 8_000))
        const stillOpen = await Promise.race([closed, Promise.resolve(false)])
        socket.destroy()
        expect(replies[0]).toMatch(/^HTTP\/1\.1 200/)
        expect(stillOpen, 'the server closed an idle keep-alive connection within 8 s').toBe(false)
    }, 15_000)

    it('serves health without auth', async () => {
        const { base } = await start()
        const res = await fetch(`${base}/v1/health`)
        expect(await res.json()).toEqual({ ok: true, writer: true })
    })

    it('requires a valid bearer token on every operation', async () => {
        const { base, calls } = await start()
        for (const op of ['createSpace', 'getTask', 'approve', 'cancel', 'subscribe']) {
            const missing = await post(base, op, {}, null)
            expect(missing.status).toBe(401)
            expect(missing.json.error.code).toBe('UNAUTHORIZED')
            const wrong = await post(base, op, {}, 'nope')
            expect(wrong.status).toBe(401)
        }
        expect(calls).toHaveLength(0)
    })

    it('passes the verified auth context and request to the api', async () => {
        const { base, calls } = await start()
        const res = await post(base, 'getTask', { taskId: 't1' })
        expect(res.status).toBe(200)
        expect(res.json.ok).toBe(true)
        expect(res.json.result.taskId).toBe('t1')
        expect(calls[0]).toMatchObject({ op: 'getTask', req: { taskId: 't1' }, auth: { verifiedAtMs: 1 } })
    })

    it('rejects malformed bodies and unknown fields with 400 INVALID_REQUEST without calling the api', async () => {
        const { base, calls } = await start()
        for (const [op, body] of [['getTask', '{not json'], ['getTask', {}], ['getTask', { taskId: 't1', extra: 1 }],
            ['submitBatch', { taskId: 't', expectedVersion: 1, requestId: 'r', steps: [], waitMs: 999999 }]] as const) {
            const res = await post(base, op, body)
            expect(res.status).toBe(400)
            expect(res.json.error.code).toBe('INVALID_REQUEST')
        }
        const unknownOp = await post(base, 'evaluate', {})
        expect(unknownOp.status).toBe(404)
        expect(calls).toHaveLength(0)
    })

    it('forwards submitBatch waitMs as an option, not as part of the request', async () => {
        const { base, calls } = await start()
        const steps = [{ stepId: 's', actionId: 'a', tabId: 'tb', kind: 'navigate', timeoutMs: 1000, url: 'http://a.poc-one.test/' }]
        const res = await post(base, 'submitBatch', { taskId: 't', expectedVersion: 1, requestId: 'r', steps, waitMs: 5000 })
        expect(res.status).toBe(200)
        expect(calls[0].req).toEqual({ taskId: 't', expectedVersion: 1, requestId: 'r', steps })
        expect(calls[0].opts).toEqual({ waitMs: 5000 })
    })

    it('passes a click step\'s snapshotId through so the Runtime can check the ref against the snapshot it came from', async () => {
        const { base, calls } = await start()
        const steps = [{ stepId: 's', actionId: 'a', tabId: 'tb', kind: 'click', timeoutMs: 1000, ref: '@e2', snapshotId: 'snap-1' }]
        const res = await post(base, 'submitBatch', { taskId: 't', expectedVersion: 1, requestId: 'r', steps })
        expect(res.status).toBe(200)
        expect((calls[0].req as { steps: unknown[] }).steps).toEqual(steps)
    })

    it('maps runtime errors to HTTP statuses and never echoes the token', async () => {
        const { base } = await start()
        const stale = await post(base, 'getTask', { taskId: 'conflict' })
        expect(stale.status).toBe(409)
        expect(stale.json.error).toEqual({ code: 'STALE_LEASE', message: 'stale', retryable: false, mayHaveSideEffects: false })
        const boom = await post(base, 'getTask', { taskId: 'boom' })
        expect(boom.status).toBe(500)
        expect(boom.text).not.toContain(TOKEN)
    })

    it('subscribe long-poll returns early when a new event arrives', async () => {
        const { base, push } = await start()
        const started = Date.now()
        setTimeout(push, 100)
        const res = await post(base, 'subscribe', { taskId: 't1', afterSeq: 0, waitMs: 10_000 })
        expect(Date.now() - started).toBeLessThan(3000)
        expect(res.json.result.events).toHaveLength(1)
    })

    it('subscribe returns immediately when events already exist', async () => {
        const { base, push } = await start()
        push()
        const started = Date.now()
        const res = await post(base, 'subscribe', { taskId: 't1', afterSeq: 0, waitMs: 10_000 })
        expect(Date.now() - started).toBeLessThan(1000)
        expect(res.json.result.events).toHaveLength(1)
    })

    it('serves the console page', async () => {
        const { base } = await start()
        const res = await fetch(`${base}/console`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        // The capability is kept in memory only (fragment hand-off, D12).
        expect(html).not.toContain('sessionStorage')
        expect(html).not.toContain('localStorage')
        expect(html).toContain('abp-capability-request')
    })
})

describe('runtime readiness', () => {
    it('reports 200 when every check passes and 503 with the failing checks otherwise', async () => {
        let checks = { browsers: true, writerLock: true, disk: true }
        const fake = makeFake()
        server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), ready: async () => checks })
        const ready = await fetch(`${server.url}/v1/ready`)
        expect([ready.status, await ready.json()]).toEqual([200, { ok: true, ready: true, checks }])
        checks = { browsers: true, writerLock: false, disk: true }
        const notReady = await fetch(`${server.url}/v1/ready`)
        expect([notReady.status, await notReady.json()]).toEqual([503, { ok: false, ready: false, checks }])
    })
})

describe('viewer ticket route (D2)', () => {
    it('issues a ticket through the viewer service with the verified auth and a validated body', async () => {
        const fake = makeFake()
        const issued: Array<{ auth: AuthContext; req: unknown }> = []
        const viewer = {
            issueTicket: (auth: AuthContext, req: { profileId: string }) => { issued.push({ auth, req }); return { ticket: 'tk', expiresAtMs: 42 } },
            handleUpgrade: () => undefined,
            close: async () => undefined,
        }
        server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), viewer })
        const ok = await post(server.url, 'viewerTicket', { profileId: 'p1' })
        expect([ok.status, ok.json.result]).toEqual([200, { ticket: 'tk', expiresAtMs: 42 }])
        expect(issued).toEqual([{ auth: { credential: { kind: 'agent-grant' }, verifiedAtMs: 1 }, req: { profileId: 'p1' } }])
        expect((await post(server.url, 'viewerTicket', { profileId: 'p1', extra: true })).status).toBe(400)
        expect((await post(server.url, 'viewerTicket', { profileId: 'p1' }, null)).status).toBe(401)
        expect(issued).toHaveLength(1)
    })

    it('answers 503 when the Runtime has no viewer configured', async () => {
        const { base } = await start()
        const res = await post(base, 'viewerTicket', { profileId: 'p1' })
        expect([res.status, res.json.error.code]).toEqual([503, 'RUNTIME_UNAVAILABLE'])
    })
})

describe('viewer client assets (D2)', () => {
    it('serves the pinned noVNC files under /viewer/ with a same-origin CSP and nothing outside its directory', async () => {
        const root = mkdtempSync(join(tmpdir(), 'abp-viewer-assets-'))
        const outside = mkdtempSync(join(tmpdir(), 'abp-viewer-outside-'))
        try {
            mkdirSync(join(root, 'core'))
            writeFileSync(join(root, 'vnc_lite.html'), '<title>noVNC</title>')
            writeFileSync(join(root, 'core', 'rfb.js'), 'export default 1')
            writeFileSync(join(root, 'notes.txt'), 'x')
            writeFileSync(join(outside, 'secret.js'), 'secret')
            symlinkSync(join(outside, 'secret.js'), join(root, 'escape.js'))
            const fake = makeFake()
            server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), viewerAssetsDir: root })
            const page = await fetch(`${server.url}/viewer/`)
            expect([page.status, await page.text()]).toEqual([200, '<title>noVNC</title>'])
            expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
            expect(page.headers.get('x-content-type-options')).toBe('nosniff')
            const script = await fetch(`${server.url}/viewer/core/rfb.js`)
            expect([script.status, script.headers.get('content-type')]).toEqual([200, 'text/javascript; charset=utf-8'])
            for (const path of ['/viewer/escape.js', '/viewer/notes.txt', '/viewer/..%2f..%2fetc%2fpasswd', '/viewer/core/..%2f..%2fserver.js', '/viewer/missing.js', '/viewer/core']) {
                expect((await fetch(`${server.url}${path}`)).status, path).toBe(404)
            }
        } finally {
            rmSync(root, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })

    it('answers 404 under /viewer/ when no assets directory is configured', async () => {
        const { base } = await start()
        expect((await fetch(`${base}/viewer/`)).status).toBe(404)
    })
})

describe('malformed request targets (D2 review P0-4)', () => {
    /** Sends raw bytes and resolves with whatever comes back before the socket closes (or 2 s). */
    function rawRequest(port: number, request: string): Promise<string> {
        return new Promise((resolve) => {
            const socket = connect(port, '127.0.0.1', () => socket.write(request))
            let response = ''
            socket.on('data', (chunk) => { response += chunk.toString('latin1') })
            socket.on('error', () => undefined)
            socket.on('close', () => resolve(response))
            setTimeout(() => { socket.destroy(); resolve(response) }, 2_000)
        })
    }

    it('refuses an unparsable upgrade or request URL and keeps serving', async () => {
        const fake = makeFake()
        const upgrades: string[] = []
        const viewer = { issueTicket: () => ({ ticket: 't', expiresAtMs: 1 }), handleUpgrade: (req: { url?: string }) => { upgrades.push(req.url ?? '') }, close: async () => undefined }
        server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), viewer })
        const upgrade = await rawRequest(server.port, 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n')
        expect(upgrade).toMatch(/^HTTP\/1.1 400/)
        const plain = await rawRequest(server.port, 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
        expect(plain).toMatch(/^HTTP\/1.1 400/)
        expect(upgrades).toEqual([])
        expect((await fetch(`${server.url}/v1/health`)).status).toBe(200)
    })

    it('contains a throwing upgrade handler to its own socket', async () => {
        const fake = makeFake()
        const viewer = { issueTicket: () => ({ ticket: 't', expiresAtMs: 1 }), handleUpgrade: () => { throw new Error('viewer bug') }, close: async () => undefined }
        server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), viewer })
        const response = await rawRequest(server.port, 'GET /v1/viewer/websockify?ticket=x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        expect(response).toMatch(/^(HTTP\/1.1 400|)$/m)
        expect((await fetch(`${server.url}/v1/health`)).status).toBe(200)
    })
})
