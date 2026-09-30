/** A profile reassigned to another owner (abp-stack set-principal): nothing of the previous owner carries over. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentGrant, InteractiveCapability, PrincipalId, ProfileId, RequestId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const profileId = 'profile-1' as ProfileId
const sites = fixtureSitePolicies(['https://fixture.test'])
const grantFor = (principal: string): AgentGrant => ({ kind: 'agent-grant', grantId: `g-${principal}` as never, principalId: principal as never, workspaceId: 'w' as never,
    machineId: 'm' as never, agentSessionId: `a-${principal}` as never, profileId, allowedOrigins: ['https://fixture.test'],
    operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'finishTask', 'resume'],
    taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 })
const uiFor = (principal: string): InteractiveCapability => ({ kind: 'interactive', capabilityId: `ui-${principal}` as never, principalId: principal as never,
    workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
    operations: ['takeOver', 'releaseControl', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 })

/** User A left a task paused under their own control (the state a reassignment finds). */
async function leftByA() {
    const dir = await mkdtemp(join(tmpdir(), 'abp-principal-change-')); dirs.push(dir)
    const clock = new FakeClock(100)
    const store = await TaskStore.open(dir)
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, new FakeBrowserDriver()]]), clock, sites })
    const auth = { credential: grantFor('user-a'), verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open' as RequestId })
    await runtime.takeOver({ credential: uiFor('user-a'), verifiedAtMs: clock.now() }, { taskId: task.taskId, tabId: opened.tabId,
        expectedEpoch: runtime.leases.owner(opened.tabId, profileId).leaseEpoch, requestId: 'take' as RequestId })
    await store.mutate(task.taskId, (current) => ({ patch: { uncertainActions: ['action-left' as never], stateVersion: current.stateVersion },
        event: { type: 'state-changed', atMs: clock.now(), stateVersion: current.stateVersion, leaseEpoch: 0, data: {} } }))
    await store.close()
    return { dir, space, task, opened, clock }
}

async function restart(dir: string, owner: string, clock: FakeClock, store?: TaskStore) {
    const reopened = store ?? await TaskStore.open(dir)
    const runtime = new BrowserRuntime({ store: reopened, drivers: new Map([[profileId, new FakeBrowserDriver()]]), clock, sites,
        profilePrincipals: new Map([[profileId, owner as PrincipalId]]) })
    await (runtime as unknown as { recovery: Promise<void> }).recovery
    return { runtime, store: reopened }
}

describe('profile reassigned to another owner', () => {
    it("closes the previous owner's spaces, cancels their unfinished tasks (uncertain outcomes kept) and releases their control", async () => {
        const a = await leftByA()
        const { runtime, store } = await restart(a.dir, 'user-b', a.clock)
        const space = store.getSpace(a.space.taskSpaceId)!
        expect(space).toMatchObject({ closed: true, reclaimReason: 'principal-changed', tabs: [], profileUserOwner: null })
        const task = store.getTask(a.task.taskId)!
        expect(task).toMatchObject({ status: 'cancelled', pauseReason: 'principal-changed', tabs: [] })
        expect(task.uncertainActions).toEqual(['action-left'])
        expect(runtime.leases.owner(a.opened.tabId, profileId).owner).toEqual({ kind: 'none' })
        expect(runtime.principalStateReady()).toBe(true)
        // The new owner is not fenced and has the whole quota.
        const auth = { credential: grantFor('user-b'), verifiedAtMs: a.clock.now() }
        const space2 = await runtime.createSpace(auth, { profileId, requestId: 'space-b' as RequestId })
        const task2 = await runtime.createTask(auth, { taskSpaceId: space2.taskSpaceId, requestId: 'task-b' as RequestId })
        await expect(runtime.openPage(auth, { taskId: task2.taskId, url: 'https://fixture.test/start', requestId: 'open-b' as RequestId })).resolves.toBeTruthy()
        await store.close()
    })

    it('keeps everything as it was when the same owner comes back after a restart', async () => {
        const a = await leftByA()
        const { store } = await restart(a.dir, 'user-a', a.clock)
        expect(store.getSpace(a.space.taskSpaceId)!.closed).not.toBe(true)
        expect(store.getTask(a.task.taskId)!.status).not.toBe('cancelled')
        await store.close()
    })

    it('reports the cleanup failing as not ready instead of starting with the previous owner\'s state', async () => {
        const a = await leftByA()
        const store = await TaskStore.open(a.dir)
        store.mutateSpace = async () => { throw new Error('disk full') }
        const { runtime } = await restart(a.dir, 'user-b', a.clock, store)
        expect(runtime.principalStateReady()).toBe(false)
        await store.close()
    })
})
