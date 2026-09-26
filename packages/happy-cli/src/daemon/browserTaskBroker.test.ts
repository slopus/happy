import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PendingRevocationQueueError, createBrowserTaskSessionBroker, registerResumedBrowserSession, spawnResumedWithBrowserTaskRegistration } from './browserTaskBroker'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** procfs fixture with a known boot id, so register() sends the same body on every host. */
async function procRoot(bootId = 'boot-fixture'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-proc-')); dirs.push(dir)
    mkdirSync(join(dir, 'sys/kernel/random'), { recursive: true })
    writeFileSync(join(dir, 'sys/kernel/random/boot_id'), `${bootId}\n`)
    return dir
}

async function tokenFile(content = 'synthetic-daemon-token-0123456789abcdef\n'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-broker-')); dirs.push(dir)
    const file = join(dir, 'daemon-token')
    await writeFile(file, content, { mode: 0o400 })
    return file
}

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown }
function recorder(replies: Record<string, { status: number; body: Record<string, unknown> }>) {
    const calls: Call[] = []
    const request = async (_socket: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown) => {
        calls.push({ method, path, headers, body })
        return replies[path] ?? { status: 500, body: {} }
    }
    return { calls, request }
}

describe('daemon browser task broker hook', () => {
    it('is off unless the machine is configured with a broker socket and a readable daemon token', async () => {
        expect(createBrowserTaskSessionBroker({})).toBeUndefined()
        expect(createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: '/nonexistent' })).toBeUndefined()
        expect(createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() })).toBeDefined()
    })

    it('registers at spawn, binds the reported session id, and revokes it at exit with the daemon token', async () => {
        const { calls, request } = recorder({
            '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-1', sessionSecret: 'secret-1' } } },
            '/v1/sessions/bind': { status: 200, body: { ok: true, result: { bound: true } } },
            '/v1/sessions/revoke': { status: 200, body: { ok: true, result: { revoked: true, grants: 2 } } },
        })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request, { procRoot: await procRoot() })!
        expect(await broker.register()).toEqual({ registrationId: 'reg-1', sessionSecret: 'secret-1' })
        expect(await broker.bind('reg-1', 'session-1')).toBe(true)
        await broker.revoke({ agentSessionId: 'session-1' })
        expect(calls.map((call) => [call.path, call.headers['x-abp-daemon-token'], call.body])).toEqual([
            ['/v1/sessions/register', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1, bootId: 'boot-fixture' }],
            ['/v1/sessions/bind', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1, registrationId: 'reg-1', agentSessionId: 'session-1' }],
            ['/v1/sessions/revoke', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1, agentSessionId: 'session-1' }],
        ])
    })

    it('on resume, first clears any registration still bound to the session (a queued exit revoke included), then registers afresh', async () => {
        const { calls, request } = recorder({
            '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-2', sessionSecret: 'secret-2' } } },
            '/v1/sessions/revoke': { status: 200, body: { ok: true, result: { revoked: true, grants: 0 } } },
        })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request, { procRoot: await procRoot() })!
        expect(await registerResumedBrowserSession(broker, 'session-1')).toEqual({ registrationId: 'reg-2', sessionSecret: 'secret-2' })
        expect(calls.map((call) => [call.path, call.body])).toEqual([
            ['/v1/sessions/revoke', { schemaVersion: 1, agentSessionId: 'session-1' }],
            ['/v1/sessions/register', { schemaVersion: 1, bootId: 'boot-fixture' }],
        ])
    })

    it('on resume, registers nothing while a revocation for that session is unconfirmed (it would later revoke the new binding)', async () => {
        const { calls, request } = recorder({
            '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-2', sessionSecret: 'secret-2' } } },
        })
        const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-queue-')); dirs.push(dir)
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request,
            { procRoot: await procRoot(), pendingRevocationsFile: join(dir, 'pending.json'), retryBaseMs: 3_600_000 })!
        expect(await registerResumedBrowserSession(broker, 'session-1')).toBeUndefined()
        expect(calls.map((call) => call.path)).toEqual(['/v1/sessions/revoke'])
    })

    it('spawns without browser grants when registration fails, instead of failing the spawn', async () => {
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() },
            async () => { throw new Error('ECONNREFUSED') })!
        expect(await broker.register()).toBeUndefined()
        expect(await broker.bind('reg-1', 'session-1')).toBe(false)
        await expect(broker.revoke({ registrationId: 'reg-1' })).resolves.toBeUndefined()
    })

    it('keeps a failed revocation on disk and retries it until the Runtime confirms', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-broker-')); dirs.push(dir)
        const pendingRevocationsFile = join(dir, 'pending.json')
        let reachable = false
        const paths: string[] = []
        const request = async (_socket: string, _method: 'GET' | 'POST', path: string) => {
            paths.push(path)
            if (!reachable) throw new Error('ECONNREFUSED')
            return { status: 200, body: { ok: true, result: { revoked: true, grants: 1 } } }
        }
        const env = { HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }
        const broker = createBrowserTaskSessionBroker(env, request, { pendingRevocationsFile, retryBaseMs: 3_600_000 })!
        await broker.revoke({ agentSessionId: 'session-1' })
        expect(JSON.parse(await readFile(pendingRevocationsFile, 'utf8'))).toEqual({ schemaVersion: 1, pending: [{ agentSessionId: 'session-1' }] })
        expect(await broker.retryPendingRevocations()).toBe(1)

        // A daemon restart picks the pending revocation up from disk.
        reachable = true
        const restarted = createBrowserTaskSessionBroker(env, request, { pendingRevocationsFile, retryBaseMs: 3_600_000 })!
        expect(await restarted.retryPendingRevocations()).toBe(0)
        expect(JSON.parse(await readFile(pendingRevocationsFile, 'utf8')).pending).toEqual([])
        expect(paths.filter((path) => path === '/v1/sessions/revoke').length).toBeGreaterThanOrEqual(3)
    })

    it('retries a revocation the Runtime could not finish (503) but drops one it rejects as invalid', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-broker-')); dirs.push(dir)
        const error = (code: string) => ({ ok: false, error: { code, message: '', retryable: false, mayHaveSideEffects: false } }) as never
        const replies = [{ status: 503, body: error('RUNTIME_UNAVAILABLE') }, { status: 400, body: error('INVALID_REQUEST') }]
        const request = async () => replies.shift() ?? { status: 200, body: { ok: true, result: {} } as never }
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() },
            request, { pendingRevocationsFile: join(dir, 'pending.json'), retryBaseMs: 3_600_000 })!
        await broker.revoke({ registrationId: 'reg-1' })
        expect(await broker.retryPendingRevocations()).toBe(0)
    })
})

