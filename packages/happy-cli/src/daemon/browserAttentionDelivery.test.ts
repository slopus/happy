import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeBase64, decrypt } from '@/api/encryption'
import { AttentionOutbox } from '@/browserRuntime/attention'
import { startBroker, type Broker } from '@/browserRuntime/broker'
import type { AttentionEvent } from '@/browserRuntime/contracts'
import { TaskStore, type StoredTask } from '@/browserRuntime/taskStore'
import { readDaemonState, writeDaemonState } from '@/persistence'
import { BrowserAttentionWatcher, createAttentionCursorStore } from './browserAttentionWatcher'
import { deliverBrowserAttention, findBrowserAttentionSession, pollBrowserAttention, startBrowserAttentionWatcher } from './browserAttentionDelivery'
import { mergeTrackedSessionWebhook } from './persistedSessionHydration'
import type { TrackedSession } from './types'

const event: AttentionEvent = { seq: 1, taskId: 'task-1' as never, agentSessionId: 'session-1' as never, status: 'paused', eventSeq: 2, reason: 'approval-approved' }
const encryption = { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 0, agentStateVersion: 0 }
const session: TrackedSession = { startedBy: 'daemon', happySessionId: 'session-1', pid: 123, encryption }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), 'abp-deliver-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir }
async function listen(server: Server) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address')
    return `http://127.0.0.1:${address.port}`
}

