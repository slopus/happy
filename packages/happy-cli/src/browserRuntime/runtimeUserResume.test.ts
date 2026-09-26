import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentGrant, InteractiveCapability, ProfileId, RequestId, TabId } from './contracts'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** D8: a user resume needs no agent credential; the task's stored execution grant decides. */
async function createHarness(options: { grantExpiresAtMs?: number; url?: string } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'abp-user-resume-')); dirs.push(dir)
    const store = await TaskStore.open(dir); const clock = new FakeClock(100)
    const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, driver]]), clock, sites: fixtureSitePolicies(['https://fixture.test']) })
    const grant: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never,
        machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'],
        operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'finishTask', 'resume'],
        taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: options.grantExpiresAtMs ?? 3_600_000 }
    const auth = { credential: grant, verifiedAtMs: clock.now() }
    const capability: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui' as never, principalId: 'p' as never,
        workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId,
        operations: ['approve', 'takeOver', 'releaseControl', 'resume', 'getTask'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
    const ui = { credential: capability, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: options.url ?? 'https://fixture.test/start', requestId: 'open' as RequestId })
    const epoch = (tabId: TabId) => runtime.leases.owner(tabId, profileId).leaseEpoch
    const takeOverAndRelease = async (beforeRelease?: () => void) => {
        const taken = await runtime.takeOver(ui, { taskId: task.taskId, tabId: opened.tabId, expectedEpoch: epoch(opened.tabId), requestId: `take-${Math.random()}` as RequestId })
        beforeRelease?.()
        return (await runtime.releaseControl(ui, { taskId: task.taskId, tabId: opened.tabId, expectedEpoch: taken.leaseEpoch, requestId: `release-${Math.random()}` as RequestId })).task
    }
    const userResume = (expectedVersion: number) => runtime.resume(ui, { taskId: task.taskId, expectedVersion, requestId: `resume-${Math.random()}` as RequestId })
    return { store, clock, profileId, driver, runtime, auth, ui, task, opened, epoch, takeOverAndRelease, userResume }
}

describe('user resume from the client (interactive capability)', () => {
    it('returns a released takeover to awaiting-agent and lets the agent submit again', async () => {
        const h = await createHarness()
        const released = await h.takeOverAndRelease()
        expect(released.pauseReason).toBe('user-input-complete')
        const resumed = await h.userResume(released.stateVersion)
        expect(`${resumed.status}/${resumed.pauseReason}`).toBe('paused/awaiting-agent')
        const next = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: resumed.stateVersion, requestId: 'next' as RequestId,
            steps: [{ stepId: 's' as never, actionId: 'observe-1' as never, tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1000 }] }, { waitMs: 1000 })
        expect(next.result?.outcome).toBe('succeeded')
        await h.store.close()
    })

    it('resumes a login wait only after the page left the login path', async () => {
        const h = await createHarness({ url: 'https://fixture.test/login' })
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).waitReason).toBe('login')
        const stillLogin = await h.takeOverAndRelease()
        const waiting = await h.userResume(stillLogin.stateVersion)
        expect(`${waiting.status}/${waiting.waitReason}`).toBe('awaiting-user/login')
        const loggedIn = await h.takeOverAndRelease(() => h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/account', text: 'Signed in', elements: [] }))
        const resumed = await h.userResume(loggedIn.stateVersion)
        expect(`${resumed.status}/${resumed.pauseReason}/${resumed.waitReason ?? '-'}`).toBe('paused/awaiting-agent/-')
        await h.store.close()
    })

    it('refuses when the stored execution grant has expired even though the capability is valid', async () => {
        const h = await createHarness({ grantExpiresAtMs: 10_000 })
        const released = await h.takeOverAndRelease()
        h.clock.set(10_001)
        await expect(h.userResume(released.stateVersion)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        expect(h.store.getTask(h.task.taskId)?.pauseReason).toBe('user-input-complete')
        await h.store.close()
    })

    it('refuses when the stored execution grant was revoked', async () => {
        const h = await createHarness()
        const released = await h.takeOverAndRelease()
        await h.store.revoke('g')
        await expect(h.userResume(released.stateVersion)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        await h.store.close()
    })

    it('does not release a pending approval', async () => {
        const h = await createHarness()
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [{ ref: '@e1' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' }] })
        await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        const batch = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: (await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).stateVersion,
            requestId: 'pay' as RequestId, steps: [{ stepId: 'pay' as never, actionId: 'pay' as never, tabId: h.opened.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }] }, { waitMs: 1000 })
        expect(batch.result?.outcome).toBe('awaiting-user')
        await expect(h.userResume(batch.task.stateVersion)).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.driver.dispatchCounts.get('pay') ?? 0).toBe(0)
        await h.store.close()
    })

    it.each([
        ['an uncertain action', { uncertainActions: ['write-1' as never] }],
        ['a requested cancel', { cancelRequested: true }],
    ])('does not release a user-input-complete pause with %s', async (_label, patch) => {
        const h = await createHarness()
        const released = await h.takeOverAndRelease()
        const blocked = await h.store.commit(h.task.taskId, patch, { type: 'state-changed', atMs: 200, leaseEpoch: 0, data: {} })
        expect(blocked.pauseReason).toBe(released.pauseReason)
        await expect(h.userResume(blocked.stateVersion)).rejects.toMatchObject({ code: 'CONFLICT' })
        await h.store.close()
    })

    it('does not release browser-replaced (only the agent re-plans it)', async () => {
        const h = await createHarness()
        await h.runtime.onDriverDisconnected(h.profileId)
        h.driver.swapInstance()
        await h.runtime.onDriverReconnected(h.profileId)
        const replaced = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(replaced.pauseReason).toBe('browser-replaced')
        await expect(h.userResume(replaced.stateVersion)).rejects.toMatchObject({ code: 'CONFLICT' })
        await h.store.close()
    })
})

