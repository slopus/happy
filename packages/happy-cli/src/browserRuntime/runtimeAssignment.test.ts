/**
 * Profile assignments (runtime.json schema 2): every abp-stack set-principal draws a new assignment, and
 * nothing of an earlier one (spaces, tasks, approvals, grants, control) survives into it, even when the
 * same owner comes back (A → B → A). An ordinary restart in the same assignment keeps everything.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { POC_LIMITS, type AgentGrant, type InteractiveCapability, type ProfileId, type RequestId, type TaskId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const profileId = 'profile-1' as ProfileId
const sites = fixtureSitePolicies(['https://fixture.test'])
const FIRST = 'a'.repeat(32)
const SECOND = 'b'.repeat(32)
const THIRD = 'c'.repeat(32)
const grant = (assignmentId: string | undefined, session = 'session-a'): AgentGrant => ({ kind: 'agent-grant', grantId: `g-${session}-${assignmentId}` as never,
    principalId: 'user-a' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: session as never, profileId,
    allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'finishTask', 'resume'],
    taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000, ...(assignmentId ? { assignmentId } : {}) })
const ui = (): InteractiveCapability => ({ kind: 'interactive', capabilityId: 'ui-a', principalId: 'user-a' as never, workspaceId: 'w' as never,
    machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['takeOver', 'releaseControl', 'getTask', 'subscribe'], issuedAtMs: 0, expiresAtMs: 3_600_000 })

async function start(dir: string, assignmentId: string, clock: FakeClock, store?: TaskStore) {
    const opened = store ?? await TaskStore.open(dir)
    const runtime = new BrowserRuntime({ store: opened, drivers: new Map([[profileId, new FakeBrowserDriver()]]), clock, sites,
        profilePrincipals: new Map([[profileId, 'user-a' as never]]), profileAssignments: new Map([[profileId, assignmentId]]) })
    await runtime.started().catch(() => undefined)
    return { runtime, store: opened }
}

/** User A, in the first assignment, left a task holding a pending approval, a write that may have reached the page, and control of its tab. */
async function leftInFirstAssignment() {
    const dir = await mkdtemp(join(tmpdir(), 'abp-assignment-')); dirs.push(dir)
    const clock = new FakeClock(100)
    const { runtime, store } = await start(dir, FIRST, clock)
    const auth = { credential: grant(FIRST), verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open' as RequestId })
    await runtime.takeOver({ credential: ui(), verifiedAtMs: clock.now() }, { taskId: task.taskId, tabId: opened.tabId,
        expectedEpoch: runtime.leases.owner(opened.tabId, profileId).leaseEpoch, requestId: 'take' as RequestId })
    await store.mutate(task.taskId, (current) => ({
        patch: { actions: { ...current.actions, 'action-click': { state: 'dispatched', kind: 'click' } },
            approvals: { 'approval-1': { state: 'pending', approvalId: 'approval-1' as never } }, pendingApproval: { approvalId: 'approval-1' } as never,
            resumeClaimId: 'claim-1', stateVersion: current.stateVersion },
        event: { type: 'state-changed', atMs: clock.now(), stateVersion: current.stateVersion, leaseEpoch: 0, data: {} } }))
    // An owner-less space (created before owners were recorded) of the same profile.
    await store.createSpace({ taskSpaceId: 'space-legacy' as never, profileId, createdAtMs: 1, tabs: [] }, 16)
    const pauseReason = store.getTask(task.taskId)!.pauseReason
    await store.close()
    return { dir, clock, pauseReason, spaceId: space.taskSpaceId, taskId: task.taskId, tabId: opened.tabId }
}

describe('profile assignments', () => {
    it('stamps spaces and tasks with the assignment and records it once start-up is done', async () => {
        const a = await leftInFirstAssignment()
        const store = await TaskStore.open(a.dir)
        expect(store.getSpace(a.spaceId)!.assignmentId).toBe(FIRST)
        expect(store.getTask(a.taskId)!.assignmentId).toBe(FIRST)
        expect(store.getAppliedAssignments()).toEqual({ [profileId]: FIRST })
        expect(JSON.parse(await readFile(join(a.dir, 'assignments.json'), 'utf8')).assignments).toEqual({ [profileId]: FIRST })
        await store.close()
    })

    it('retires records without an assignment even if the applied generation already matches', async () => {
        const a = await leftInFirstAssignment()
        const opened = await TaskStore.open(a.dir)
        await opened.mutate(a.taskId, (task) => ({ patch: { assignmentId: undefined, pauseReason: 'outcome-unknown' },
            event: { type: 'state-changed', atMs: a.clock.now(), stateVersion: task.stateVersion, leaseEpoch: 0, data: {} } }))
        await opened.close()
        const { runtime, store } = await start(a.dir, FIRST, a.clock)
        expect(store.getSpace('space-legacy' as never)!.closed).toBe(true)
        expect(store.getTask(a.taskId)).toMatchObject({ status: 'cancelled', assignmentArchived: true, pauseReason: 'outcome-unknown', uncertainActions: ['action-click'] })
        await expect(runtime.takeOver({ credential: ui(), verifiedAtMs: a.clock.now() }, { taskId: a.taskId, tabId: a.tabId, expectedEpoch: 0, requestId: 'stale' as RequestId })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await store.close()
    })

    it('an ordinary restart in the same assignment keeps spaces, tasks, approvals and control', async () => {
        const a = await leftInFirstAssignment()
        const { runtime, store } = await start(a.dir, FIRST, a.clock)
        expect(runtime.principalStateReady()).toBe(true)
        expect(store.getSpace(a.spaceId)!.closed).not.toBe(true)
        const task = store.getTask(a.taskId)!
        expect(task.status).not.toBe('cancelled')
        expect(task.approvals['approval-1'].state).toBe('pending')
        expect(store.getSpace(a.spaceId)!.profileUserOwner).toBeTruthy()
        await store.close()
    })

    it('A → B → A: the same owner coming back in a new assignment finds everything of the first one ended', async () => {
        const a = await leftInFirstAssignment()
        // The switch to B failed before its Runtime ran; the owner is back with yet another assignment.
        const { runtime, store } = await start(a.dir, THIRD, a.clock)
        expect(runtime.assignmentReport()).toEqual({ state: 'ready', applied: { [profileId]: THIRD } })
        expect(store.getSpace(a.spaceId)).toMatchObject({ closed: true, reclaimReason: 'principal-changed', tabs: [], profileUserOwner: null })
        expect(store.getSpace('space-legacy' as never)).toMatchObject({ closed: true })
        const task = store.getTask(a.taskId)!
        // The write that may have reached the page is an uncertain outcome (kept by retention); nothing is resumable.
        expect(task).toMatchObject({ status: 'cancelled', pauseReason: a.pauseReason ?? 'cancelled-with-unknown-effect', assignmentArchived: true, tabs: [],
            pendingApproval: undefined, resumeClaimId: undefined })
        expect(task.actions['action-click'].state).toBe('uncertain')
        expect(task.uncertainActions).toEqual(['action-click'])
        expect(task.approvals['approval-1'].state).toBe('expired')
        expect(store.expiredTasks(Number.MAX_SAFE_INTEGER, 0).map((expired) => expired.taskId)).not.toContain(a.taskId)
        expect(runtime.leases.owner(a.tabId, profileId).owner).toEqual({ kind: 'none' })
        expect(runtime.isCurrentAssignmentTask(a.taskId)).toBe(false)

        // The first assignment's grant is refused although its owner is the configured one.
        await expect(runtime.createSpace({ credential: grant(FIRST), verifiedAtMs: a.clock.now() }, { profileId, requestId: 'again' as RequestId }))
            .rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await expect(runtime.createSpace({ credential: grant(undefined), verifiedAtMs: a.clock.now() }, { profileId, requestId: 'none' as RequestId }))
            .rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        // The owner may still read the record, but not act on it.
        await expect(runtime.getTask({ credential: ui(), verifiedAtMs: a.clock.now() }, { taskId: a.taskId })).resolves.toMatchObject({ status: 'cancelled' })
        await expect(runtime.takeOver({ credential: ui(), verifiedAtMs: a.clock.now() }, { taskId: a.taskId, tabId: a.tabId, expectedEpoch: 0,
            requestId: 'take-again' as RequestId })).rejects.toMatchObject({ code: expect.stringMatching(/SCOPE_DENIED|CONFLICT/) })
        // The new assignment has the whole quota.
        const auth = { credential: grant(THIRD, 'session-a3'), verifiedAtMs: a.clock.now() }
        for (let index = 0; index < POC_LIMITS.maxSpacesPerProfile; index++) await runtime.createSpace(auth, { profileId, requestId: `space-${index}` as RequestId })
        await store.close()

        // A later ordinary restart in the third assignment changes nothing of it.
        const again = await start(a.dir, THIRD, a.clock)
        expect(again.store.listSpaces().filter((space) => !space.closed)).toHaveLength(POC_LIMITS.maxSpacesPerProfile)
        await again.store.close()
    })

    it('an interrupted cleanup keeps the Runtime closed and runs again on the next start', async () => {
        const a = await leftInFirstAssignment()
        const failing = await TaskStore.open(a.dir)
        failing.commitAssignments = async () => { throw new Error('disk full') }
        const { runtime } = await start(a.dir, SECOND, a.clock, failing)
        expect(runtime.principalStateReady()).toBe(false)
        expect(runtime.assignmentReport()).toEqual({ state: 'failed', applied: { [profileId]: FIRST } })
        await expect(runtime.started()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
        await expect(runtime.createSpace({ credential: grant(SECOND), verifiedAtMs: a.clock.now() }, { profileId, requestId: 'x' as RequestId }))
            .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
        await failing.close()

        const { runtime: next, store } = await start(a.dir, SECOND, a.clock)
        expect(next.assignmentReport()).toEqual({ state: 'ready', applied: { [profileId]: SECOND } })
        expect(store.getTask(a.taskId)!.status).toBe('cancelled')
        await store.close()
    })

    it('fails closed when ending a task of the earlier assignment fails, and leaves the assignment unrecorded', async () => {
        const a = await leftInFirstAssignment()
        const failing = await TaskStore.open(a.dir)
        failing.mutate = async () => { throw new Error('journal write failed') }
        const { runtime } = await start(a.dir, SECOND, a.clock, failing)
        expect(runtime.assignmentReport().state).toBe('failed')
        await expect(runtime.getTask({ credential: ui(), verifiedAtMs: a.clock.now() }, { taskId: a.taskId })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
        await failing.close()
        const reopened = await TaskStore.open(a.dir)
        expect(reopened.getAppliedAssignments()).toEqual({ [profileId]: FIRST })
        await reopened.close()
    })

    it('the first start with assignments (schema 2 upgrade) retires the execution state of before, whatever its owner', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-assignment-')); dirs.push(dir)
        const clock = new FakeClock(100)
        const store = await TaskStore.open(dir)
        const before = new BrowserRuntime({ store, drivers: new Map([[profileId, new FakeBrowserDriver()]]), clock, sites })
        const auth = { credential: grant(undefined), verifiedAtMs: clock.now() }
        const space = await before.createSpace(auth, { profileId, requestId: 'space' as RequestId })
        const task = await before.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
        await store.close()
        const { runtime, store: after } = await start(dir, FIRST, clock)
        expect(runtime.assignmentReport()).toEqual({ state: 'ready', applied: { [profileId]: FIRST } })
        expect(after.getSpace(space.taskSpaceId)!.closed).toBe(true)
        expect(after.getTask(task.taskId)).toMatchObject({ status: 'cancelled', assignmentArchived: true })
        await after.close()
    })

    it('ends a task left in an earlier assignment even when its space is gone', async () => {
        const a = await leftInFirstAssignment()
        const store = await TaskStore.open(a.dir)
        await store.mutate(a.taskId, (current) => ({ patch: { taskSpaceId: 'space-gone' as never, stateVersion: current.stateVersion },
            event: { type: 'state-changed', atMs: 1, stateVersion: current.stateVersion, leaseEpoch: 0, data: {} } }))
        await store.close()
        const { store: after } = await start(a.dir, SECOND, a.clock)
        expect(after.getTask(a.taskId as TaskId)).toMatchObject({ status: 'cancelled', assignmentArchived: true })
        await after.close()
    })
})
