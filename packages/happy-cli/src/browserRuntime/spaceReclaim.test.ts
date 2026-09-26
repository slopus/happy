/**
 * Task space reclamation: spaces of ended agent sessions and idle finished spaces
 * are closed so the per-profile space quota does not fill up with abandoned
 * spaces; an operator can list and close spaces on the admin socket.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from './clock'
import type { AgentGrant, ProfileId, RequestId, TaskSpaceId } from './contracts'
import { BrowserRuntime } from './runtime'
import type { SitePolicy } from './policy'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { TaskStore } from './taskStore'

const MINUTE = 60_000
const IDLE = 15 * MINUTE
const ORIGIN = 'https://fixture.test'
const SITES: SitePolicy[] = [{ origin: ORIGIN, actions: [{ match: {}, risk: 'auto' }] }]
const profileId = 'profile-1' as ProfileId
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'abp-reclaim-')); dirs.push(dir); return dir }

let requests = 0
const rid = (label: string) => `${label}-${++requests}` as RequestId

async function start(dir: string, driver = new FakeBrowserDriver(), options: { maxSpacesPerProfile?: number; spaceIdleReclaimMs?: number } = {}) {
    const store = await TaskStore.open(dir)
    const clock = new FakeClock(1_000)
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: SITES, ...options })
    const agent = (agentSessionId = 'session-a') => ({ verifiedAtMs: clock.now(), credential: {
        kind: 'agent-grant', grantId: `grant-${agentSessionId}`, principalId: 'p', workspaceId: 'w', machineId: 'm', agentSessionId, profileId,
        allowedOrigins: [ORIGIN], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'observe', 'finishTask', 'cancel'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 10 * 24 * 60 * MINUTE } as unknown as AgentGrant })
    /** A space with one task and one open tab, owned by `agentSessionId`. */
    const openSpace = async (agentSessionId = 'session-a') => {
        const auth = agent(agentSessionId)
        const { taskSpaceId } = await runtime.createSpace(auth, { profileId, requestId: rid('space') })
        const task = await runtime.createTask(auth, { taskSpaceId, requestId: rid('task') })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: `${ORIGIN}/start`, requestId: rid('open') })
        return { auth, taskSpaceId, taskId: task.taskId, tabId: opened.tabId }
    }
    return { store, clock, runtime, driver, agent, openSpace }
}

