import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentGrant, InteractiveCapability, ProfileId, RequestId, TaskId } from './contracts'
import { AttentionOutbox } from './attention'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore, type StoredTask } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'abp-attention-')); dirs.push(dir); return dir }

function storedTask(taskId: string): StoredTask {
    return {
        schemaVersion: 1, taskId: taskId as TaskId, taskSpaceId: 'space' as never, profileId: 'profile' as never, agentSessionId: 'session-1' as never,
        status: 'paused', pauseReason: 'awaiting-agent', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0, tabs: [],
        uncertainActions: [], createdAtMs: 1, updatedAtMs: 1, owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' },
        actions: {}, approvals: {}, batches: {}, dedupe: {},
    }
}
const attentionEvent = (reason: string) => ({ type: 'agent-attention-required' as const, atMs: 2, leaseEpoch: 0, data: { attention: reason } })
const plainEvent = { type: 'state-changed' as const, atMs: 2, leaseEpoch: 0, data: {} }

describe('AttentionOutbox', () => {
    it('records only attention-tagged transitions and keeps its sequence across reopen', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir)
        outbox.attach(store)
        await store.createTask(storedTask('t1'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await store.commit('t1' as TaskId, {}, plainEvent)
        const tagged = await store.commit('t1' as TaskId, { pauseReason: 'user-input-complete' }, attentionEvent('takeover-released'))
        await outbox.flush()
        const first = outbox.read(0)
        expect(first).toEqual({ events: [{ seq: 1, taskId: 't1', agentSessionId: 'session-1', status: 'paused', eventSeq: tagged.highWatermarkSeq, reason: 'takeover-released' }], nextSeq: 1, oldestSeq: 1 })

        const reopened = await AttentionOutbox.open(dir)
        reopened.attach(store)
        expect(reopened.read(0)).toEqual(first)
        await store.commit('t1' as TaskId, {}, attentionEvent('user-resumed'))
        await reopened.flush()
        expect(reopened.read(1).events.map((event) => `${event.seq}:${event.reason}`)).toEqual(['2:user-resumed'])
        await store.close()
    })

    it('recovers a transition committed to the task journal but lost before the outbox write, exactly once', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        await store.createTask(storedTask('t1'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        // No outbox attached: models a crash between the task commit and the outbox append.
        const tagged = await store.commit('t1' as TaskId, {}, attentionEvent('approval-approved'))
        const outbox = await AttentionOutbox.open(dir)
        outbox.attach(store)
        await outbox.reconcile()
        await outbox.reconcile()
        expect(outbox.read(0).events.map((event) => `${event.taskId}:${event.eventSeq}:${event.reason}`)).toEqual([`t1:${tagged.highWatermarkSeq}:approval-approved`])
        await store.close()
    })

    it('reports CURSOR_EXPIRED with a snapshot once the cursor fell out of retention or is from the future', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir, { maxEvents: 2 })
        outbox.attach(store)
        await store.createTask(storedTask('t1'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        for (const reason of ['takeover-released', 'user-resumed', 'approval-approved']) await store.commit('t1' as TaskId, {}, attentionEvent(reason))
        await outbox.flush()
        expect(outbox.read(1)).toMatchObject({ events: [{ seq: 2 }, { seq: 3 }], nextSeq: 3, oldestSeq: 2 })
        const expired = outbox.read(0)
        expect(expired).toMatchObject({ code: 'CURSOR_EXPIRED', events: [], nextSeq: 3, oldestSeq: 2 })
        expect('snapshot' in expired && expired.snapshot.map((entry) => `${entry.taskId}:${entry.reason}`)).toEqual(['t1:approval-approved'])
        expect(outbox.read(9)).toMatchObject({ code: 'CURSOR_EXPIRED' })
        await store.close()
    })

    it('treats afterSeq = oldestSeq - 1 as no gap: a cursor expires only when afterSeq + 1 < oldestSeq', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir, { maxEvents: 2 })
        outbox.attach(store)
        // Fresh outbox: nothing was ever evicted, so the daemon's initial cursor 0 is valid with oldestSeq 1.
        expect(outbox.read(0)).toEqual({ events: [], nextSeq: 0, oldestSeq: 1 })
        await store.createTask(storedTask('t1'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        for (const reason of ['takeover-released', 'user-resumed', 'approval-approved']) await store.commit('t1' as TaskId, {}, attentionEvent(reason))
        await outbox.flush()
        // seq 1 was evicted (oldestSeq 2): a daemon that already read seq 1 missed nothing...
        expect(outbox.read(1)).not.toHaveProperty('code')
        // ...one that stopped at 0 did.
        expect(outbox.read(0)).toHaveProperty('code', 'CURSOR_EXPIRED')
        await store.close()
    })

    it('exposes an event only once it is durable, and retries a failed outbox write', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir, { retryMs: 3_600_000 })
        outbox.attach(store)
        await store.createTask(storedTask('t1'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await chmod(dir, 0o500)
        try {
            await store.commit('t1' as TaskId, {}, attentionEvent('user-resumed'))
            await expect(outbox.flush()).rejects.toThrow()
            expect(outbox.read(0)).toEqual({ events: [], nextSeq: 0, oldestSeq: 1 })
            expect((await outbox.wait(0, 20)).events).toEqual([])
        } finally {
            await chmod(dir, 0o700)
        }
        await outbox.flush()
        expect(outbox.read(0).events.map((event) => `${event.seq}:${event.reason}`)).toEqual(['1:user-resumed'])
        outbox.close()
        await store.close()
    })

    it('never reassigns a sequence the daemon already acknowledged when a crash loses an undurable event', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir, { retryMs: 3_600_000 })
        outbox.attach(store)
        for (const taskId of ['t-a', 't-b']) await store.createTask(storedTask(taskId), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await store.commit('t-b' as TaskId, {}, attentionEvent('takeover-released'))
        await outbox.flush()
        const acknowledged = outbox.read(0)
        expect('code' in acknowledged ? [] : acknowledged.events.map((event) => `${event.seq}:${event.taskId}`)).toEqual(['1:t-b'])
        const cursor = acknowledged.nextSeq

        await chmod(dir, 0o500)
        try {
            await store.commit('t-a' as TaskId, {}, attentionEvent('approval-approved'))
            await outbox.flush().catch(() => undefined)
            expect(outbox.read(cursor)).toEqual({ events: [], nextSeq: cursor, oldestSeq: 1 })
        } finally {
            // Crash: the outbox dies with t-a's event only in the task journal.
            outbox.close()
            await chmod(dir, 0o700)
        }
        const recovered = await AttentionOutbox.open(dir)
        recovered.attach(store)
        await recovered.reconcile()
        expect(recovered.read(cursor)).toMatchObject({ events: [{ seq: 2, taskId: 't-a', reason: 'approval-approved' }], nextSeq: 2 })
        await store.close()
    })

    it('keeps an unresolved task in the expired-cursor snapshot after its event left retention, until an agent batch follows it', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir, { maxEvents: 2 })
        outbox.attach(store)
        for (const taskId of ['t1', 't2']) await store.createTask(storedTask(taskId), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await store.commit('t1' as TaskId, {}, attentionEvent('approval-approved'))
        for (const reason of ['takeover-released', 'user-resumed']) await store.commit('t2' as TaskId, {}, attentionEvent(reason))
        await outbox.flush()
        const snapshot = (feed: ReturnType<AttentionOutbox['read']>) => 'snapshot' in feed ? feed.snapshot.map((entry) => `${entry.taskId}:${entry.reason}`).sort() : []
        expect(outbox.read(1)).toMatchObject({ events: [{ seq: 2 }, { seq: 3 }] })
        expect(snapshot(outbox.read(0))).toEqual(['t1:approval-approved', 't2:user-resumed'])

        await store.commit('t2' as TaskId, {}, { type: 'batch-accepted', atMs: 3, leaseEpoch: 0, data: {} })
        await outbox.flush()
        expect(snapshot(outbox.read(0))).toEqual(['t1:approval-approved'])
        const reopened = await AttentionOutbox.open(dir, { maxEvents: 2 })
        reopened.attach(store)
        expect(snapshot(reopened.read(0))).toEqual(['t1:approval-approved'])
        await store.close()
    })

    it('wakes a long poll when a transition is recorded', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir)
        outbox.attach(store)
        await store.createTask(storedTask('t1'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        const startedAt = Date.now()
        const waiting = outbox.wait(0, 5_000)
        await store.commit('t1' as TaskId, {}, attentionEvent('user-resumed'))
        expect((await waiting).events).toHaveLength(1)
        expect(Date.now() - startedAt).toBeLessThan(4_000)
        expect((await outbox.wait(1, 50)).events).toEqual([])
        await store.close()
    })
})