describe('attention delivery over the existing encrypted server path', () => {
    it.each(['legacy', 'dataKey'] as const)('posts only PoC text with stable localId and validates ack (%s)', async variant => {
        let acknowledge = false; const requests: unknown[] = []
        const serverUrl = await listen(createServer(async (req, res) => {
            let raw = ''; for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw); requests.push(body)
            expect(req.url).toBe('/v3/sessions/session-1/messages')
            expect(req.headers.authorization).toBe('Bearer synthetic-account-token')
            const message = body.messages[0]
            expect(message.localId).toBe('abp-task-1-2')
            expect(decrypt(encryption.encryptionKey, variant, decodeBase64(message.content))).toEqual({
                role: 'user', content: { type: 'text', text: '[agent-browser] task task-1 status=paused eventSeq=2. Call getTask for the current state before continuing.' },
                localKey: 'abp-task-1-2', meta: { sentFrom: 'daemon', source: 'agent-browser' },
            })
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ messages: acknowledge ? [{ id: 'm1', localId: message.localId, seq: 1 }] : [] }))
        }))
        const options = { serverUrl, findSession: () => ({ ...session, encryption: { ...encryption, encryptionVariant: variant } }), isAlive: () => true, readToken: async () => 'synthetic-account-token' }
        await expect(deliverBrowserAttention(event, new AbortController().signal, options)).rejects.toThrow('acknowledgement')
        acknowledge = true
        await expect(deliverBrowserAttention(event, new AbortController().signal, options)).resolves.toBe('sent')
        expect(requests).toHaveLength(2)
    })

    it('skips ended/unowned sessions and retries missing encryption or credentials without posting', async () => {
        let tracked: TrackedSession | undefined = session; let alive = false
        const options = { serverUrl: 'http://127.0.0.1:1', findSession: () => tracked, isAlive: () => alive, readToken: async () => null }
        const deliver = () => deliverBrowserAttention(event, new AbortController().signal, options)
        expect(await deliver()).toBe('ended')
        tracked = undefined; expect(await deliver()).toBe('unowned')
        tracked = { ...session, startedBy: 'happy directly - likely by user from terminal' }; alive = true
        expect(await deliver()).toBe('unowned')
        tracked = { ...session, encryption: undefined }; await expect(deliver()).rejects.toThrow('encryption')
        tracked = session; await expect(deliver()).rejects.toThrow('credential')
    })

    it.each([false, true])('retries attention between resume spawn and webhook (daemon restart: %s)', async restart => {
        const dir = await tempDir(); const cursorFile = join(dir, 'cursor.json')
        let requests = 0
        const serverUrl = await listen(createServer(async (req, res) => {
            let raw = ''; for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw); requests++
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ messages: [{ id: 'm1', localId: body.messages[0].localId, seq: 1 }] }))
        }))
        const pending: TrackedSession = { startedBy: 'daemon', pid: 456, resumeTargetSessionId: 'session-1' }
        let tracked = new Map([[session.pid, session], [pending.pid, pending]])
        const finished = new Map([['session-1', session]])
        const options = {
            serverUrl,
            findSession: (id: string) => findBrowserAttentionSession(id, tracked.values(), finished, pid => pid === pending.pid),
            isAlive: (pid: number) => pid === pending.pid,
            readToken: async () => 'synthetic-account-token',
        }
        const makeWatcher = () => new BrowserAttentionWatcher({
            store: createAttentionCursorStore(cursorFile),
            poll: async () => ({ events: [event], nextSeq: 1, oldestSeq: 1 }),
            deliver: (e, signal) => deliverBrowserAttention(e, signal, options),
        })
        let watcher = makeWatcher()
        const expectPending = async (reason: string) => {
            await expect(watcher.pollOnce()).rejects.toThrow(reason)
            expect(await createAttentionCursorStore(cursorFile).read()).toEqual({ schemaVersion: 1, afterSeq: 0, skipped: [] })
            expect(requests).toBe(0)
        }
        await expectPending('identity')
        if (restart) {
            // The daemon state persists resumeTargetSessionId before a webhook;
            // recovery has no happySessionId with which to hydrate encryption.
            writeDaemonState({ pid: 789, httpPort: 0, startTime: new Date(0).toISOString(), startedWithCliVersion: 'synthetic',
                trackedSessions: [{ ...pending, startedAt: 1 }],
            })
            watcher.stop()
            const recovered = (await readDaemonState())!.trackedSessions!
            tracked = new Map(recovered.map(record => [record.pid, { ...record }]))
            watcher = makeWatcher()
            await expectPending('identity')
        }
        // Even cached encryption cannot stand in for the child's identity.
        tracked.set(pending.pid, { ...pending, encryption })
        await expectPending('identity')
        const metadata = { path: '/synthetic', host: 'fixture', hostPid: pending.pid,
            homeDir: '/synthetic', happyHomeDir: '/synthetic/happy', happyLibDir: '/synthetic/lib', happyToolsDir: '/synthetic/tools' }
        tracked.set(pending.pid, mergeTrackedSessionWebhook({ tracked: pending, sessionId: 'session-1', metadata }))
        await expectPending('encryption')
        tracked.set(pending.pid, mergeTrackedSessionWebhook({ tracked: tracked.get(pending.pid)!, sessionId: 'session-1', metadata, encryption }))
        await watcher.pollOnce()
        expect(requests).toBe(1)
        expect(await createAttentionCursorStore(cursorFile).read()).toEqual({ schemaVersion: 1, afterSeq: 1, skipped: [] })
    })

    it.each(['response-lost', 'cancel-during-post'] as const)('replays a committed HTTP message after %s and watcher restart', async failure => {
        const dir = await tempDir(); const cursorFile = join(dir, 'cursor.json')
        const stored = new Map<string, { id: string; localId: string; seq: number; content: string }>()
        const attempts: string[] = []; const afterSeqs: number[] = []
        let committed!: () => void; let disconnected!: () => void
        const firstCommit = new Promise<void>(resolve => { committed = resolve })
        const firstDisconnect = new Promise<void>(resolve => { disconnected = resolve })
        const serverUrl = await listen(createServer(async (req, res) => {
            let raw = ''; for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw) as { messages: { localId: string; content: string }[] }
            const message = body.messages[0]; attempts.push(message.localId)
            const key = `${req.url}:${message.localId}`
            // Model the server's (sessionId, localId) uniqueness boundary.
            if (!stored.has(key)) stored.set(key, { ...message, id: 'm1', seq: 1 })
            const ack = stored.get(key)!
            if (attempts.length === 1) {
                res.on('close', disconnected)
                committed()
                if (failure === 'response-lost') res.destroy()
                return
            }
            res.setHeader('content-type', 'application/json')
            // A 200 alone is not an acknowledgement of this localId.
            res.end(JSON.stringify({ messages: attempts.length === 2 ? [{ ...ack, localId: 'unrelated' }] : [ack] }))
        }))
        const options = { serverUrl, findSession: () => session, isAlive: () => true, readToken: async () => 'synthetic-account-token' }
        const makeWatcher = () => new BrowserAttentionWatcher({
            store: createAttentionCursorStore(cursorFile),
            poll: async afterSeq => { afterSeqs.push(afterSeq); return { events: [event], nextSeq: 1, oldestSeq: 1 } },
            deliver: (e, signal) => deliverBrowserAttention(e, signal, options),
        })
        const watcher = makeWatcher()
        const failedDelivery = expect(watcher.pollOnce()).rejects.toThrow()
        await firstCommit
        if (failure === 'cancel-during-post') watcher.stop()
        await failedDelivery; await firstDisconnect
        expect(stored.size).toBe(1)
        expect(await createAttentionCursorStore(cursorFile).read()).toEqual({ schemaVersion: 1, afterSeq: 0, skipped: [] })
        watcher.stop()
        const restarted = makeWatcher()
        await expect(restarted.pollOnce()).rejects.toThrow('acknowledgement')
        expect((await createAttentionCursorStore(cursorFile).read()).afterSeq).toBe(0)
        await restarted.pollOnce()
        expect(await createAttentionCursorStore(cursorFile).read()).toEqual({ schemaVersion: 1, afterSeq: 1, skipped: [] })
        expect(attempts).toEqual(['abp-task-1-2', 'abp-task-1-2', 'abp-task-1-2'])
        expect(afterSeqs).toEqual([0, 0, 0])
        expect(stored.size).toBe(1)
        await restarted.pollOnce()
        expect(afterSeqs).toEqual([0, 0, 0, 1])
        expect(attempts).toHaveLength(3)
    })

    it('consumes the real S2 broker/outbox, including expiry and authenticated long-poll wakeup', async () => {
        const dir = await tempDir(); const socketPath = join(dir, 'b.sock')
        const store = await TaskStore.open(dir); cleanup.push(() => store.close())
        const attention = await AttentionOutbox.open(dir, { maxEvents: 1 }); attention.attach(store)
        const task: StoredTask = {
            schemaVersion: 1, taskId: 'task-1' as never, taskSpaceId: 'space-1' as never, profileId: 'profile-1' as never, agentSessionId: 'session-1' as never,
            status: 'paused', pauseReason: 'awaiting-agent', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0, tabs: [],
            uncertainActions: [], createdAtMs: 1, updatedAtMs: 1, owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' },
            actions: {}, approvals: {}, batches: {}, dedupe: {},
        }
        await store.createTask(task, { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        const daemonToken = 'synthetic-broker-token'
        const broker: Broker = await startBroker({ socketPath, stateDir: dir, daemonTokenSha256: createHash('sha256').update(daemonToken).digest('hex'), identity: { machineId: 'm' as never, workspaceId: 'w' as never }, profiles: new Map(), allowedOrigins: [], agentKey: 'synthetic-agent-key', revokeGrant: async () => {}, attention })
        cleanup.push(() => broker.close())
        const config = { socketPath, daemonToken }; const controller = new AbortController()
        const poll = (after: number, signal: AbortSignal) => pollBrowserAttention(config, after, signal)
        await expect(pollBrowserAttention({ ...config, daemonToken: 'synthetic-wrong-token' }, 0, controller.signal)).rejects.toThrow()
        const waiting = poll(0, controller.signal)
        await store.commit('task-1' as never, {}, { type: 'agent-attention-required', atMs: 2, leaseEpoch: 0, data: { attention: 'user-resumed' } })
        expect((await waiting).events).toHaveLength(1)
        await store.commit('task-1' as never, {}, { type: 'agent-attention-required', atMs: 3, leaseEpoch: 0, data: { attention: 'user-resumed' } }); await attention.flush()
        const sent: AttentionEvent[] = []; const cursor = createAttentionCursorStore(join(dir, 'daemon-cursor.json'))
        await new BrowserAttentionWatcher({ store: cursor, poll, deliver: async e => { sent.push(e); return 'sent' } }).pollOnce()
        expect(sent.map(e => e.eventSeq)).toEqual([3]); expect((await cursor.read()).afterSeq).toBe(2)
        const aborted = poll(2, controller.signal); controller.abort()
        await expect(aborted).rejects.toThrow()
    })


    it('starts only with the S2 configuration and cancels polling during shutdown', async () => {
        const dir = await tempDir(); const socketPath = join(dir, 'lifecycle.sock')
        const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'synthetic-lifecycle-token')
        let requests = 0
        let arrived!: () => void
        const polling = new Promise<void>(resolve => { arrived = resolve })
        const server = createServer(req => {
            expect(req.url).toBe('/v1/attention?afterSeq=0&waitMs=30000')
            expect(req.headers['x-abp-daemon-token']).toBe('synthetic-lifecycle-token')
            requests++; arrived()
        })
        await new Promise<void>(resolve => server.listen(socketPath, resolve))
        cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
        const options = { happyHomeDir: dir, machineId: 'machine-1', serverUrl: 'http://127.0.0.1:1', findSession: () => undefined, isAlive: () => false, readToken: async () => null, log: () => {} }
        await startBrowserAttentionWatcher({ ...options, env: {} })()
        await startBrowserAttentionWatcher({ ...options, env: { HAPPY_BROWSER_TASK_BROKER_SOCKET: socketPath, HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: join(dir, 'missing') } })()
        expect(requests).toBe(0)
        const stop = startBrowserAttentionWatcher({ ...options, env: { HAPPY_BROWSER_TASK_BROKER_SOCKET: socketPath, HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: tokenFile } })
        await polling; await stop()
        expect(requests).toBe(1)
        expect(await readdir(dir)).not.toContain('browser-attention')
    })

    it('rejects oversized broker replies and cancels a hanging poll promptly', async () => {
        const dir = await tempDir(); const socketPath = join(dir, 's.sock'); let oversized = true
        const server = createServer((_req, res) => { if (oversized) res.end('x'.repeat(1024 * 1024 + 1)) })
        await new Promise<void>(resolve => server.listen(socketPath, resolve))
        cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
        const config = { socketPath, daemonToken: 'synthetic-token' }
        await expect(pollBrowserAttention(config, 0, new AbortController().signal)).rejects.toThrow()
        oversized = false
        const controller = new AbortController(); const pending = pollBrowserAttention(config, 0, controller.signal)
        controller.abort(); await expect(pending).rejects.toThrow()
    })
})