describe('space quota', () => {
    it('keeps the PoC quota without configuration and uses the configured one otherwise', async () => {
        const harness = await start(await tempDir())
        await harness.runtime.createSpace(harness.agent(), { profileId, requestId: rid('s') })
        await harness.runtime.createSpace(harness.agent(), { profileId, requestId: rid('s') })
        await expect(harness.runtime.createSpace(harness.agent(), { profileId, requestId: rid('s') })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        await harness.store.close()

        const configured = await start(await tempDir(), undefined, { maxSpacesPerProfile: 4 })
        for (let index = 0; index < 4; index++) await configured.runtime.createSpace(configured.agent(), { profileId, requestId: rid('s') })
        await expect(configured.runtime.createSpace(configured.agent(), { profileId, requestId: rid('s') })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        await configured.store.close()
    })

    it('does not count spaces being reclaimed, except retained ones beyond the reserve of 2', async () => {
        const store = await TaskStore.open(await tempDir())
        const space = (id: string) => ({ taskSpaceId: id as TaskSpaceId, profileId, createdAtMs: 1, tabs: [] })
        await store.createSpace(space('s1'), 2)
        await store.createSpace(space('s2'), 2)
        await expect(store.createSpace(space('s3'), 2)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        await store.updateSpace('s1' as TaskSpaceId, { reclaimingSinceMs: 5, reclaimReason: 'session-ended' })
        await store.createSpace(space('s3'), 2)
        await store.updateSpace('s2' as TaskSpaceId, { reclaimingSinceMs: 5, reclaimReason: 'session-ended' })
        await store.updateSpace('s3' as TaskSpaceId, { reclaimingSinceMs: 5, reclaimReason: 'idle' })
        // 0 active + (3 reclaiming - reserve 2) = 1 counted
        await store.createSpace(space('s4'), 2)
        await expect(store.createSpace(space('s5'), 2)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        await store.close()
    })
})

describe('session-end reclamation', () => {
    it.each(['grant-expired', 'approval-expired', 'browser-replaced'] as const)('frees the quota when a dead session ends with a task paused for %s', async (pauseReason) => {
        const h = await start(await tempDir(), undefined, { maxSpacesPerProfile: 1 })
        const dead = await h.openSpace('dead-session')
        await h.store.commit(dead.taskId, { status: 'paused', pauseReason },
            { type: 'state-changed', atMs: h.clock.now(), leaseEpoch: 0, data: {} })
        await expect(h.runtime.createSpace(h.agent('new-session'), { profileId, requestId: rid('space') })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
        // The broker's durable revoke invokes endSession after revoking grants.
        await h.runtime.endSession('dead-session')
        expect(h.store.getTask(dead.taskId)).toMatchObject({ status: 'cancelled', cancelRequested: true })
        // Reclamation releases the quota before physical tab cleanup runs.
        await h.runtime.createSpace(h.agent('new-session'), { profileId, requestId: rid('space') })
        await h.runtime.reclaimSpaces()
        expect(h.store.getSpace(dead.taskSpaceId)?.closed).toBe(true)
        await h.store.close()
    })

    it('cancels the ended session\'s tasks and closes its tabs and space, leaving other sessions alone', async () => {
        const h = await start(await tempDir(), undefined, { maxSpacesPerProfile: 2 })
        const ended = await h.openSpace('session-a')
        const other = await h.openSpace('session-b')
        await h.runtime.endSession('session-a')
        const report = await h.runtime.reclaimSpaces()
        expect(report).toEqual([expect.objectContaining({ taskSpaceId: ended.taskSpaceId, closed: true, reason: 'session-ended' })])
        expect(h.store.getTask(ended.taskId)).toMatchObject({ status: 'cancelled', cancelRequested: true })
        expect(h.driver.hasTab(ended.tabId)).toBe(false)
        expect(h.store.getSpace(ended.taskSpaceId)).toMatchObject({ closed: true, tabs: [] })
        expect(h.store.getTask(other.taskId)?.status).not.toBe('cancelled')
        expect(h.driver.hasTab(other.tabId)).toBe(true)
        // The freed slot is usable; the closed space takes no new work.
        await h.runtime.createSpace(h.agent('session-c'), { profileId, requestId: rid('space') })
        await expect(h.runtime.createTask(ended.auth, { taskSpaceId: ended.taskSpaceId, requestId: rid('task') })).rejects.toMatchObject({ code: 'CONFLICT' })
        await h.store.close()
    })

    it('stops a batch in flight when its session ends, then closes the space once the worker is done', async () => {
        const h = await start(await tempDir())
        const s = await h.openSpace()
        h.driver.seedTab(s.tabId, { url: `${ORIGIN}/start`, elements: [] })
        const held = h.driver.holdAfterNextDispatch('observe')
        const view = await h.runtime.getTask(s.auth, { taskId: s.taskId })
        const batch = h.runtime.submitBatch(s.auth, { taskId: s.taskId, expectedVersion: view.stateVersion, requestId: rid('batch'),
            steps: [{ stepId: 'look' as never, actionId: 'look' as never, tabId: s.tabId, kind: 'observe', timeoutMs: 1000 }] }, { waitMs: 5000 })
        await held.entered
        await h.runtime.endSession('session-a')
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: false, waiting: [s.taskId] })])
        held.release()
        await batch.catch(() => undefined)
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: true })])
        expect(h.store.getTask(s.taskId)?.status).toBe('cancelled')
        await h.store.close()
    })

    it('retains a task whose write outcome is unknown for the user, without it holding a space slot', async () => {
        const h = await start(await tempDir(), undefined, { maxSpacesPerProfile: 1 })
        const s = await h.openSpace()
        h.driver.seedTab(s.tabId, { url: `${ORIGIN}/start`, elements: [{ ref: '@e1' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: ORIGIN }] })
        await h.runtime.observe(s.auth, { taskId: s.taskId, tabId: s.tabId })
        const held = h.driver.holdAfterNextDispatch('click')
        const view = await h.runtime.getTask(s.auth, { taskId: s.taskId })
        const batch = h.runtime.submitBatch(s.auth, { taskId: s.taskId, expectedVersion: view.stateVersion, requestId: rid('batch'),
            steps: [{ stepId: 'go' as never, actionId: 'go' as never, tabId: s.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }] }, { waitMs: 5000 })
        await held.entered
        await h.runtime.endSession('session-a')
        held.release()
        await batch.catch(() => undefined)
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: false, retained: [s.taskId] })])
        expect(h.store.getTask(s.taskId)).toMatchObject({ status: 'paused', pauseReason: 'cancelled-with-unknown-effect' })
        expect(h.driver.hasTab(s.tabId)).toBe(true)
        await h.runtime.createSpace(h.agent('session-b'), { profileId, requestId: rid('space') })
        await h.store.close()
    })

    it('finishes the reclamation after a restart', async () => {
        const dir = await tempDir()
        const driver = new FakeBrowserDriver()
        const h = await start(dir, driver)
        const s = await h.openSpace()
        await h.runtime.endSession('session-a')
        await h.store.close()

        const restarted = await start(dir, driver)
        expect(await restarted.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: true })])
        expect(driver.hasTab(s.tabId)).toBe(false)
        expect(restarted.store.getTask(s.taskId)?.status).toBe('cancelled')
        await restarted.store.close()
    })
})