describe('BrowserRuntime attention transitions', () => {
    async function harness() {
        const dir = await tempDir()
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const outbox = await AttentionOutbox.open(dir); outbox.attach(store)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: fixtureSitePolicies(['https://fixture.test']) })
        const grant: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never,
            machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'],
            operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'observe', 'resume'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never, workspaceId: 'w' as never,
            machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['approve', 'takeOver', 'releaseControl', 'resume'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential: grant, verifiedAtMs: 100 }; const ui = { credential: capability, verifiedAtMs: 100 }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open' as RequestId })
        const reasons = async () => { await outbox.flush(); return outbox.read(0).events.map((event) => event.reason) }
        return { store, driver, runtime, auth, ui, task, opened, profileId, reasons }
    }

    it('records user approval and takeover release, but not the agent finishing its own batch', async () => {
        const h = await harness()
        const done = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: h.opened.task.stateVersion, requestId: 'b1' as RequestId,
            steps: [{ stepId: 's' as never, actionId: 'o1' as never, tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1000 }] }, { waitMs: 1000 })
        expect(done.task.pauseReason).toBe('awaiting-agent')
        expect(await h.reasons()).toEqual([])

        const taken = await h.runtime.takeOver(h.ui, { taskId: h.task.taskId, tabId: h.opened.tabId, expectedEpoch: h.runtime.leases.owner(h.opened.tabId, h.profileId).leaseEpoch, requestId: 'take' as RequestId })
        expect(await h.reasons()).toEqual([])
        const released = await h.runtime.releaseControl(h.ui, { taskId: h.task.taskId, tabId: h.opened.tabId, expectedEpoch: taken.leaseEpoch, requestId: 'release' as RequestId })
        await h.runtime.resume(h.ui, { taskId: h.task.taskId, expectedVersion: released.task.stateVersion, requestId: 'resume' as RequestId })
        expect(await h.reasons()).toEqual(['takeover-released', 'user-resumed'])

        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [{ ref: '@e1' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' }] })
        await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: current.stateVersion, requestId: 'pay' as RequestId,
            steps: [{ stepId: 'pay' as never, actionId: 'pay' as never, tabId: h.opened.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }] }, { waitMs: 1000 })
        const approval = batch.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        expect(await h.reasons()).toEqual(['takeover-released', 'user-resumed'])
        await h.runtime.approve(h.ui, { taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash, requestId: 'approve' as RequestId, decision: 'reject' })
        expect(await h.reasons()).toEqual(['takeover-released', 'user-resumed', 'approval-rejected'])
        await h.store.close()
    })

    it('records a browser replacement found on reconnect for the agent to re-plan', async () => {
        const h = await harness()
        await h.runtime.onDriverDisconnected(h.profileId)
        h.driver.swapInstance()
        await h.runtime.onDriverReconnected(h.profileId)
        expect(await h.reasons()).toEqual(['recovered'])
        await h.store.close()
    })
})
