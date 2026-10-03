/** Daemon browser registration, grant revocation retries and resumed-process registration. */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineMetadataSchema } from '@/api/types'
import { PendingRevocationQueueError, agentBrowserMachineCapability, agentBrowserMetadataUpdate, browserTaskLineage, createBrowserTaskSessionBroker, registerResumedBrowserSession, spawnResumedWithBrowserTaskRegistration } from './browserTaskBroker'

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

    it('asks whether a session has a task waiting for the user, and fails rather than guessing when the Runtime does not answer', async () => {
        const { calls, request } = recorder({
            '/v1/sessions/waiting?agentSessionId=session%2F1': { status: 200, body: { ok: true, result: { waiting: true } } },
            '/v1/sessions/waiting?agentSessionId=session-2': { status: 200, body: { ok: true, result: { waiting: false } } },
        })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request, { procRoot: await procRoot() })!
        expect(await broker.waiting('session/1')).toBe(true)
        expect(await broker.waiting('session-2')).toBe(false)
        await expect(broker.waiting('session-3')).rejects.toThrow(/waiting/)
        expect(calls[0]).toMatchObject({ method: 'GET', headers: { 'x-abp-daemon-token': 'synthetic-daemon-token-0123456789abcdef' } })
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
            ['/v1/sessions/revoke', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1, agentSessionId: 'session-1', endSession: false }],
        ])
    })

    it("passes Studio's session-user attestation of a new chat to the broker at registration", async () => {
        const { calls, request } = recorder({ '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-1', sessionSecret: 'secret-1' } } } })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request, { procRoot: await procRoot() })!
        await broker.register(undefined, 'abp2.header.payload.signature')
        expect(calls[0].body).toEqual({ schemaVersion: 1, bootId: 'boot-fixture', attestation: 'abp2.header.payload.signature' })
    })

    it('on resume, first clears any registration still bound to the session (a queued exit revoke included), then registers afresh', async () => {
        const { calls, request } = recorder({
            '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-2', sessionSecret: 'secret-2' } } },
            '/v1/sessions/revoke': { status: 200, body: { ok: true, result: { revoked: true, grants: 0 } } },
        })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request, { procRoot: await procRoot() })!
        expect(await registerResumedBrowserSession(broker, 'session-1')).toEqual({ registrationId: 'reg-2', sessionSecret: 'secret-2' })
        expect(calls.map((call) => [call.path, call.body])).toEqual([
            ['/v1/sessions/revoke', { schemaVersion: 1, agentSessionId: 'session-1', endSession: false }],
            // The session itself is the lineage: only a session the Runtime knows in the current assignment gets a grant again.
            ['/v1/sessions/register', { schemaVersion: 1, bootId: 'boot-fixture', lineage: { parentSessionIds: ['session-1'] } }],
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

describe('fork and recovery lineage', () => {
    it('names the parent session and the provider conversation a spawn continues, and nothing for a fresh one', () => {
        expect(browserTaskLineage({})).toBeUndefined()
        expect(browserTaskLineage({ parentSessionId: 'session-1', resumeClaudeSessionId: 'conv-1' })).toEqual({ parentSessionIds: ['session-1'], conversationIds: ['claude:conv-1'] })
        expect(browserTaskLineage({ resumeCodexThreadId: 'thread-1' })).toEqual({ conversationIds: ['codex:thread-1'] })
    })

    it('sends the lineage with the registration (daemon token), and spawns without a grant when the Runtime refuses it', async () => {
        const { calls, request } = recorder({ '/v1/sessions/register': { status: 403, body: { ok: false, error: { code: 'SCOPE_DENIED', retryable: false } } } })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request, { procRoot: await procRoot() })!
        expect(await broker.register({ parentSessionIds: ['session-1'], conversationIds: ['claude:conv-1'] })).toBeUndefined()
        expect(calls.map((call) => [call.path, call.headers['x-abp-daemon-token'], call.body])).toEqual([['/v1/sessions/register', 'synthetic-daemon-token-0123456789abcdef',
            { schemaVersion: 1, bootId: 'boot-fixture', lineage: { parentSessionIds: ['session-1'], conversationIds: ['claude:conv-1'] } }]])
    })
})

describe('bind while the Runtime holds admission (reassignment being verified)', () => {
    const held = { status: 503, body: { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', retryable: true } } }
    const bound = { status: 200, body: { ok: true, result: { bound: true } } }
    const denied = { status: 403, body: { ok: false, error: { code: 'SCOPE_DENIED', retryable: false } } }
    const revoked = { status: 200, body: { ok: true, result: { revoked: true, grants: 0 } } }
    /** Replies to /v1/sessions/bind in order (the last repeats); every call recorded. */
    async function brokerWith(binds: Array<{ status: number; body: Record<string, unknown> }>, options: { bindRetryDeadlineMs?: number } = {}) {
        const calls: Array<{ path: string; body?: unknown }> = []
        const queue = [...binds]
        const request = async (_socket: string, _method: 'GET' | 'POST', path: string, _headers: Record<string, string>, body?: unknown) => {
            calls.push({ path, body })
            if (path === '/v1/sessions/bind') return queue.length > 1 ? queue.shift()! : queue[0]
            return revoked
        }
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request,
            { procRoot: await procRoot(), bindRetryBaseMs: 5, bindRetryDeadlineMs: options.bindRetryDeadlineMs ?? 60_000 })!
        const paths = () => calls.map((call) => call.path)
        return { broker, calls, paths }
    }

    it('keeps the registration and binds it once admission opens', async () => {
        const h = await brokerWith([held, held, bound])
        expect(await h.broker.bind('reg-1', 'session-1')).toBe(true)
        await vi.waitFor(() => expect(h.paths()).toEqual(['/v1/sessions/bind', '/v1/sessions/bind', '/v1/sessions/bind']))
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(h.paths()).not.toContain('/v1/sessions/revoke')
    })

    it('revokes the registration when the Runtime then denies the bind, or is still closed at the deadline', async () => {
        const deniedLater = await brokerWith([held, denied])
        expect(await deniedLater.broker.bind('reg-1', 'session-1')).toBe(true)
        await vi.waitFor(() => expect(deniedLater.calls.at(-1)).toEqual({ path: '/v1/sessions/revoke', body: { schemaVersion: 1, registrationId: 'reg-1', endSession: false } }))

        const closed = await brokerWith([held], { bindRetryDeadlineMs: 40 })
        expect(await closed.broker.bind('reg-2', 'session-2')).toBe(true)
        await vi.waitFor(() => expect(closed.calls.at(-1)).toEqual({ path: '/v1/sessions/revoke', body: { schemaVersion: 1, registrationId: 'reg-2', endSession: false } }))
        const binds = closed.paths().filter((path) => path === '/v1/sessions/bind').length
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(closed.paths().filter((path) => path === '/v1/sessions/bind')).toHaveLength(binds)
    })

    it('returns false at once for a denial (the caller revokes), and stops retrying when the session ends meanwhile', async () => {
        expect(await (await brokerWith([denied])).broker.bind('reg-1', 'session-1')).toBe(false)

        const h = await brokerWith([held])
        expect(await h.broker.bind('reg-3', 'session-3')).toBe(true)
        await h.broker.revoke({ agentSessionId: 'session-3' })
        expect(h.calls.filter((call) => call.path === '/v1/sessions/revoke').map((call) => call.body)).toEqual([
            { schemaVersion: 1, registrationId: 'reg-3', endSession: false },
            { schemaVersion: 1, agentSessionId: 'session-3', endSession: false },
        ])
        const binds = h.paths().filter((path) => path === '/v1/sessions/bind').length
        await new Promise((resolve) => setTimeout(resolve, 40))
        expect(h.paths().filter((path) => path === '/v1/sessions/bind')).toHaveLength(binds)
    })
})

describe('registration while the Runtime holds admission (start-up, reassignment check)', () => {
    const held = { status: 503, body: { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', retryable: true } } }
    const registered = { status: 200, body: { ok: true, result: { registrationId: 'reg-1', sessionSecret: 'secret-1' } } }
    async function brokerWith(replies: Array<{ status: number; body: Record<string, unknown> }>, registerRetryDeadlineMs = 60_000) {
        const queue = [...replies]
        let registers = 0
        const request = async (_socket: string, _method: 'GET' | 'POST', path: string) => {
            if (path !== '/v1/sessions/register') return { status: 500, body: {} }
            registers++
            return queue.length > 1 ? queue.shift()! : queue[0]
        }
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request,
            { procRoot: await procRoot(), bindRetryBaseMs: 5, registerRetryDeadlineMs })!
        return { broker, registers: () => registers }
    }

    it('waits a bounded time for the hold to end before the spawn goes on', async () => {
        const opens = await brokerWith([held, held, registered])
        expect(await opens.broker.register()).toEqual({ registrationId: 'reg-1', sessionSecret: 'secret-1' })
        expect(opens.registers()).toBe(3)
        const stays = await brokerWith([held], 30)
        expect(await stays.broker.register()).toBeUndefined()
        expect(stays.registers()).toBeGreaterThan(1)
        expect(stays.registers()).toBeLessThan(6)
    })

    it('does not retry a denial', async () => {
        const denied = await brokerWith([{ status: 403, body: { ok: false, error: { code: 'SCOPE_DENIED', retryable: false } } }])
        expect(await denied.broker.register({ parentSessionIds: ['session-1'] })).toBeUndefined()
        expect(denied.registers()).toBe(1)
    })
})

describe('agent browser machine capability (Studio sends attestations only to daemons that report it)', () => {
    it('is reported on an execution machine only, with its tenancy', () => {
        expect(agentBrowserMachineCapability({})).toBeUndefined()
        expect(agentBrowserMachineCapability({ HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700' })).toEqual({ protocol: 2, tenancyMode: 'dedicated' })
        expect(agentBrowserMachineCapability({ HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700', HAPPY_BROWSER_TASK_TENANCY: 'shared' })).toEqual({ protocol: 2, tenancyMode: 'shared' })
        const parsed = MachineMetadataSchema.safeParse({ host: 'h', platform: 'linux', happyCliVersion: '1', homeDir: '/h', happyHomeDir: '/h/.happy', happyLibDir: '/l', agentBrowser: { protocol: 2, tenancyMode: 'shared' } })
        expect(parsed.success && parsed.data.agentBrowser).toEqual({ protocol: 2, tenancyMode: 'shared' })
    })
})

describe('agent browser capability in stored machine metadata (an existing machine keeps what it registered with)', () => {
    const stored: { host: string; agentBrowser?: unknown } = { host: 'h' }
    it('adds the capability the stored metadata lacks, keeping everything else', () => {
        expect(agentBrowserMetadataUpdate(stored, { protocol: 2, tenancyMode: 'shared' })).toEqual({ ...stored, agentBrowser: { protocol: 2, tenancyMode: 'shared' } })
    })
    it('replaces a stale one, removes one this machine no longer has, and leaves current metadata alone', () => {
        expect(agentBrowserMetadataUpdate({ ...stored, agentBrowser: { protocol: 2, tenancyMode: 'dedicated' } }, { protocol: 2, tenancyMode: 'shared' })?.agentBrowser).toEqual({ protocol: 2, tenancyMode: 'shared' })
        expect(agentBrowserMetadataUpdate({ ...stored, agentBrowser: { protocol: 2, tenancyMode: 'shared' } }, undefined)).toEqual(stored)
        expect(agentBrowserMetadataUpdate({ ...stored, agentBrowser: { protocol: 2, tenancyMode: 'shared' } }, { protocol: 2, tenancyMode: 'shared' })).toBeUndefined()
        expect(agentBrowserMetadataUpdate(stored, undefined)).toBeUndefined()
        expect(agentBrowserMetadataUpdate(null, { protocol: 2, tenancyMode: 'shared' })).toBeUndefined()
    })
})