describe('idle reclamation', () => {
    it('closes a space whose tasks are all finished once it was idle for spaceIdleReclaimMs, not before', async () => {
        const h = await start(await tempDir(), undefined, { spaceIdleReclaimMs: IDLE })
        const s = await h.openSpace()
        const busy = await h.openSpace('session-b')
        await h.store.commit(s.taskId, { status: 'succeeded' }, { type: 'state-changed', atMs: h.clock.now(), leaseEpoch: 0, data: {} })
        h.clock.set(h.clock.now() + IDLE - 1)
        expect(await h.runtime.reclaimSpaces()).toEqual([])
        h.clock.set(h.clock.now() + 1)
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: true, reason: 'idle' })])
        expect(h.driver.hasTab(s.tabId)).toBe(false)
        // An unfinished task keeps its space however long it idles.
        h.clock.set(h.clock.now() + 10 * IDLE)
        expect(await h.runtime.reclaimSpaces()).toEqual([])
        expect(h.driver.hasTab(busy.tabId)).toBe(true)
        await h.store.close()
    })

    it('leaves a tab that blocks unloading open and reports it, and closes the space once it no longer blocks', async () => {
        const h = await start(await tempDir(), undefined, { spaceIdleReclaimMs: IDLE })
        const s = await h.openSpace()
        await h.store.commit(s.taskId, { status: 'succeeded' }, { type: 'state-changed', atMs: h.clock.now(), leaseEpoch: 0, data: {} })
        h.driver.blockUnload(s.tabId, true)
        h.clock.set(h.clock.now() + IDLE)
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: false, blockedTabs: [s.tabId] })])
        expect(h.driver.hasTab(s.tabId)).toBe(true)
        expect(h.store.getSpace(s.taskSpaceId)).toMatchObject({ reclaimReason: 'idle', reclaimBlockedTabs: [s.tabId] })
        h.driver.blockUnload(s.tabId, false)
        expect(await h.runtime.reclaimSpaces()).toEqual([expect.objectContaining({ taskSpaceId: s.taskSpaceId, closed: true })])
        await h.store.close()
    })
})

describe('operator space commands', () => {
    it('lists spaces with their owner session, tasks, tabs and age', async () => {
        const h = await start(await tempDir())
        const s = await h.openSpace()
        h.clock.set(h.clock.now() + 5 * MINUTE)
        expect(h.runtime.spaceReport()).toEqual([expect.objectContaining({
            taskSpaceId: s.taskSpaceId, profileId, agentSessionId: 'session-a', closed: false, counted: true, ageMs: 5 * MINUTE,
            tabs: [s.tabId], tasks: [expect.objectContaining({ taskId: s.taskId, uncertainActions: 0 })],
        })])
        await h.store.close()
    })

    it('closes a space by cancelling its tasks, and needs force when a task has an unknown write outcome', async () => {
        const h = await start(await tempDir())
        const s = await h.openSpace()
        expect(await h.runtime.closeSpaceAsOperator(s.taskSpaceId)).toMatchObject({ closed: true, reason: 'operator' })
        expect(h.store.getTask(s.taskId)?.status).toBe('cancelled')

        const uncertain = await h.openSpace('session-b')
        await h.store.commit(uncertain.taskId, { status: 'paused', pauseReason: 'cancelled-with-unknown-effect', cancelRequested: true, uncertainActions: ['w' as never] },
            { type: 'state-changed', atMs: h.clock.now(), leaseEpoch: 0, data: {} })
        expect(await h.runtime.closeSpaceAsOperator(uncertain.taskSpaceId)).toMatchObject({ closed: false, retained: [uncertain.taskId] })
        expect(h.driver.hasTab(uncertain.tabId)).toBe(true)
        expect(await h.runtime.closeSpaceAsOperator(uncertain.taskSpaceId, { force: true })).toMatchObject({ closed: true })
        expect(h.driver.hasTab(uncertain.tabId)).toBe(false)
        expect(h.store.getTask(uncertain.taskId)).toMatchObject({ status: 'paused', uncertainActions: ['w'] })
        await h.store.close()
    })
})