describe('daemon pending revocation queue', () => {
    const env = async () => ({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() })
    const queueDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-queue-')); dirs.push(dir); return dir }
    const unreachable = async (): Promise<never> => { throw new Error('ECONNREFUSED') }
    const confirmed = async () => ({ status: 200, body: { ok: true, result: { revoked: true, grants: 1 } } as never })

    it('surfaces a revocation that was neither confirmed nor saved (ENOSPC) and saves it on the next retry', async () => {
        const file = join(await queueDir(), 'pending.json')
        let full = true
        const writes: string[] = []
        const broker = createBrowserTaskSessionBroker(await env(), unreachable, { pendingRevocationsFile: file, retryBaseMs: 3_600_000,
            writeQueueFile: (path, data) => {
                if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
                writes.push(data)
                writeFileSync(path, data)
            } })!
        await expect(broker.revoke({ agentSessionId: 'session-1' })).rejects.toThrow(/neither confirmed nor saved/)
        full = false
        expect(await broker.retryPendingRevocations()).toBe(1)
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 1, pending: [{ agentSessionId: 'session-1' }] })
        const restarted = createBrowserTaskSessionBroker(await env(), confirmed, { pendingRevocationsFile: file, retryBaseMs: 3_600_000 })!
        expect(await restarted.retryPendingRevocations()).toBe(0)
        expect(JSON.parse(readFileSync(file, 'utf8')).pending).toEqual([])
    })

    it.each([
        ['malformed JSON', (file: string) => writeFileSync(file, '{"schemaVersion":1,"pending":[')],
        ['an unsupported schema', (file: string) => writeFileSync(file, JSON.stringify({ schemaVersion: 2, pending: [] }))],
        ['an invalid entry', (file: string) => writeFileSync(file, JSON.stringify({ schemaVersion: 1, pending: [{ sessionId: 'x' }] }))],
        ['an unreadable path', (file: string) => mkdirSync(file)],
    ])('fails closed on %s instead of treating the queue as empty, and leaves the file alone', async (_label, corrupt) => {
        const file = join(await queueDir(), 'pending.json')
        corrupt(file)
        const before = statSync(file).isDirectory() ? 'dir' : readFileSync(file, 'utf8')
        const configured = await env()
        expect(() => createBrowserTaskSessionBroker(configured, confirmed, { pendingRevocationsFile: file })).toThrow(PendingRevocationQueueError)
        expect(statSync(file).isDirectory() ? 'dir' : readFileSync(file, 'utf8')).toBe(before)
    })

    it('ignores a temp file a crash left before its rename and never overwrites it', async () => {
        const dir = await queueDir()
        const file = join(dir, 'pending.json')
        writeFileSync(file, JSON.stringify({ schemaVersion: 1, pending: [{ registrationId: 'reg-1' }] }))
        const leftover = join(dir, '.pending.json.crashed.tmp')
        writeFileSync(leftover, 'half-written')
        const broker = createBrowserTaskSessionBroker(await env(), unreachable, { pendingRevocationsFile: file, retryBaseMs: 3_600_000 })!
        await broker.revoke({ agentSessionId: 'session-2' })
        expect(JSON.parse(readFileSync(file, 'utf8')).pending).toEqual([{ registrationId: 'reg-1' }, { agentSessionId: 'session-2' }])
        expect(readFileSync(leftover, 'utf8')).toBe('half-written')
        expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(['.pending.json.crashed.tmp'])
    })
})