describe('user resume of a batch that stopped at a login page', () => {
    it('ends the batch with the unrun steps skipped so the agent re-plans them', async () => {
        const h = await createHarness()
        const batch = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: h.opened.task.stateVersion, requestId: 'to-login' as RequestId,
            steps: [
                { stepId: 'nav' as never, actionId: 'nav' as never, tabId: h.opened.tabId, kind: 'navigate', url: 'https://fixture.test/login', timeoutMs: 1000 },
                { stepId: 'after' as never, actionId: 'after' as never, tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1000 },
            ] }, { waitMs: 1000 })
        expect(`${batch.result?.outcome}/${batch.result?.waitReason}`).toBe('awaiting-user/login')
        const loggedIn = await h.takeOverAndRelease(() => h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/account', text: 'Signed in', elements: [] }))
        const resumed = await h.userResume(loggedIn.stateVersion)
        expect(`${resumed.status}/${resumed.pauseReason}`).toBe('paused/awaiting-agent')
        expect(resumed.currentBatchId).toBeUndefined()
        expect(resumed.lastBatch?.steps.map((step) => `${step.stepId}:${step.outcome}`)).toEqual(['nav:succeeded', 'after:skipped'])
        expect(h.driver.dispatchCounts.get('after') ?? 0).toBe(0)
        await h.store.close()
    })
})

describe('user resume revalidates the task when it commits', () => {
    type Harness = Awaited<ReturnType<typeof createHarness>>
    it.each<[string, (h: Harness) => Promise<unknown>]>([
        ['the execution grant is revoked', (h) => h.store.revoke('g')],
        ['the execution grant expires', async (h) => h.clock.set(3_600_001)],
        ['the agent cancels the task', (h) => h.runtime.cancel(h.auth, { taskId: h.task.taskId, requestId: 'cancel' as RequestId })],
        ['the user takes control again', (h) => h.runtime.takeOver(h.ui, { taskId: h.task.taskId, tabId: h.opened.tabId, expectedEpoch: h.epoch(h.opened.tabId), requestId: 'take-again' as RequestId })],
    ])('does not hand the task back when %s while the page is checked', async (_label, interfere) => {
        const h = await createHarness({ url: 'https://fixture.test/login' })
        const loggedIn = await h.takeOverAndRelease(() => h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/account', text: 'Signed in', elements: [] }))
        const held = h.driver.holdAfterNextDispatch('observe')
        const resuming = h.userResume(loggedIn.stateVersion)
        await held.entered
        await interfere(h)
        held.release()
        await expect(resuming).rejects.toMatchObject({ code: expect.stringMatching(/^(SCOPE_DENIED|CONFLICT)$/) })
        expect(h.store.getTask(h.task.taskId)?.pauseReason).not.toBe('awaiting-agent')
        await h.store.close()
    })
})
