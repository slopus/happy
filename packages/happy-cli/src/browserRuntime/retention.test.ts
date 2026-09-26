/**
 * retentionDays: terminal tasks older than the retention are deleted with
 * everything that refers to them, and an interrupted cleanup finishes on the
 * next start.
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttentionOutbox } from './attention'
import { FakeClock } from './clock'
import { SCHEMA_VERSION, type AgentGrant, type ProfileId, type TaskId, type TaskSpaceId, type TaskStatus } from './contracts'
import { BrowserRuntime } from './runtime'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { TaskStore, type FaultInjector, type StoredTask } from './taskStore'

const DAY = 86_400_000
const RETENTION = 7 * DAY
const NOW = 30 * DAY
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'abp-retention-')); dirs.push(dir); return dir }
const exists = (path: string) => stat(path).then(() => true, () => false)

function storedTask(taskId: string): StoredTask {
    return { schemaVersion: SCHEMA_VERSION, taskId: taskId as TaskId, taskSpaceId: 's1' as TaskSpaceId, profileId: 'p1' as never, agentSessionId: 'a1' as never,
        status: 'queued', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0, tabs: [`tab-${taskId}` as never], uncertainActions: [],
        createdAtMs: 1, updatedAtMs: 1, owner: { principalId: 'p', workspaceId: 'w', machineId: 'm' },
        actions: {}, approvals: { [`approval-${taskId}`]: { state: 'consumed' } }, batches: {}, dedupe: {} }
}

/** Tasks ending at the given times, and a space whose tabs and request records refer to them. */
async function seed(store: TaskStore, tasks: Array<{ id: string; status: TaskStatus; endedAtMs: number; uncertain?: boolean; open?: boolean }>) {
    const tabIds = tasks.map((task) => `tab-${task.id}`)
    await store.createSpace({ taskSpaceId: 's1' as TaskSpaceId, profileId: 'p1' as ProfileId, createdAtMs: 1,
        tabs: tasks.filter((task) => task.open).map((task) => `tab-${task.id}`) as never,
        goneTabs: tasks.filter((task) => !task.open).map((task) => `tab-${task.id}`) as never,
        tabTargets: Object.fromEntries(tabIds.map((tabId) => [tabId, `target-${tabId}`])), tabLeaseEpochs: Object.fromEntries(tabIds.map((tabId) => [tabId, 1])),
        dedupe: Object.fromEntries(tasks.map((task) => [`request-${task.id}`, { hash: 'h', result: { task: { taskId: task.id } } }])) })
    for (const task of tasks) {
        await store.createTask(storedTask(task.id), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await store.commit(task.id as TaskId, { status: task.status, ...(task.uncertain ? { uncertainActions: ['write-1' as never] } : {}) },
            { type: 'state-changed', atMs: task.endedAtMs, leaseEpoch: 0, data: {} })
    }
}

const standardTasks = [
    { id: 'expired', status: 'succeeded' as const, endedAtMs: NOW - RETENTION - 1 },
    { id: 'boundary', status: 'failed' as const, endedAtMs: NOW - RETENTION },
    { id: 'paused-old', status: 'paused' as const, endedAtMs: 1, open: true },
    { id: 'uncertain-old', status: 'cancelled' as const, endedAtMs: 1, uncertain: true, open: true },
    // Its browser tab is still open: only the Runtime (which closes it first) may delete it.
    { id: 'expired-open', status: 'succeeded' as const, endedAtMs: 1, open: true },
]
const KEPT = ['boundary', 'expired-open', 'paused-old', 'uncertain-old']

async function expectPurged(dir: string, store: TaskStore, taskId: string) {
    expect(store.getTask(taskId as TaskId)).toBeUndefined()
    expect(await exists(join(dir, 'tasks', taskId))).toBe(false)
    expect(await readdir(join(dir, 'tasks-purged')).catch(() => [])).toEqual([])
    const space = store.getSpace('s1' as TaskSpaceId)!
    expect(space.tabs).not.toContain(`tab-${taskId}`)
    expect(Object.keys(space.tabTargets ?? {})).not.toContain(`tab-${taskId}`)
    expect(Object.keys(space.tabLeaseEpochs ?? {})).not.toContain(`tab-${taskId}`)
    expect(space.goneTabs ?? []).not.toContain(`tab-${taskId}`)
    expect(Object.keys(space.dedupe ?? {})).not.toContain(`request-${taskId}`)
}

describe('TaskStore retention', () => {
    it('deletes only terminal tasks without uncertain actions or open tabs whose last change is older than the retention', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        await seed(store, standardTasks)
        expect(await store.purgeExpiredTasks(NOW, RETENTION)).toEqual(['expired'])
        await expectPurged(dir, store, 'expired')
        expect(store.getSpace('s1' as TaskSpaceId)!.tabs).toEqual(['tab-paused-old', 'tab-uncertain-old', 'tab-expired-open'])
        expect(Object.keys(store.getSpace('s1' as TaskSpaceId)!.dedupe ?? {}).sort()).toEqual(KEPT.map((id) => `request-${id}`))
        await store.close()

        const reopened = await TaskStore.open(dir)
        expect(reopened.listTasks().map((task) => task.taskId).sort()).toEqual(KEPT)
        expect(await reopened.purgeExpiredTasks(NOW + 1, RETENTION)).toEqual(['boundary'])
        await reopened.close()
    })

    it.each(['metadata', 'purge-delete'] as const)('finishes a cleanup interrupted at %s when the store reopens', async (step) => {
        const dir = await tempDir()
        let armed = false
        const fault: FaultInjector = (operation) => { if (armed && operation === step) throw new Error(`crash at ${operation}`) }
        const store = await TaskStore.open(dir, fault)
        await seed(store, standardTasks)
        armed = true
        await expect(store.purgeExpiredTasks(NOW, RETENTION)).rejects.toThrow()
        expect(store.getTask('expired' as TaskId)).toBeUndefined()
        await store.close()

        const reopened = await TaskStore.open(dir)
        await expectPurged(dir, reopened, 'expired')
        expect(reopened.listTasks().map((task) => task.taskId).sort()).toEqual(KEPT)
        await reopened.close()
    })

    it('keeps the task intact when the cleanup is interrupted before the task was moved', async () => {
        const dir = await tempDir()
        let armed = false
        const store = await TaskStore.open(dir, (operation) => { if (armed && operation === 'purge-move') throw new Error('crash before move') })
        await seed(store, standardTasks)
        armed = true
        await expect(store.purgeExpiredTasks(NOW, RETENTION)).rejects.toThrow()
        await store.close()

        const reopened = await TaskStore.open(dir)
        expect(reopened.getTask('expired' as TaskId)).toMatchObject({ status: 'succeeded', approvals: { 'approval-expired': { state: 'consumed' } } })
        expect(await reopened.purgeExpiredTasks(NOW, RETENTION)).toEqual(['expired'])
        await expectPurged(dir, reopened, 'expired')
        await reopened.close()
    })
})