describe('resumed session browser task registration', () => {
    const replies = {
        '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-2', sessionSecret: 'secret-2' } } },
        '/v1/sessions/bind': { status: 200, body: { ok: true, result: { bound: true } } },
        '/v1/sessions/revoke': { status: 200, body: { ok: true, result: { revoked: true, grants: 0 } } },
    }
    async function resumeBroker() {
        const { calls, request } = recorder(replies)
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request)!
        return { broker, paths: () => calls.map((call) => [call.path, (call.body as Record<string, unknown>).registrationId, (call.body as Record<string, unknown>).agentSessionId]) }
    }

    it('gives the resumed session process a fresh secret and binds it to the resumed session id', async () => {
        const { broker, paths } = await resumeBroker()
        const spawned: Record<string, string>[] = []
        const result = await spawnResumedWithBrowserTaskRegistration({
            broker, agentSessionId: 'session-1', env: { APLUS_SESSION_ID: 'session-1' },
            spawn: async (env) => { spawned.push(env); return { type: 'success', sessionId: 'session-1' } },
            ownerPid: () => undefined, onRevokeFailure: () => {},
        })
        expect(result).toEqual({ type: 'success', sessionId: 'session-1' })
        expect(spawned).toEqual([{ APLUS_SESSION_ID: 'session-1', HAPPY_BROWSER_TASK_SESSION_SECRET: 'secret-2' }])
        expect(paths()).toEqual([['/v1/sessions/revoke', undefined, 'session-1'], ['/v1/sessions/register', undefined, undefined], ['/v1/sessions/bind', 'reg-2', 'session-1']])
    })

    it('revokes the registration when the resume spawn fails or throws', async () => {
        const failed = await resumeBroker()
        await spawnResumedWithBrowserTaskRegistration({
            broker: failed.broker, agentSessionId: 'session-1', env: {},
            spawn: async () => ({ type: 'error', errorMessage: 'no pid' }),
            ownerPid: () => undefined, onRevokeFailure: () => {},
        })
        expect(failed.paths()).toEqual([['/v1/sessions/revoke', undefined, 'session-1'], ['/v1/sessions/register', undefined, undefined], ['/v1/sessions/revoke', 'reg-2', undefined]])

        const thrown = await resumeBroker()
        await expect(spawnResumedWithBrowserTaskRegistration({
            broker: thrown.broker, agentSessionId: 'session-1', env: {},
            spawn: async () => { throw new Error('spawn failed') },
            ownerPid: () => undefined, onRevokeFailure: () => {},
        })).rejects.toThrow('spawn failed')
        expect(thrown.paths()).toEqual([['/v1/sessions/revoke', undefined, 'session-1'], ['/v1/sessions/register', undefined, undefined], ['/v1/sessions/revoke', 'reg-2', undefined]])
    })

    it('resumes without a secret while the earlier revocation of that session is unconfirmed', async () => {
        const { calls, request } = recorder({ '/v1/sessions/register': replies['/v1/sessions/register'] })
        const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-queue-')); dirs.push(dir)
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request,
            { pendingRevocationsFile: join(dir, 'pending.json'), retryBaseMs: 3_600_000 })!
        const spawned: Record<string, string>[] = []
        await spawnResumedWithBrowserTaskRegistration({
            broker, agentSessionId: 'session-1', env: { APLUS_SESSION_ID: 'session-1' },
            spawn: async (env) => { spawned.push(env); return { type: 'success', sessionId: 'session-1' } },
            ownerPid: () => undefined, onRevokeFailure: () => {},
        })
        expect(spawned).toEqual([{ APLUS_SESSION_ID: 'session-1' }])
        expect(calls.map((call) => call.path)).toEqual(['/v1/sessions/revoke'])
    })

    it('resumes without a secret when the machine has no broker', async () => {
        const spawned: Record<string, string>[] = []
        await spawnResumedWithBrowserTaskRegistration({
            broker: undefined, agentSessionId: 'session-1', env: { APLUS_SESSION_ID: 'session-1' },
            spawn: async (env) => { spawned.push(env); return { type: 'success', sessionId: 'session-1' } },
            ownerPid: () => undefined, onRevokeFailure: () => {},
        })
        expect(spawned).toEqual([{ APLUS_SESSION_ID: 'session-1' }])
    })
})