describe('attention outbox and Runtime on retention', () => {
    const attentionState = async (dir: string) => JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8')) as { taskCursors: Record<string, number>; unresolved: Record<string, unknown> }
    const attentionEvent = { type: 'agent-attention-required' as const, atMs: 1, leaseEpoch: 0, data: { attention: 'approval-rejected' } }

    it('drops a purged task from the outbox cursors and unresolved index', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir)
        outbox.attach(store)
        await store.createSpace({ taskSpaceId: 's1' as TaskSpaceId, profileId: 'p1' as ProfileId, createdAtMs: 1, tabs: [] })
        await store.createTask(storedTask('expired'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await store.commit('expired' as TaskId, { status: 'failed' }, attentionEvent)
        await outbox.flush()
        expect(Object.keys((await attentionState(dir)).unresolved)).toEqual(['expired'])
        await store.purgeExpiredTasks(NOW, RETENTION)
        await outbox.flush()
        const state = await attentionState(dir)
        expect([Object.keys(state.taskCursors), Object.keys(state.unresolved)]).toEqual([[], []])
        await store.close()
    })

    it('prunes the outbox at start-up when a crash hit between the task deletion and the outbox write', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const outbox = await AttentionOutbox.open(dir)
        outbox.attach(store)
        await store.createSpace({ taskSpaceId: 's1' as TaskSpaceId, profileId: 'p1' as ProfileId, createdAtMs: 1, tabs: [] })
        await store.createTask(storedTask('expired'), { type: 'task-created', atMs: 1, leaseEpoch: 0, data: {} })
        await store.commit('expired' as TaskId, { status: 'failed' }, attentionEvent)
        await outbox.flush()
        outbox.close() // crash: the outbox never hears about the deletion
        await store.purgeExpiredTasks(NOW, RETENTION)
        await store.close()

        const reopened = await TaskStore.open(dir)
        const recovered = await AttentionOutbox.open(dir)
        recovered.attach(reopened)
        await recovered.reconcile()
        const state = await attentionState(dir)
        expect([Object.keys(state.taskCursors), Object.keys(state.unresolved)]).toEqual([[], []])
        await reopened.close()
    })

    const profileId = 'profile-1' as ProfileId
    async function runtimeWithFinishedTask(dir: string, driver: FakeBrowserDriver) {
        const { store, runtime, clock } = await startRuntime(dir, driver)
        const auth = agent(clock)
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as never })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as never })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open' as never })
        await store.commit(task.taskId, { status: 'succeeded' }, { type: 'state-changed', atMs: 2, leaseEpoch: 0, data: {} })
        clock.set(3 + RETENTION)
        return { store, runtime, clock, taskId: task.taskId, taskSpaceId: space.taskSpaceId, tabId: opened.tabId }
    }
    async function startRuntime(dir: string, driver: FakeBrowserDriver) {
        const store = await TaskStore.open(dir)
        const clock = new FakeClock(3 + RETENTION)
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: [{ origin: 'https://fixture.test', actions: [] }] })
        return { store, clock, runtime }
    }
    const agent = (clock: FakeClock) => ({ verifiedAtMs: clock.now(), credential: { kind: 'agent-grant', grantId: 'g', principalId: 'p', workspaceId: 'w', machineId: 'm',
        agentSessionId: 'a', profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'getTask'], taskSpaceIds: [],
        issuedAtMs: 0, expiresAtMs: 100 * DAY } as unknown as AgentGrant })
    const spaceTabs = (store: TaskStore, taskSpaceId: TaskSpaceId) => {
        const space = store.getSpace(taskSpaceId)!
        return { tabs: space.tabs, targets: Object.keys(space.tabTargets ?? {}) }
    }

    it('closes an expired task\'s open browser tab before deleting the task', async () => {
        const driver = new FakeBrowserDriver()
        const h = await runtimeWithFinishedTask(await tempDir(), driver)
        expect(driver.hasTab(h.tabId)).toBe(true)
        expect(await h.runtime.purgeExpiredTasks(RETENTION)).toEqual([h.taskId])
        expect(driver.hasTab(h.tabId)).toBe(false)
        expect(h.store.getTask(h.taskId)).toBeUndefined()
        expect(spaceTabs(h.store, h.taskSpaceId)).toEqual({ tabs: [], targets: [] })
        await h.store.close()
    })

    it('keeps the task and its tab references when the tab cannot be closed, and retries on the next run', async () => {
        const driver = new FakeBrowserDriver()
        const h = await runtimeWithFinishedTask(await tempDir(), driver)
        driver.failNext('closeTab', new Error('browser unreachable'))
        expect(await h.runtime.purgeExpiredTasks(RETENTION)).toEqual([])
        expect(h.store.getTask(h.taskId)).toBeDefined()
        expect(spaceTabs(h.store, h.taskSpaceId)).toEqual({ tabs: [h.tabId], targets: [h.tabId] })
        expect(driver.hasTab(h.tabId)).toBe(true)
        expect(await h.runtime.purgeExpiredTasks(RETENTION)).toEqual([h.taskId])
        expect(driver.hasTab(h.tabId)).toBe(false)
        await h.store.close()
    })

    it('retries after a restart when closing failed before the Runtime stopped', async () => {
        const dir = await tempDir()
        const driver = new FakeBrowserDriver()
        const h = await runtimeWithFinishedTask(dir, driver)
        driver.failNext('closeTab', new Error('browser unreachable'))
        expect(await h.runtime.purgeExpiredTasks(RETENTION)).toEqual([])
        await h.store.close()

        const restarted = await startRuntime(dir, driver)
        expect(await restarted.runtime.purgeExpiredTasks(RETENTION)).toEqual([h.taskId])
        expect(driver.hasTab(h.tabId)).toBe(false)
        expect(spaceTabs(restarted.store, h.taskSpaceId)).toEqual({ tabs: [], targets: [] })
        await restarted.store.close()
    })

    it('counts a tab the browser already closed as closed, and drops its references', async () => {
        const driver = new FakeBrowserDriver()
        const h = await runtimeWithFinishedTask(await tempDir(), driver)
        await driver.closeTab(h.tabId, { timeoutMs: 1000 })
        expect(await h.runtime.purgeExpiredTasks(RETENTION)).toEqual([h.taskId])
        expect(spaceTabs(h.store, h.taskSpaceId)).toEqual({ tabs: [], targets: [] })
        await h.store.close()
    })

    it('leaves no orphaned reference after a crash between closing the tab and removing it, and still deletes the task', async () => {
        const dir = await tempDir()
        const driver = new FakeBrowserDriver()
        const h = await runtimeWithFinishedTask(dir, driver)
        await driver.closeTab(h.tabId, { timeoutMs: 1000 })
        await h.store.close()

        const restarted = await startRuntime(dir, driver)
        await restarted.runtime.purgeExpiredTasks(RETENTION)
        // Start-up recovery already moved the vanished tab out of the space; its commit restarts the task's age.
        expect(spaceTabs(restarted.store, h.taskSpaceId)).toEqual({ tabs: [], targets: [] })
        restarted.clock.set(restarted.clock.now() + RETENTION + 1)
        expect(await restarted.runtime.purgeExpiredTasks(RETENTION)).toEqual([h.taskId])
        await restarted.store.close()
    })

    it('forgets a purged task in the Runtime: it is no longer found and its approvals are gone', async () => {
        const dir = await tempDir()
        const store = await TaskStore.open(dir)
        const clock = new FakeClock(1)
        const profileId = 'profile-1' as ProfileId
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, new FakeBrowserDriver()]]), clock, sites: [{ origin: 'https://fixture.test', actions: [] }] })
        const grant: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never,
            agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'getTask'], taskSpaceIds: [],
            issuedAtMs: 0, expiresAtMs: 100 * DAY }
        const auth = { credential: grant, verifiedAtMs: 1 }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as never })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as never })
        await store.commit(task.taskId, { status: 'succeeded' }, { type: 'state-changed', atMs: 2, leaseEpoch: 0, data: {} })
        clock.set(2 + RETENTION)
        expect(await runtime.purgeExpiredTasks(RETENTION)).toEqual([])
        clock.set(3 + RETENTION)
        expect(await runtime.purgeExpiredTasks(RETENTION)).toEqual([task.taskId])
        await expect(runtime.getTask({ ...auth, verifiedAtMs: clock.now() }, { taskId: task.taskId })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await store.close()
    })
})
