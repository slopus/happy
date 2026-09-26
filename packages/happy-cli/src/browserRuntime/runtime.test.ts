import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AgentGrant, type FormSubmission, type InteractiveCapability, type ProfileId, type RequestId, type TabId } from './contracts'
import type { FakePage } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { formDigest, type SitePolicy } from './policy'

const FIXTURE_SITES = fixtureSitePolicies(['https://fixture.test'])
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function createHarness(prefix: string, expiresAtMs = 3_600_000, sites: SitePolicy[] = FIXTURE_SITES) {
    const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir)
    const store = await TaskStore.open(dir); const clock = new FakeClock(100)
    const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ sites, store, drivers: new Map([[profileId, driver]]), clock })
    const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'subscribe', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs }
    const auth = { credential, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
    const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
    const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
    return { dir, store, clock, profileId, driver, runtime, auth, space, task, opened }
}

async function readTree(root: string): Promise<string> {
    const entries = await readdir(root, { withFileTypes: true })
    const contents = await Promise.all(entries.map(async (entry) => {
        const path = join(root, entry.name)
        return entry.isDirectory() ? readTree(path) : readFile(path, 'utf8')
    }))
    return contents.join('\n')
}

async function observeHarnessTab(h: Awaited<ReturnType<typeof createHarness>>) {
    return h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
}

describe('BrowserRuntime durable request contract', () => {
    it('returns a task version from openPage and submitBatch that the next call can use as expectedVersion', async () => {
        const h = await createHarness('abp-runtime-version-')
        expect(h.opened.task.stateVersion).toBe((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).stateVersion)
        const submitted = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: h.opened.task.stateVersion,
            requestId: 'batch-version' as RequestId,
            steps: [{ stepId: 's1' as never, actionId: 'act-v1' as never, tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1_000 }],
        }, { waitMs: 2_000 })
        expect(submitted.result?.outcome).toBe('succeeded')
        const finished = await h.runtime.finishTask(h.auth, { taskId: h.task.taskId, expectedVersion: submitted.task.stateVersion, requestId: 'finish-version' as RequestId })
        expect(finished.status).toBe('succeeded')
        await h.store.close()
    })

    it('notifies waitForEvents after a committed event', async () => {
        const h = await createHarness('abp-runtime-events-')
        const afterSeq = (await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).highWatermarkSeq
        const waiting = h.runtime.waitForEvents(h.task.taskId, afterSeq, 2_000)
        await h.runtime.cancel(h.auth, { taskId: h.task.taskId, requestId: 'wake-cancel' as RequestId })
        const result = await waiting
        expect(result.kind).toBe('events')
        if (result.kind === 'events') expect(result.events.some((event) => event.type === 'cancel-accepted')).toBe(true)
        await h.store.close()
    })

    it('requires a snapshot when subscribe receives a cursor beyond the task high watermark', async () => {
        const h = await createHarness('abp-runtime-future-cursor-')
        const result = await h.runtime.subscribe(h.auth, {
            taskId: h.task.taskId,
            afterSeq: h.opened.task.highWatermarkSeq + 10,
        })
        expect(result.kind).toBe('snapshot-required')
        await h.store.close()
    })

    it('pauses expired grants during an idle sweep', async () => {
        const h = await createHarness('abp-runtime-sweep-', 200)
        h.clock.set(201)
        await h.runtime.sweep(h.clock.now())
        const task = await h.runtime.getTask({ ...h.auth, credential: { ...h.auth.credential, expiresAtMs: 10_000 } }, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('grant-expired')
        await h.store.close()
    })

    it('fences a revoked grant without waiting for another client request', async () => {
        const h = await createHarness('abp-runtime-revoke-')
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        const task = h.store.getTask(h.task.taskId)
        expect(task?.status).toBe('paused')
        expect(task?.pauseReason).toBe('grant-expired')
        expect(task?.cancelRequested).toBe(false)
        await h.store.close()
    })

    it('fences an in-flight batch using the grant that submitted that batch', async () => {
        const h = await createHarness('abp-runtime-revoke-batch-grant-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const observed = await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        const alternateAuth = { ...h.auth, credential: { ...h.auth.credential, grantId: 'g2' as never } }
        h.driver.setDelay('click', 500)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.submitBatch(alternateAuth, { taskId: h.task.taskId, expectedVersion: task.stateVersion,
            requestId: 'batch-grant-g2' as RequestId, steps: [{ stepId: 'g2-step' as never, actionId: 'g2-click' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, snapshotId: observed.snapshotId,
                timeoutMs: 1000 }] })
        await h.runtime.revokeGrant('g2' as never)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(current.status).toBe('paused')
        expect(current.pauseReason).toMatch(/grant-expired|outcome-unknown/)
        expect(h.driver.dispatchCounts.get('g2-click') ?? 0).toBe(0)
        await h.store.close()
    })

    it('expires an approval in sweep and requires a fresh approval after resume', async () => {
        const h = await createHarness('abp-runtime-approval-expiry-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@e1' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const initial = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: initial.stateVersion,
            requestId: 'approval-expiry-batch' as RequestId,
            steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never, tabId: h.opened.tabId,
                kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const oldApprovalId = batch.result?.pendingApproval?.approvalId
        expect(oldApprovalId).toBeTruthy()
        h.clock.set(600_101)
        await h.runtime.sweep(h.clock.now())
        const expired = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(expired.pauseReason).toBe('approval-expired')
        await h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: expired.stateVersion, requestId: 'approval-resume' as RequestId })
        const renewed = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(renewed.pendingApproval?.approvalId).not.toBe(oldApprovalId)
        expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('does not replay redacted approval steps after Runtime restart and records the interrupted step', async () => {
        const h = await createHarness('abp-runtime-approval-restart-interrupted-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const submitted = await h.runtime.submitBatch(h.auth, { taskId: task.taskId, expectedVersion: task.stateVersion,
            requestId: 'approval-restart-interrupted' as RequestId, steps: [{ stepId: 'pay-step' as never,
                actionId: 'pay-action' as never, tabId: h.opened.tabId, kind: 'click', ref: '@pay' as never,
                timeoutMs: 1000 }] }, { waitMs: 1000 })
        expect(submitted.result?.outcome).toBe('awaiting-user')
        await h.store.close()
        h.clock.set(600_101)
        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        await runtime.sweep(h.clock.now())
        const expired = await runtime.getTask(h.auth, { taskId: task.taskId })
        await runtime.resume(h.auth, { taskId: task.taskId, expectedVersion: expired.stateVersion,
            requestId: 'approval-restart-resume' as RequestId })
        const recovered = await runtime.getTask(h.auth, { taskId: task.taskId })
        expect(recovered.status).toBe('paused')
        expect(recovered.pauseReason).toBe('awaiting-agent')
        expect(recovered.lastBatch).toMatchObject({ outcome: 'failed', failedStep: 'pay-step', mayHaveSideEffects: false })
        expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        await store.close()
    })

    it('invalidates task tabs when a reconnected driver has a different browser instance', async () => {
        const h = await createHarness('abp-runtime-driver-restart-')
        await h.runtime.onDriverDisconnected(h.profileId)
        h.driver.swapInstance()
        await h.runtime.onDriverReconnected(h.profileId)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('browser-replaced')
        expect(task.tabs).toEqual([])
        expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).toEqual([])
        await h.store.close()
    })

    it('isolates a failed tab adoption and keeps unrelated task reads available after recovery', async () => {
        const h = await createHarness('abp-runtime-adopt-failure-')
        const stored = h.store.getTask(h.task.taskId)!
        await h.store.commit(h.task.taskId, {
            status: 'running',
            currentBatchId: 'batch-crash' as never,
            actions: { ...stored.actions, 'write-crash': { kind: 'click', batchId: 'batch-crash' as never,
                state: 'intent-committed', payloadHash: 'hash' } },
        }, { type: 'action-intent', atMs: h.clock.now(), leaseEpoch: 0, data: { actionId: 'write-crash' } })
        await h.store.close()
        h.driver.failNext('adoptTab', new Error('setupSession timed out'))
        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const recovered = await runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(recovered.status).toBe('paused')
        expect(recovered.pauseReason).toBe('outcome-unknown')
        expect(recovered.uncertainActions).toContain('write-crash')
        await expect(runtime.createSpace(h.auth, { profileId: h.profileId, requestId: 'recovery-still-live' as RequestId }))
            .resolves.toHaveProperty('taskSpaceId')
        await store.close()
    })

    it('keeps an unresolved write uncertain when recovery finds the task grant expired', async () => {
        const h = await createHarness('abp-runtime-recovery-expired-write-', 200)
        const task = h.store.getTask(h.task.taskId)!
        await h.store.commit(task.taskId, { status: 'running', currentBatchId: 'expired-batch' as never,
            actions: { ...task.actions, 'expired-write': { kind: 'click', batchId: 'expired-batch' as never,
                state: 'intent-committed', payloadHash: 'hash' } } }, {
            type: 'action-intent', atMs: h.clock.now(), leaseEpoch: 0, data: { actionId: 'expired-write' },
        })
        await h.store.close()
        h.clock.set(201)
        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const recoveryAuth = { ...h.auth, credential: { ...h.auth.credential, expiresAtMs: 10_000 } }
        const recovered = await runtime.getTask(recoveryAuth, { taskId: task.taskId })
        expect(recovered.pauseReason).toBe('outcome-unknown')
        expect(recovered.uncertainActions).toContain('expired-write')
        await store.close()
    })

    it('records openPage as a write intent with navigate kind before creating a tab', async () => {
        const h = await createHarness('abp-runtime-open-kind-')
        const action = Object.values(h.store.getTask(h.task.taskId)!.actions).find((entry) => entry.state === 'confirmed')
        expect(action?.kind).toBe('navigate')
        await h.store.close()
    })

    it('replays the openPage intent dedupe after an open failure without opening another tab', async () => {
        const h = await createHarness('abp-runtime-open-intent-dedupe-')
        const request = { taskId: h.task.taskId, url: 'https://fixture.test/retry-open',
            requestId: 'open-intent-retry' as RequestId }
        const opensBefore = h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length
        h.driver.failNext('openTab', new Error('response lost'))
        await expect(h.runtime.openPage(h.auth, request)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
        const retry = await h.runtime.openPage(h.auth, request)
        expect(retry.tabId).toBeTruthy()
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'openTab')).toHaveLength(opensBefore)
        await h.store.close()
    })

    it('does not extend paused retention when resuming an already awaiting-agent task', async () => {
        const h = await createHarness('abp-runtime-resume-bookkeeping-')
        const initial = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        for (let index = 0; index < 5; index++) {
            h.clock.advance(180)
            await h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: initial.stateVersion,
                requestId: `resume-noop-${index}` as RequestId })
        }
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).updatedAtMs).toBe(initial.updatedAtMs)
        await h.store.close()
    })

    it('atomically claims concurrent resumes with different request IDs', async () => {
        const h = await createHarness('abp-runtime-resume-race-')
        const before = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const results = await Promise.allSettled([
            h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: before.stateVersion,
                requestId: 'resume-race-a' as RequestId }),
            h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: before.stateVersion,
                requestId: 'resume-race-b' as RequestId }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).updatedAtMs).toBe(before.updatedAtMs)
        await h.store.close()
    })

    it('does not mark a space closed when a tab close fails', async () => {
        const h = await createHarness('abp-runtime-close-space-failure-')
        await h.runtime.finishTask(h.auth, { taskId: h.task.taskId,
            expectedVersion: (await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).stateVersion,
            requestId: 'finish-close-space' as RequestId })
        h.driver.failNext('closeTab', new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'blocked'))
        await expect(h.runtime.closeSpace(h.auth, { taskSpaceId: h.space.taskSpaceId,
            requestId: 'close-space-failure' as RequestId })).rejects.toThrow()
        expect(h.store.getSpace(h.space.taskSpaceId)?.closed).not.toBe(true)
        expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).toContain(h.opened.tabId)
        await h.store.close()
    })

    it('does not overwrite a grant pause when openPage finishes its final observation', async () => {
        const h = await createHarness('abp-runtime-open-late-pause-')
        const held = h.driver.holdAfterNextDispatch('observe')
        const opening = h.runtime.openPage(h.auth, { taskId: h.task.taskId, url: 'https://fixture.test/late-open',
            requestId: 'late-open' as RequestId })
        await held.entered
        await h.runtime.revokeGrant(h.auth.credential.grantId)
        held.release()
        await expect(opening).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
        const task = h.store.getTask(h.task.taskId)
        expect(task?.status).toBe('paused')
        expect(['grant-expired', 'outcome-unknown']).toContain(task?.pauseReason)
        expect(task?.tabs).toEqual([h.opened.tabId])
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'openTab')).toHaveLength(2)
        await h.store.close()
    })

    it('does not revive terminal tasks through resume or input control operations', async () => {
        const h = await createHarness('abp-runtime-terminal-control-')
        const finished = await h.runtime.finishTask(h.auth, { taskId: h.task.taskId,
            expectedVersion: (await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).stateVersion,
            requestId: 'finish-terminal-control' as RequestId })
        const uiCredential: InteractiveCapability = { kind: 'interactive', capabilityId: 'terminal-control-ui' as never,
            principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        const epoch = h.runtime.leases.takeOver(h.opened.tabId, h.profileId,
            { kind: 'user', principalId: 'p' as never, viewerSessionId: 'viewer' })
        await expect(h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: finished.stateVersion,
            requestId: 'resume-terminal' as RequestId })).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.runtime.takeOver(uiAuth, { taskId: h.task.taskId, tabId: h.opened.tabId,
            expectedEpoch: epoch, requestId: 'takeover-terminal' as RequestId })).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.runtime.releaseControl(uiAuth, { taskId: h.task.taskId, tabId: h.opened.tabId,
            expectedEpoch: epoch, requestId: 'release-terminal' as RequestId })).rejects.toMatchObject({ code: 'CONFLICT' })
        await h.store.close()
    })

    it('restores a disconnected task when the browser instance is unchanged', async () => {
        const h = await createHarness('abp-runtime-driver-resume-')
        await h.runtime.onDriverDisconnected(h.profileId)
        await h.runtime.onDriverReconnected(h.profileId)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('awaiting-agent')
        expect(task.tabs).toContain(h.opened.tabId)
        await h.store.close()
    })

    it('resolves a recovering task during sweep when the driver is connected and no worker exists', async () => {
        const h = await createHarness('abp-runtime-sweep-recovering-')
        const task = h.store.getTask(h.task.taskId)!
        await h.store.commit(task.taskId, { status: 'recovering', previousDriverStatus: 'running' }, {
            type: 'recovered', atMs: h.clock.now(), leaseEpoch: 0, data: { test: true },
        })
        await h.runtime.sweep(h.clock.now())
        expect(h.store.getTask(task.taskId)).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        await h.store.close()
    })

    it('leaves a recovering task to reconnect handling while it runs, so a replaced browser is still recorded as replaced', async () => {
        const h = await createHarness('abp-runtime-sweep-reconnect-race-')
        await h.runtime.onDriverDisconnected(h.profileId)
        expect(h.store.getTask(h.task.taskId)?.status).toBe('recovering')
        // The driver is connected to a new browser, but reconnect handling has not reached this task yet.
        h.driver.swapInstance()
        await h.runtime.sweep(h.clock.now())
        expect(h.store.getTask(h.task.taskId)?.status).toBe('recovering')
        await h.runtime.onDriverReconnected(h.profileId)
        expect(h.store.getTask(h.task.taskId)).toMatchObject({ status: 'paused', pauseReason: 'browser-replaced' })
        await h.store.close()
    })

    it('accepts only one concurrent batch for an expected task version', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-version-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        const expectedVersion = (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion
        const request = (requestId: string) => runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion, requestId: requestId as RequestId, steps: [{ stepId: `step-${requestId}` as never, actionId: `action-${requestId}` as never, tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'ready' }, timeoutMs: 1000 }] })
        const results = await Promise.allSettled([request('batch-a'), request('batch-b')])
        expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
        await store.close()
    })

    it('deduplicates concurrent identical batch requests before dispatch', async () => {
        const h = await createHarness('abp-runtime-batch-duplicate-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@e1' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const request = {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'same-batch-request' as RequestId,
            steps: [{ stepId: 'same-step' as never, actionId: 'same-action' as never, tabId: h.opened.tabId,
                kind: 'click' as const, ref: '@e1' as never, timeoutMs: 1000 }],
        }
        const [first, duplicate] = await Promise.all([
            h.runtime.submitBatch(h.auth, request, { waitMs: 1000 }),
            h.runtime.submitBatch(h.auth, request),
        ])
        expect(duplicate.batchId).toBe(first.batchId)
        await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(h.driver.dispatchCounts.get('same-action')).toBe(1)
        await h.store.close()
    })

    it('deduplicates concurrent openPage calls with one external tab creation', async () => {
        const h = await createHarness('abp-runtime-open-duplicate-')
        const initialOpens = h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length
        h.driver.setDelay('openTab', 25)
        const request = { taskId: h.task.taskId, url: 'https://fixture.test/duplicate', requestId: 'open-same' as RequestId }
        const [first, second] = await Promise.all([
            h.runtime.openPage(h.auth, request),
            h.runtime.openPage(h.auth, request),
        ])
        expect(first.tabId).toBe(second.tabId)
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length - initialOpens).toBe(1)
        await h.store.close()
    })

    it('replays a mutation request result from the journal after reopening the runtime', async () => {
        const h = await createHarness('abp-runtime-dedupe-restart-')
        const request = { taskId: h.task.taskId, requestId: 'cancel-durable' as RequestId }
        const first = await h.runtime.cancel(h.auth, request)
        await h.store.close()

        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const dispatchCount = h.driver.dispatchCounts.size
        const replay = await runtime.cancel(h.auth, request)

        expect(replay).toEqual(first)
        expect(h.driver.dispatchCounts.size).toBe(dispatchCount)
        await store.close()
    })

    it('refuses to close a tab through a different task space even after its task finishes', async () => {
        const h = await createHarness('abp-runtime-cross-space-close-')
        const taskView = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.finishTask(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: taskView.stateVersion,
            requestId: 'finish-before-cross-close' as RequestId,
        })
        const otherSpace = await h.runtime.createSpace(h.auth, {
            profileId: h.profileId,
            requestId: 'other-space' as RequestId,
        })

        await expect(h.runtime.closePage(h.auth, {
            taskSpaceId: otherSpace.taskSpaceId,
            tabId: h.opened.tabId,
            requestId: 'cross-space-close' as RequestId,
        })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        expect(h.driver.hasTab(h.opened.tabId)).toBe(true)
        await h.store.close()
    })

    it('deduplicates concurrent closePage requests before the driver closes the tab', async () => {
        const h = await createHarness('abp-runtime-close-duplicate-')
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.finishTask(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: task.stateVersion,
            requestId: 'finish-before-close' as RequestId,
        })
        const before = h.driver.targetLedger.filter((entry) => entry.operation === 'closeTab').length
        h.driver.setDelay('closeTab', 25)
        const request = { taskSpaceId: h.space.taskSpaceId, tabId: h.opened.tabId, requestId: 'same-close' as RequestId }
        const [first, duplicate] = await Promise.all([
            h.runtime.closePage(h.auth, request),
            h.runtime.closePage(h.auth, request),
        ])

        expect(duplicate).toEqual(first)
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'closeTab').length - before).toBe(1)
        await h.store.close()
    })

    it('keeps login waits through takeover and resumes only after the URL leaves the login path', async () => {
        const h = await createHarness('abp-runtime-login-wait-')
        const loginPage = await h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/login',
            requestId: 'open-login' as RequestId,
        })
        const awaiting = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(awaiting.status).toBe('awaiting-user')
        expect(awaiting.waitReason).toBe('login')
        expect(h.store.getTask(h.task.taskId)?.waitCompletion).toMatchObject({
            tabId: loginPage.tabId,
            notPathPrefix: '/login',
        })

        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'login-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'login-viewer',
            profileId: h.profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        const leaseManager = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const firstTakeover = await h.runtime.takeOver(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: leaseManager.owner(loginPage.tabId, h.profileId).leaseEpoch,
            requestId: 'login-takeover' as RequestId,
        })
        await expect(h.runtime.resume(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: firstTakeover.task.stateVersion,
            requestId: 'resume-during-control' as RequestId,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        const released = await h.runtime.releaseControl(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: firstTakeover.leaseEpoch,
            requestId: 'login-release' as RequestId,
        })
        const stillWaiting = await h.runtime.resume(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: released.task.stateVersion,
            requestId: 'resume-still-login' as RequestId,
        })
        expect(stillWaiting.status).toBe('awaiting-user')
        expect(stillWaiting.waitReason).toBe('login')

        const secondTakeover = await h.runtime.takeOver(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: leaseManager.owner(loginPage.tabId, h.profileId).leaseEpoch,
            requestId: 'login-takeover-again' as RequestId,
        })
        h.driver.seedTab(loginPage.tabId, { url: 'https://fixture.test/account', text: 'Signed in', elements: [] })
        const secondRelease = await h.runtime.releaseControl(uiAuth, {
            taskId: h.task.taskId,
            tabId: loginPage.tabId,
            expectedEpoch: secondTakeover.leaseEpoch,
            requestId: 'login-release-again' as RequestId,
        })
        const resumed = await h.runtime.resume(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: secondRelease.task.stateVersion,
            requestId: 'resume-after-login' as RequestId,
        })
        expect(resumed.status).toBe('paused')
        expect(resumed.pauseReason).toBe('awaiting-agent')
        await h.store.close()
    })

    it('expires idle user login waits without resuming execution', async () => {
        const h = await createHarness('abp-runtime-login-expiry-')
        await h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/login',
            requestId: 'open-expiring-login' as RequestId,
        })
        const dispatchCount = h.driver.dispatchCounts.size
        h.clock.set(600_101)
        await h.runtime.sweep(h.clock.now())

        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('user-wait-expired')
        expect(task.waitReason).toBe('login')
        expect(h.driver.dispatchCounts.size).toBe(dispatchCount)
        await h.store.close()
    })

    it('re-adopts owned targets and restores lease epochs after a Runtime-only restart', async () => {
        const h = await createHarness('abp-runtime-adopt-same-browser-')
        const targetId = h.driver.targetLedger.find((entry) => entry.tabId === h.opened.tabId
            && entry.operation === 'openTab')?.targetId
        const leaseManager = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const previousEpoch = leaseManager.owner(h.opened.tabId, h.profileId).leaseEpoch
        await h.store.close()

        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const task = await runtime.getTask(h.auth, { taskId: h.task.taskId })
        const restoredLeases = (runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases

        expect(targetId).toBeTruthy()
        expect(h.driver.adoptedTabs).toContainEqual({ tabId: h.opened.tabId, targetId, adopted: true })
        expect(task.tabs).toContain(h.opened.tabId)
        expect((await runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })).url)
            .toBe('https://fixture.test/start')
        expect(restoredLeases.owner(h.opened.tabId, h.profileId).leaseEpoch).toBe(previousEpoch + 1)
        expect((store.getSpace(h.space.taskSpaceId) as unknown as { tabTargets?: Record<string, string> })?.tabTargets?.[h.opened.tabId])
            .toBe(targetId)
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'adopt-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'adopt-viewer',
            profileId: h.profileId, operations: ['takeOver'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const takeover = await runtime.takeOver({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId,
            tabId: h.opened.tabId,
            expectedEpoch: restoredLeases.owner(h.opened.tabId, h.profileId).leaseEpoch,
            requestId: 'take-over-restored-lease' as RequestId,
        })
        expect(takeover.leaseEpoch).toBe(previousEpoch + 2)
        await store.close()

        const restartedStore = await TaskStore.open(h.dir)
        const restartedRuntime = new BrowserRuntime({ sites: FIXTURE_SITES, store: restartedStore, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        await restartedRuntime.getTask(h.auth, { taskId: h.task.taskId })
        const restartedLeases = (restartedRuntime as unknown as {
            leases: {
                owner(tabId: string, profileId: ProfileId): { owner: { kind: string }; leaseEpoch: number }
                isUserFenced(profileId: ProfileId): boolean
            }
        }).leases
        expect(restartedLeases.owner(h.opened.tabId, h.profileId)).toMatchObject({
            owner: { kind: 'user' },
            leaseEpoch: takeover.leaseEpoch + 1,
        })
        expect(restartedLeases.isUserFenced(h.profileId)).toBe(true)
        await restartedStore.close()
    })

    it('drops tabs and space references when Runtime restarts against a different browser instance', async () => {
        const h = await createHarness('abp-runtime-adopt-replaced-browser-')
        h.driver.swapInstance()
        await h.store.close()

        const store = await TaskStore.open(h.dir)
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const task = await runtime.getTask(h.auth, { taskId: h.task.taskId })

        expect(task.pauseReason).toBe('browser-replaced')
        expect(task.tabs).toEqual([])
        expect(store.getSpace(h.space.taskSpaceId)?.tabs).toEqual([])
        expect(store.getSpace(h.space.taskSpaceId)?.goneTabs).toContain(h.opened.tabId)
        expect(await runtime.closePage(h.auth, {
            taskSpaceId: h.space.taskSpaceId,
            tabId: h.opened.tabId,
            requestId: 'close-already-gone' as RequestId,
        })).toEqual({ closed: false })
        await store.close()
    })

    it('fences immediately on takeover and exposes settling until the driver call returns', async () => {
        const h = await createHarness('abp-runtime-takeover-settling-')
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        h.driver.setIgnoreWaitAbort(true)
        const running = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: view.stateVersion,
            requestId: 'takeover-running' as RequestId,
            steps: [{ stepId: 'wait' as never, actionId: 'wait' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'release' }, timeoutMs: 120_000 }],
        }, { waitMs: 5000 })
        await h.driver.waitForEntered

        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'settle-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'settle-viewer',
            profileId: h.profileId, operations: ['takeOver', 'releaseControl'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        const leaseManager = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { owner: { kind: string }; leaseEpoch: number } } }).leases
        const takeover = await h.runtime.takeOver(uiAuth, {
            taskId: h.task.taskId,
            tabId: h.opened.tabId,
            expectedEpoch: leaseManager.owner(h.opened.tabId, h.profileId).leaseEpoch,
            requestId: 'takeover-active-call' as RequestId,
        })

        expect(takeover).toMatchObject({ settling: true, owner: { kind: 'none' } })
        expect(leaseManager.owner(h.opened.tabId, h.profileId).owner.kind).toBe('none')
        h.driver.releaseWait()
        await running
        expect(leaseManager.owner(h.opened.tabId, h.profileId).owner.kind).toBe('user')
        await h.store.close()
    })

    it('keeps synthetic canaries and password values out of journal files and batch results', async () => {
        const h = await createHarness('abp-runtime-redaction-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            title: 'Fixture',
            text: 'ABP-CANARY-FRAME-x',
            frameOrigins: ['https://untrusted.test'],
            elements: [{ ref: '@password' as never, role: 'textbox', name: 'Password', value: 'synthetic-password',
                visible: true, frameOrigin: 'https://fixture.test' }],
        })
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: view.stateVersion,
            requestId: 'redaction-observe' as RequestId,
            steps: [{ stepId: 'observe' as never, actionId: 'observe' as never, tabId: h.opened.tabId,
                kind: 'observe', timeoutMs: 1000 }],
        }, { waitMs: 1000 })

        expect(JSON.stringify(batch)).not.toContain('ABP-CANARY-FRAME-x')
        expect(JSON.stringify(batch)).not.toContain('synthetic-password')
        const contents = await readTree(h.dir)
        expect(contents).not.toContain('ABP-CANARY-FRAME-x')
        expect(contents).not.toContain('synthetic-password')
        await h.store.close()
    })

    it('keeps a legitimately in-flight 120 second waitFor live during stale-worker sweep', async () => {
        const h = await createHarness('abp-runtime-wait-heartbeat-')
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const pending = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: task.stateVersion,
            requestId: 'long-wait' as RequestId,
            steps: [{ stepId: 'wait-step' as never, actionId: 'wait-action' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'release me' }, timeoutMs: 120_000 }],
        }, { waitMs: 120_000 })
        await h.driver.waitForEntered
        h.clock.set(61_000)
        await h.runtime.sweep(h.clock.now())
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).status).toBe('running')
        h.driver.releaseWait()
        const result = await pending
        expect(result.result?.outcome).toBe('succeeded')
        await h.store.close()
    })

    it('preserves user-control when a fenced waitFor fails after takeover', async () => {
        const h = await createHarness('abp-runtime-takeover-wait-failure-')
        h.driver.setIgnoreWaitAbort(true)
        const held = h.driver.holdAfterNextDispatch('waitFor')
        h.driver.failNext('waitFor', new BrowserRuntimeError('OUTCOME_UNKNOWN', 'synthetic wait failure', false, false))
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const running = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'takeover-wait-failure-batch' as RequestId,
            steps: [{ stepId: 'wait' as never, actionId: 'wait' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'release' }, timeoutMs: 120_000 }],
        }, { waitMs: 5000 })
        await h.driver.waitForEntered
        const live = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'wait-failure-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'wait-failure-viewer',
            profileId: h.profileId, operations: ['takeOver'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const takeover = await h.runtime.takeOver({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId, tabId: h.opened.tabId,
            expectedEpoch: live.tabLeases?.[0].leaseEpoch ?? 0, requestId: 'takeover-wait-failure' as RequestId,
        })
        expect(takeover.task.pauseReason).toBe('user-control')
        held.release()
        await running

        const after = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(after.pauseReason).toBe('user-control')
        expect(after.status).toBe('paused')
        await h.store.close()
    })

    it('pauses after a timed-out read-only step so the same task can accept a follow-up batch', async () => {
        const h = await createHarness('abp-runtime-read-timeout-')
        h.driver.failNext('waitFor', new BrowserRuntimeError('OUTCOME_UNKNOWN', 'read-only wait timed out', true, false))
        const initial = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const failed = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: initial.stateVersion,
            requestId: 'read-timeout' as RequestId,
            steps: [{ stepId: 'timeout-step' as never, actionId: 'timeout-action' as never, tabId: h.opened.tabId,
                kind: 'waitFor', until: { kind: 'text', text: 'missing' }, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(failed.result).toMatchObject({ outcome: 'failed', failedStep: 'timeout-step', mayHaveSideEffects: false })
        expect(failed.task.status).toBe('paused')
        expect(failed.task.pauseReason).toBe('awaiting-agent')
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const followup = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'read-timeout-followup' as RequestId,
            steps: [{ stepId: 'observe-step' as never, actionId: 'observe-action' as never, tabId: h.opened.tabId,
                kind: 'observe', timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(followup.result?.outcome).toBe('succeeded')
        await h.store.close()
    })

    it('replays an accepted batch for the same request and dispatches its action once', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId
        const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        driver.seedTab(opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@e1' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' },
        ] })
        await runtime.observe(auth, { taskId: task.taskId, tabId: opened.tabId })
        const request = { taskId: task.taskId, expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: 'batch-req' as RequestId, steps: [{ stepId: 'step-1' as never, actionId: 'action-1' as never, tabId: opened.tabId, kind: 'click' as const, ref: '@e1' as never, timeoutMs: 1000 }] }
        const first = await runtime.submitBatch(auth, request, { waitMs: 1_000 })
        const duplicate = await runtime.submitBatch(auth, request, { waitMs: 1_000 })
        expect(first.batchId).toBe(duplicate.batchId)
        expect(driver.dispatchCounts.get('action-1')).toBe(1)
        await expect(runtime.submitBatch(auth, { ...request, steps: [{ ...request.steps[0], ref: '@e2' as never }] }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await store.close()
    })

    it('rejects a confirmed actionId reused in a new batch', async () => {
        const h = await createHarness('abp-runtime-action-id-reuse-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const first = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: first.stateVersion,
            requestId: 'action-reuse-first' as RequestId,
            steps: [{ stepId: 'first-step' as never, actionId: 'reused-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const ready = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await expect(h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: ready.stateVersion,
            requestId: 'action-reuse-second' as RequestId,
            steps: [{ stepId: 'first-step' as never, actionId: 'reused-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, timeoutMs: 1000 }],
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.driver.dispatchCounts.get('reused-action')).toBe(1)
        await h.store.close()
    })

    it('fences a hanging waitFor without waiting for it and prevents later dispatch', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-cancel-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        const pendingBatch = runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: 'hang-batch' as RequestId, steps: [
            { stepId: 'wait-step' as never, actionId: 'wait-action' as never, tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'never' }, timeoutMs: 120_000 },
            { stepId: 'click-step' as never, actionId: 'click-action' as never, tabId: opened.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 },
        ] }, { waitMs: 60_000 })
        await driver.waitForEntered
        const before = Date.now()
        const cancelled = await runtime.cancel(auth, { taskId: task.taskId, requestId: 'cancel-req' as RequestId })
        expect(Date.now() - before).toBeLessThan(2000)
        expect(cancelled.task.status).toBe('cancelled')
        await pendingBatch
        await Promise.resolve()
        expect(driver.dispatchCounts.get('click-action') ?? 0).toBe(0)
        await store.close()
    })

    it('keeps cancel outcome unknown when input was sent before the worker confirmation commit', async () => {
        const h = await createHarness('abp-runtime-cancel-confirm-race-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            elements: [{ ref: '@e1' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        await observeHarnessTab(h)
        const held = h.driver.holdAfterNextDispatch('click')
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: view.stateVersion,
            requestId: 'click-then-cancel' as RequestId,
            steps: [
                { stepId: 'click' as never, actionId: 'click-before-cancel' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@e1' as never, timeoutMs: 1000 },
                { stepId: 'later' as never, actionId: 'must-not-dispatch' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@e1' as never, timeoutMs: 1000 },
            ],
        }, { waitMs: 5000 })
        await held.entered
        const cancelled = await h.runtime.cancel(h.auth, {
            taskId: h.task.taskId,
            requestId: 'cancel-after-input' as RequestId,
        })
        expect(cancelled.task.status).toBe('paused')
        expect(cancelled.task.pauseReason).toBe('cancelled-with-unknown-effect')
        held.release()
        await batch

        const finalTask = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(finalTask.status).toBe('paused')
        expect(finalTask.pauseReason).toBe('cancelled-with-unknown-effect')
        expect(finalTask.uncertainActions).toContain('click-before-cancel')
        expect(h.driver.dispatchCounts.get('must-not-dispatch') ?? 0).toBe(0)
        await h.store.close()
    })

    it('recovers a write intent as outcome-unknown without resending it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-recovery-')); dirs.push(dir)
        let store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        await store.commit(task.taskId, { status: 'running', actions: { 'uncertain-action': { state: 'intent-committed', kind: 'click', payloadHash: 'synthetic', batchId: 'batch-x' as never, leaseEpoch: 3, browserInstanceId: driver.browserInstanceId() } } }, { type: 'action-intent', atMs: 101, stateVersion: 10, leaseEpoch: 3, data: { actionId: 'uncertain-action' } })
        await store.close()
        store = await TaskStore.open(dir)
        const recovered = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[profileId, driver]]), clock })
        const view = await recovered.getTask(auth, { taskId: task.taskId })
        expect(view.status).toBe('paused')
        expect(view.pauseReason).toBe('outcome-unknown')
        expect(view.uncertainActions).toContain('uncertain-action')
        expect(driver.dispatchCounts.get('uncertain-action') ?? 0).toBe(0)
        await store.close()
        void opened
    })

    it('blocks agent self-approval and consumes a bound interactive approval once', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-runtime-approval-')); dirs.push(dir)
        const store = await TaskStore.open(dir); const clock = new FakeClock(100)
        const profileId = 'profile-1' as ProfileId; const driver = new FakeBrowserDriver()
        const runtime = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[profileId, driver]]), clock })
        const credential: AgentGrant = { kind: 'agent-grant', grantId: 'g' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, agentSessionId: 'a' as never, profileId, allowedOrigins: ['https://fixture.test'], operations: ['createSpace', 'createTask', 'openPage', 'submitBatch', 'getTask', 'cancel', 'observe', 'screenshot', 'finishTask', 'resume', 'closePage', 'closeSpace'], taskSpaceIds: [], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const auth = { credential, verifiedAtMs: clock.now() }
        const space = await runtime.createSpace(auth, { profileId, requestId: 'space-req' as RequestId })
        const task = await runtime.createTask(auth, { taskSpaceId: space.taskSpaceId, requestId: 'task-req' as RequestId })
        const opened = await runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test/start', requestId: 'open-req' as RequestId })
        driver.seedTab(opened.tabId, { url: 'https://fixture.test/start', elements: [{ ref: '@e1' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' }] })
        await runtime.observe(auth, { taskId: task.taskId, tabId: opened.tabId })
        const batch = await runtime.submitBatch(auth, { taskId: task.taskId, expectedVersion: (await runtime.getTask(auth, { taskId: task.taskId })).stateVersion, requestId: 'approval-batch' as RequestId, steps: [{ stepId: 'pay' as never, actionId: 'pay-action' as never, tabId: opened.tabId, kind: 'click', ref: '@e1' as never, timeoutMs: 1000 }] }, { waitMs: 1000 })
        expect(batch.result?.outcome).toBe('awaiting-user')
        expect(driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        const approval = batch.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        await expect(runtime.approve(auth, { taskId: task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash, requestId: 'self-approve' as RequestId, decision: 'approve', human: true } as never)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
        const uiCredential: InteractiveCapability = { kind: 'interactive', capabilityId: 'ui-cap' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const uiAuth = { credential: uiCredential, verifiedAtMs: clock.now() }
        const request = { taskId: task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash, requestId: 'ui-approve' as RequestId, decision: 'approve' as const }
        const first = await runtime.approve(uiAuth, request)
        const duplicate = await runtime.approve(uiAuth, request)
        expect(first.outcome).toBe('approved')
        expect(duplicate.outcome).toBe('approved')
        expect(driver.dispatchCounts.get('pay-action')).toBe(1)
        expect((await runtime.getTask(auth, { taskId: task.taskId })).pauseReason).toBe('outcome-unknown')
        await store.close()
    })

    it('never dispatches an approved action after a concurrent cancel ACK across 50 races', async () => {
        for (let index = 0; index < 50; index++) {
            const h = await createHarness(`abp-runtime-approve-cancel-${index}-`)
            h.driver.seedTab(h.opened.tabId, {
                url: 'https://fixture.test/start',
                elements: [{ ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                    frameOrigin: 'https://fixture.test' }],
            })
            await observeHarnessTab(h)
            const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
            const submitted = await h.runtime.submitBatch(h.auth, {
                taskId: h.task.taskId,
                expectedVersion: current.stateVersion,
                requestId: `race-batch-${index}` as RequestId,
                steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }],
            }, { waitMs: 1000 })
            const approval = submitted.result?.pendingApproval
            if (!approval) throw new Error('test requires an approval to race')
            const uiCredential: InteractiveCapability = {
                kind: 'interactive', capabilityId: `race-ui-${index}` as never, principalId: 'p' as never,
                workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: `viewer-${index}`,
                profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
            }
            const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
            const requestId = `race-approve-${index}` as RequestId
            let cancelAcknowledged = false
            let dispatchedAfterCancelAck = false
            h.driver.observeDispatches((actionId) => {
                if (actionId === 'pay-action' && cancelAcknowledged)
                    dispatchedAfterCancelAck = true
            })
            const approvalRequest = h.runtime.approve(uiAuth, {
                taskId: h.task.taskId,
                approvalId: approval.approvalId,
                bindingHash: approval.bindingHash,
                requestId,
                decision: 'approve',
            })
            const cancelRequest = h.runtime.cancel(h.auth, {
                taskId: h.task.taskId,
                requestId: `race-cancel-${index}` as RequestId,
            }).then((result) => {
                cancelAcknowledged = true
                return result
            })
            const [approveResult, cancelResult] = await Promise.allSettled([approvalRequest, cancelRequest])

            expect(cancelResult.status).toBe('fulfilled')
            expect(dispatchedAfterCancelAck).toBe(false)
            expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBeLessThanOrEqual(1)
            expect(approveResult.status === 'fulfilled' && cancelResult.status === 'fulfilled'
                && approveResult.value.outcome === 'approved'
                && cancelResult.value.task.status === 'cancelled'
                && dispatchedAfterCancelAck).toBe(false)
            await h.store.close()
        }
    }, 30_000)

    it('approves only the submit click and binds approval to the filled form values', async () => {
        const h = await createHarness('abp-runtime-submit-approval-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/risky-submit',
            elements: [
                { ref: '@amount' as never, role: 'textbox', name: 'Amount', value: '', visible: true, frameOrigin: 'https://fixture.test' },
                { ref: '@submit' as never, role: 'button', name: 'Confirm payment', visible: true, frameOrigin: 'https://fixture.test' },
            ],
        })
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'submit-amount' as RequestId,
            steps: [
                { stepId: 'fill-amount' as never, actionId: 'fill-amount' as never, tabId: h.opened.tabId,
                    kind: 'fill', ref: '@amount' as never, value: '5', timeoutMs: 1000 },
                { stepId: 'submit-order' as never, actionId: 'submit-order' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@submit' as never, timeoutMs: 1000 },
            ],
        }, { waitMs: 1000 })

        expect(batch.result?.outcome).toBe('awaiting-user')
        expect(batch.result?.completedSteps).toContain('fill-amount')
        expect(batch.result?.pendingApproval?.actionId).toBe('submit-order')
        expect(batch.result?.pendingApproval?.description).toContain('Confirm payment')
        expect(batch.result?.pendingApproval?.description).toContain('Amount')
        expect(batch.result?.pendingApproval?.description).not.toContain('Amount=5')
        expect(h.driver.dispatchCounts.get('fill-amount')).toBe(1)
        expect(h.driver.dispatchCounts.get('submit-order') ?? 0).toBe(0)

        const approval = batch.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending submit approval')
        const observeCountBeforeApproval = h.driver.observeCount
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'submit-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/risky-submit',
            elements: [
                { ref: '@amount' as never, role: 'textbox', name: 'Amount', value: '6', visible: true, frameOrigin: 'https://fixture.test' },
                { ref: '@submit' as never, role: 'button', name: 'Confirm payment', visible: true, frameOrigin: 'https://fixture.test' },
            ],
        })
        await expect(h.runtime.approve(uiAuth, {
            taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash,
            requestId: 'approve-changed-amount' as RequestId, decision: 'approve',
        })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
        expect(h.driver.observeCount).toBe(observeCountBeforeApproval)
        expect(h.driver.dispatchCounts.get('submit-order') ?? 0).toBe(0)
        await h.store.close()
    })

    it('keeps an approval usable after rejecting an agent observe of its bound tab', async () => {
        const h = await createHarness('abp-runtime-approval-observe-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: current.stateVersion,
            requestId: 'approval-observe-batch' as RequestId, steps: [{ stepId: 'pay' as never, actionId: 'pay' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }] }, { waitMs: 1000 })
        const approval = batch.result?.pendingApproval
        expect(approval).toBeTruthy()
        await expect(observeHarnessTab(h)).rejects.toMatchObject({ code: 'CONFLICT' })
        const uiCredential: InteractiveCapability = { kind: 'interactive', capabilityId: 'approval-observe-ui' as never,
            principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const approved = await h.runtime.approve({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId, approvalId: approval!.approvalId, bindingHash: approval!.bindingHash,
            requestId: 'approval-observe-approve' as RequestId, decision: 'approve',
        })
        expect(approved.outcome).toBe('approved')
        expect(h.driver.dispatchCounts.get('pay')).toBe(1)
        await h.store.close()
    })

    it('keeps an approved submit click uncertain until a trusted postcondition is observed', async () => {
        const h = await createHarness('abp-runtime-submit-uncertain-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            elements: [{ ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const submitted = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'submit-uncertain-batch' as RequestId,
            steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never, tabId: h.opened.tabId,
                kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const approval = submitted.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'submit-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const result = await h.runtime.approve({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash,
            requestId: 'submit-uncertain-approve' as RequestId, decision: 'approve',
        })

        expect(result.batch?.outcome).toBe('uncertain')
        expect(result.batch?.mayHaveSideEffects).toBe(true)
        expect(result.task.pauseReason).toBe('outcome-unknown')
        await expect(h.runtime.finishTask(h.auth, {
            taskId: h.task.taskId, expectedVersion: result.task.stateVersion, requestId: 'submit-uncertain-finish' as RequestId,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        await h.store.close()
    })

    it('expires approval when the described submit node was replaced without a navigation', async () => {
        const h = await createHarness('abp-runtime-approval-node-replaced-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const submitted = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'node-replaced-submit' as RequestId,
            steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const approval = submitted.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@pay' as never, role: 'button', name: 'Decoy', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'node-replaced-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        await expect(h.runtime.approve({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash,
            requestId: 'approve-replaced-node' as RequestId, decision: 'approve',
        })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
        expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('records a pre-dispatch STALE_REF refusal as a failed step without side effects', async () => {
        const h = await createHarness('abp-runtime-pre-dispatch-refusal-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            elements: [{ ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        await observeHarnessTab(h)
        h.driver.failNext('describeRef', new BrowserRuntimeError('STALE_REF', 'stale synthetic ref', false, false))
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const result = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'pre-dispatch-refusal' as RequestId,
            steps: [{ stepId: 'continue-step' as never, actionId: 'continue-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })

        expect(result.result?.outcome).toBe('failed')
        expect(result.result?.mayHaveSideEffects).toBe(false)
        expect(result.result?.steps[0]?.error?.code).toBe('STALE_REF')
        expect(result.task.pauseReason).toBe('awaiting-agent')
        expect(h.driver.dispatchCounts.get('continue-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('accepts a submit action only when a following batch waitFor postcondition completes', async () => {
        const h = await createHarness('abp-runtime-submit-postcondition-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            elements: [{ ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        await observeHarnessTab(h)
        h.driver.setDelay('waitFor', 1)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const submitted = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'submit-postcondition-batch' as RequestId,
            steps: [
                { stepId: 'pay-step' as never, actionId: 'pay-action' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@pay' as never, timeoutMs: 1000 },
                { stepId: 'success-check' as never, actionId: 'success-check-action' as never, tabId: h.opened.tabId,
                    kind: 'waitFor', until: { kind: 'text', text: 'Payment complete' }, timeoutMs: 1000 },
            ],
        }, { waitMs: 2000 })
        const approval = submitted.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'postcondition-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const approved = await h.runtime.approve({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash,
            requestId: 'submit-postcondition-approve' as RequestId, decision: 'approve',
        })
        expect(approved.batch?.outcome).toBe('succeeded')
        expect(approved.task.pauseReason).toBe('awaiting-agent')
        await h.store.close()
    })

    it('does not rebind an agent ref to a newer snapshot of the same URL', async () => {
        const h = await createHarness('abp-runtime-original-snapshot-')
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            documentGeneration: 1,
            elements: [{ ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        const original = await h.driver.observe(h.opened.tabId, ['https://fixture.test'], { timeoutMs: 1000 })
        h.driver.seedTab(h.opened.tabId, {
            url: 'https://fixture.test/start',
            documentGeneration: 2,
            elements: [{ ref: '@continue' as never, role: 'button', name: 'Decoy', visible: true,
                frameOrigin: 'https://fixture.test' }],
        })
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const response = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'old-snapshot-click' as RequestId,
            steps: [{ stepId: 'click' as never, actionId: 'old-snapshot-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, timeoutMs: 1000,
                snapshotId: original.snapshotId } as never],
        }, { waitMs: 1000 })
        expect(response.result?.outcome).toBe('failed')
        expect(response.result?.steps[0]?.error?.code).toBe('STALE_REF')
        expect(h.driver.dispatchCounts.get('old-snapshot-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('dispatches against the snapshot the agent observed without taking a policy snapshot', async () => {
        const h = await createHarness('abp-runtime-agent-snapshot-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const agentObservation = await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        const fake = h.driver as unknown as { observeCount: number; dispatchedSnapshots: Array<{ snapshotId: string }> }
        const countBeforeBatch = fake.observeCount
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const result = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'agent-snapshot-click' as RequestId,
            steps: [{ stepId: 'click' as never, actionId: 'agent-snapshot-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never,
                snapshotId: agentObservation.snapshotId, timeoutMs: 1000 }],
        }, { waitMs: 1000 })

        expect(result.result?.outcome).toBe('succeeded')
        expect(fake.observeCount).toBe(countBeforeBatch)
        expect(fake.dispatchedSnapshots.at(-1)?.snapshotId).toBe(agentObservation.snapshotId)
        await h.store.close()
    })

    it('uses the most recent snapshot returned by the agent when a step omits snapshotId', async () => {
        const h = await createHarness('abp-runtime-agent-latest-snapshot-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const agentObservation = await h.runtime.observe(h.auth, { taskId: h.task.taskId, tabId: h.opened.tabId })
        const fake = h.driver as unknown as { dispatchedSnapshots: Array<{ snapshotId: string }> }
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const result = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'agent-latest-snapshot-click' as RequestId,
            steps: [{ stepId: 'click' as never, actionId: 'agent-latest-snapshot-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })

        expect(result.result?.outcome).toBe('succeeded')
        expect(fake.dispatchedSnapshots.at(-1)?.snapshotId).toBe(agentObservation.snapshotId)
        await h.store.close()
    })

    it('uses the snapshot returned by an observe step in the following batch', async () => {
        const h = await createHarness('abp-runtime-batch-observe-snapshot-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const beforeObserve = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const observed = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: beforeObserve.stateVersion,
            requestId: 'batch-agent-observe' as RequestId,
            steps: [{ stepId: 'observe' as never, actionId: 'observe-action' as never, tabId: h.opened.tabId,
                kind: 'observe', timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const snapshotId = observed.result?.steps[0]?.observation?.snapshotId
        expect(snapshotId).toBeTruthy()

        const ready = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const clicked = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: ready.stateVersion,
            requestId: 'batch-agent-observe-click' as RequestId,
            steps: [{ stepId: 'click' as never, actionId: 'batch-observed-click' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@continue' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(clicked.result?.outcome).toBe('succeeded')
        expect(h.driver.dispatchedSnapshots.at(-1)?.snapshotId).toBe(snapshotId)
        await h.store.close()
    })

    it('keeps an unnamed ref bound to the snapshot received before batch submission', async () => {
        const h = await createHarness('abp-runtime-fixed-batch-snapshot-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const first = await observeHarnessTab(h)
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: task.stateVersion,
            requestId: 'fixed-batch-snapshot' as RequestId, steps: [
                { stepId: 'observe-now' as never, actionId: 'observe-now' as never, tabId: h.opened.tabId,
                    kind: 'observe', timeoutMs: 1000 },
                { stepId: 'click-old-ref' as never, actionId: 'click-old-ref' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '@continue' as never, timeoutMs: 1000 },
            ] }, { waitMs: 1000 })
        expect(h.driver.dispatchedSnapshots.at(-1)?.snapshotId).toBe(first.snapshotId)
        expect(batch.result?.steps.at(-1)?.outcome).toBe('succeeded')
        await h.store.close()
    })

    it('resolves a named observe ref only within its producing batch and snapshot', async () => {
        const h = await createHarness('abp-runtime-named-observe-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@continue' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const before = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const result = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: before.stateVersion,
            requestId: 'named-observe-batch' as RequestId,
            steps: [
                { stepId: 'observe' as never, actionId: 'named-observe' as never, tabId: h.opened.tabId,
                    kind: 'observe', name: 'page', timeoutMs: 1000 },
                { stepId: 'click' as never, actionId: 'named-click' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '$page.Continue', timeoutMs: 1000 },
            ],
        }, { waitMs: 1000 })

        expect(result.result?.outcome).toBe('succeeded')
        expect(h.driver.dispatchCounts.get('named-click')).toBe(1)
        expect(h.driver.dispatchedSnapshots.at(-1)?.snapshotId)
            .toBe(result.result?.steps[0]?.observation?.snapshotId)

        const ready = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const outside = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: ready.stateVersion,
            requestId: 'named-observe-cross-batch' as RequestId,
            steps: [{ stepId: 'cross-click' as never, actionId: 'cross-batch-click' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '$page.Continue', timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(outside.result?.steps[0]?.error?.code).toBe('INVALID_REQUEST')
        expect(h.driver.dispatchCounts.get('cross-batch-click') ?? 0).toBe(0)
        await h.store.close()
    })

    it.each([
        ['missing', []],
        ['ambiguous', [
            { ref: '@one' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' },
            { ref: '@two' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: 'https://fixture.test' },
        ]],
    ])('refuses a named observation ref when its accessible name is %s', async (_label, elements) => {
        const h = await createHarness(`abp-runtime-named-${_label}-`)
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements })
        const before = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const result = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: before.stateVersion,
            requestId: `named-${_label}-request` as RequestId,
            steps: [
                { stepId: 'observe' as never, actionId: 'named-observe' as never, tabId: h.opened.tabId,
                    kind: 'observe', name: 'page', timeoutMs: 1000 },
                { stepId: 'click' as never, actionId: 'named-click' as never, tabId: h.opened.tabId,
                    kind: 'click', ref: '$page.Continue', timeoutMs: 1000 },
            ],
        }, { waitMs: 1000 })
        expect(result.result?.steps.at(-1)?.error?.code).toBe('INVALID_REQUEST')
        expect(h.driver.dispatchCounts.get('named-click') ?? 0).toBe(0)
        await h.store.close()
    })

    it('accepts an unchanged pending approval once after Runtime restart and lease epoch recovery', async () => {
        const h = await createHarness('abp-runtime-approval-restart-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const before = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const pending = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: before.stateVersion,
            requestId: 'restart-approval-batch' as RequestId,
            steps: [{ stepId: 'pay' as never, actionId: 'restart-pay-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const approval = pending.result?.pendingApproval
        if (!approval) throw new Error('test requires pending approval')
        const oldEpoch = h.store.getTask(h.task.taskId)?.tabLeaseEpochs?.[h.opened.tabId]
        await h.store.close()
        // The restarted Runtime reconnects with a fresh driver connection: snapshots are gone.
        h.driver.forgetSnapshots()

        const store = await TaskStore.open(h.dir)
        const restarted = new BrowserRuntime({ sites: FIXTURE_SITES, store, drivers: new Map([[h.profileId, h.driver]]), clock: h.clock })
        const recovered = await restarted.getTask(h.auth, { taskId: h.task.taskId })
        expect(recovered.tabLeases?.[0]?.leaseEpoch).toBeGreaterThan(oldEpoch ?? 0)
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'restart-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        const uiAuth = { credential: uiCredential, verifiedAtMs: h.clock.now() }
        const request = { taskId: h.task.taskId, approvalId: approval.approvalId,
            bindingHash: approval.bindingHash, requestId: 'restart-approve' as RequestId, decision: 'approve' as const }
        const first = await restarted.approve(uiAuth, request)
        const duplicate = await restarted.approve(uiAuth, request)
        expect(first.outcome).toBe('approved')
        expect(duplicate.outcome).toBe('approved')
        expect(h.driver.dispatchCounts.get('restart-pay-action')).toBe(1)
        await store.close()
    })

    it('keeps updatedAtMs unchanged for viewer reads and refused duplicate resumes', async () => {
        const h = await createHarness('abp-runtime-read-retention-')
        const initial = h.store.getTask(h.task.taskId)?.updatedAtMs
        h.clock.advance(500)
        const request = { taskId: h.task.taskId, expectedVersion: h.task.stateVersion,
            requestId: 'not-resumable' as RequestId }
        await expect(h.runtime.resume(h.auth, request)).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.runtime.resume(h.auth, request)).rejects.toMatchObject({ code: 'CONFLICT' })
        await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.subscribe(h.auth, { taskId: h.task.taskId, afterSeq: 0 })
        expect(h.store.getTask(h.task.taskId)?.updatedAtMs).toBe(initial)
        await h.store.close()
    })

    it('explains the pause reason that blocks a new batch', async () => {
        const h = await createHarness('abp-runtime-blocked-reason-')
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'blocked-reason-batch' as RequestId,
            steps: [{ stepId: 'observe' as never, actionId: 'observe-login' as never, tabId: h.opened.tabId,
                kind: 'navigate', url: 'https://fixture.test/login', timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        expect(batch.task.status).toBe('awaiting-user')
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await expect(h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: task.stateVersion,
            requestId: 'blocked-reason-second' as RequestId,
            steps: [{ stepId: 'observe-next' as never, actionId: 'observe-next' as never,
                tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1000 }],
        })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('login') })
        await h.store.close()
    })

    it('releases an approval batch lease when the interactive user rejects it', async () => {
        const h = await createHarness('abp-runtime-reject-release-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const batch = await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'reject-lease-batch' as RequestId,
            steps: [{ stepId: 'pay-step' as never, actionId: 'pay-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }],
        }, { waitMs: 1000 })
        const approval = batch.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        const uiCredential: InteractiveCapability = {
            kind: 'interactive', capabilityId: 'reject-ui' as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer',
            profileId: h.profileId, operations: ['approve'], issuedAtMs: 0, expiresAtMs: 3_600_000,
        }
        await h.runtime.approve({ credential: uiCredential, verifiedAtMs: h.clock.now() }, {
            taskId: h.task.taskId, approvalId: approval.approvalId, bindingHash: approval.bindingHash,
            requestId: 'reject-lease-approval' as RequestId, decision: 'reject',
        })

        await expect(h.runtime.closeSpace(h.auth, {
            taskSpaceId: h.space.taskSpaceId, requestId: 'reject-lease-close-space' as RequestId,
        })).resolves.toMatchObject({ closedTabs: [h.opened.tabId] })
        await h.store.close()
    })

    it('does not accept a batch while openPage owns the task execution segment', async () => {
        const h = await createHarness('abp-runtime-open-batch-race-')
        h.driver.setDelay('openTab', 200)
        const opening = h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/second',
            requestId: 'open-race-second-page' as RequestId,
        })
        let current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        for (let attempt = 0; current.status !== 'running' && attempt < 100; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 1))
            current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        }
        expect(current.status).toBe('running')
        await expect(h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'batch-race-during-open' as RequestId,
            steps: [{ stepId: 'observe' as never, actionId: 'observe-race' as never,
                tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1000 }],
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        await opening
        await h.store.close()
    })

    it('serializes a simultaneous openPage and submitBatch start on the latest task state', async () => {
        const h = await createHarness('abp-runtime-open-submit-simultaneous-')
        h.driver.setDelay('openTab', 100)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const [opened, submitted] = await Promise.allSettled([
            h.runtime.openPage(h.auth, {
                taskId: h.task.taskId,
                url: 'https://fixture.test/second',
                requestId: 'simultaneous-open' as RequestId,
            }),
            h.runtime.submitBatch(h.auth, {
                taskId: h.task.taskId,
                expectedVersion: current.stateVersion,
                requestId: 'simultaneous-submit' as RequestId,
                steps: [{ stepId: 'observe' as never, actionId: 'simultaneous-observe' as never,
                    tabId: h.opened.tabId, kind: 'observe', timeoutMs: 1000 }],
            }, { waitMs: 1000 }),
        ])
        expect([opened.status, submitted.status].filter((status) => status === 'fulfilled')).toHaveLength(1)
        await h.store.close()
    })

    it('keeps a pre-side-effect openPage origin refusal as a confirmed failure', async () => {
        const h = await createHarness('abp-runtime-open-origin-refusal-')
        h.driver.failNext('openTab', new BrowserRuntimeError('ORIGIN_DENIED', 'redirect origin denied', false, false))
        await expect(h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/redirect',
            requestId: 'open-denied-redirect' as RequestId,
        })).rejects.toMatchObject({ code: 'ORIGIN_DENIED', mayHaveSideEffects: false })
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task.status).toBe('failed')
        expect(task.uncertainActions).toEqual([])
        await h.store.close()
    })

    it('returns a driver window quota refusal without marking the task failed or uncertain', async () => {
        const h = await createHarness('abp-runtime-open-window-quota-')
        h.driver.failNext('openTab', new BrowserRuntimeError('QUOTA_EXCEEDED', 'agent window limit reached', true, false))
        await expect(h.runtime.openPage(h.auth, {
            taskId: h.task.taskId,
            url: 'https://fixture.test/second',
            requestId: 'open-window-quota' as RequestId,
        })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', mayHaveSideEffects: false })
        const task = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        expect(task).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent', uncertainActions: [] })
        const retried = await h.runtime.openPage(h.auth, { taskId: h.task.taskId, url: 'https://fixture.test/second',
            requestId: 'open-window-quota-retry' as RequestId })
        expect(retried.task.status).toBe('paused')
        await h.store.close()
    })

    it('exposes persisted lease epochs and the current input owner on each task tab', async () => {
        const h = await createHarness('abp-runtime-task-view-leases-')
        const view = await h.runtime.getTask(h.auth, { taskId: h.task.taskId }) as typeof h.task & {
            tabLeases?: Array<{ tabId: string; leaseEpoch: number; owner: { kind: string } }>
        }
        expect(view.tabLeases).toEqual([{ tabId: h.opened.tabId, leaseEpoch: expect.any(Number), owner: { kind: 'none' } }])
        await h.store.close()
    })

    it('redacts fill values from durable batch checkpoints', async () => {
        const h = await createHarness('abp-runtime-redact-fill-')
        h.driver.seedTab(h.opened.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@password' as never, role: 'textbox', name: 'Password', value: '', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        await h.runtime.submitBatch(h.auth, {
            taskId: h.task.taskId,
            expectedVersion: current.stateVersion,
            requestId: 'fill-secret' as RequestId,
            steps: [{ stepId: 'fill' as never, actionId: 'fill-secret-action' as never,
                tabId: h.opened.tabId, kind: 'fill', ref: '@password' as never,
                value: 'synthetic-password-value', timeoutMs: 1000 }],
        }, { waitMs: 1000 })

        const journal = await readTree(h.dir)
        expect(journal).not.toContain('synthetic-password-value')
        expect(journal).not.toContain('ABP-CANARY-')
        await h.store.close()
    })
})

describe('approval binding to the complete submission (D6)', () => {
    const payForm: FormSubmission = {
        action: 'https://fixture.test/order', method: 'post', enctype: 'application/x-www-form-urlencoded', target: '',
        fields: [['item', 'a'], ['item', 'b'], ['token', 'synthetic-secret-123'], ['note', `${'n'.repeat(50)}-tail`], ['op', 'pay']],
        submitter: { name: 'op', value: 'pay', formaction: null, formmethod: null, formenctype: null },
        opaque: false,
    }
    const payPage = (form: FormSubmission = payForm): FakePage => ({ url: 'https://fixture.test/checkout', form,
        elements: [{ ref: '@pay' as never, role: 'button', name: 'Pay now', visible: true, frameOrigin: 'https://fixture.test' }] })

    async function pendingApproval(prefix: string) {
        const h = await createHarness(prefix)
        h.driver.seedTab(h.opened.tabId, payPage())
        await observeHarnessTab(h)
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        const submitted = await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: current.stateVersion,
            requestId: `${prefix}-batch` as RequestId, steps: [{ stepId: 'pay' as never, actionId: 'pay-action' as never,
                tabId: h.opened.tabId, kind: 'click', ref: '@pay' as never, timeoutMs: 1000 }] }, { waitMs: 1000 })
        const approval = submitted.result?.pendingApproval
        if (!approval) throw new Error('test requires a pending approval')
        const uiCredential: InteractiveCapability = { kind: 'interactive', capabilityId: `${prefix}-ui` as never, principalId: 'p' as never,
            workspaceId: 'w' as never, machineId: 'm' as never, viewerSessionId: 'viewer', profileId: h.profileId, operations: ['approve'],
            issuedAtMs: 0, expiresAtMs: 3_600_000 }
        const approve = () => h.runtime.approve({ credential: uiCredential, verifiedAtMs: h.clock.now() }, { taskId: h.task.taskId,
            approvalId: approval.approvalId, bindingHash: approval.bindingHash, requestId: `${prefix}-approve` as RequestId, decision: 'approve' })
        return { h, approval, approve }
    }

    it('shows the method, destination and field names but never a value, and persists no value (P0-6)', async () => {
        const { h, approval } = await pendingApproval('abp-d6-summary-')
        expect(approval.description).toContain('POST https://fixture.test/order')
        expect(approval.description).toContain('item, item, token, note, op')
        for (const value of ['synthetic-secret-123', '-tail', '=a']) expect(approval.description).not.toContain(value)
        // Nothing durable (journal, task record, approval record) holds the values.
        const journal = await readTree(h.dir)
        expect(journal).not.toContain('synthetic-secret-123')
        expect(journal).not.toContain('-tail')
        await h.store.close()
    })

    it('refuses to dispatch when anything that would be sent changed after the approval was shown', async () => {
        const mutations: Array<[string, FormSubmission]> = [
            ['hidden value', { ...payForm, fields: payForm.fields.map(([name, value]) => [name, name === 'token' ? 'synthetic-secret-124' : value]) }],
            ['truncated tail', { ...payForm, fields: payForm.fields.map(([name, value]) => [name, name === 'note' ? `${'n'.repeat(50)}-TAIL` : value]) }],
            ['field order', { ...payForm, fields: [payForm.fields[1], payForm.fields[0], ...payForm.fields.slice(2)] }],
            ['destination', { ...payForm, action: 'https://fixture.test/elsewhere' }],
            ['method', { ...payForm, method: 'get' }],
            ['submitter override', { ...payForm, submitter: { ...payForm.submitter!, formaction: '/refund' }, action: 'https://fixture.test/refund' }],
        ]
        for (const [label, mutated] of mutations) {
            const { h, approve } = await pendingApproval(`abp-d6-${label.replace(/ /g, '-')}-`)
            h.driver.seedTab(h.opened.tabId, payPage(mutated))
            await expect(approve(), label).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
            expect(h.driver.dispatchCounts.get('pay-action') ?? 0, label).toBe(0)
            await h.store.close()
        }
    })

    it('refuses to dispatch when the element re-bound right before dispatch is not the approved one', async () => {
        const { h, approve } = await pendingApproval('abp-d6-identity-')
        h.driver.seedTab(h.opened.tabId, { ...payPage(), identitySalt: 'rebound' })
        await expect(approve()).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
        expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('refuses to dispatch when the approved element was relabelled in place', async () => {
        const { h, approve } = await pendingApproval('abp-d6-relabel-')
        h.driver.seedTab(h.opened.tabId, { ...payPage(), currentNames: { '@pay': 'Pay 10x now' } })
        await expect(approve()).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
        expect(h.driver.dispatchCounts.get('pay-action') ?? 0).toBe(0)
        await h.store.close()
    })

    it('dispatches exactly once when nothing changed', async () => {
        const { h, approve } = await pendingApproval('abp-d6-unchanged-')
        expect((await approve()).outcome).toBe('approved')
        expect(h.driver.dispatchCounts.get('pay-action')).toBe(1)
        await h.store.close()
    })
})

describe('site policy at the runtime (D7)', () => {
    const origin = 'https://fixture.test'
    const ui = (h: Awaited<ReturnType<typeof createHarness>>, operations: InteractiveCapability['operations']) => ({ verifiedAtMs: h.clock.now(),
        credential: { kind: 'interactive', capabilityId: 'd7-ui' as never, principalId: 'p' as never, workspaceId: 'w' as never, machineId: 'm' as never,
            viewerSessionId: 'viewer', profileId: h.profileId, operations, issuedAtMs: 0, expiresAtMs: 3_600_000 } as InteractiveCapability })
    async function runStep(h: Awaited<ReturnType<typeof createHarness>>, id: string, step: Record<string, unknown>) {
        const current = await h.runtime.getTask(h.auth, { taskId: h.task.taskId })
        return (await h.runtime.submitBatch(h.auth, { taskId: h.task.taskId, expectedVersion: current.stateVersion, requestId: `${id}-batch` as RequestId,
            steps: [{ stepId: id as never, actionId: id as never, tabId: h.opened.tabId, timeoutMs: 1000, ...step } as never] }, { waitMs: 1000 })).result!
    }

    it('refuses to open an origin the grant allows but no site policy lists, before any tab exists', async () => {
        const h = await createHarness('abp-d7-unsited-')
        const wider = { ...h.auth, credential: { ...h.auth.credential, allowedOrigins: [origin, 'https://unsited.test'] } as AgentGrant }
        const tabsBefore = h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length
        await expect(h.runtime.openPage(wider, { taskId: h.task.taskId, url: 'https://unsited.test/start', requestId: 'd7-open' as RequestId }))
            .rejects.toMatchObject({ code: 'ORIGIN_DENIED' })
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length).toBe(tabsBefore)
        const navigated = await runStep({ ...h, auth: wider }, 'd7-nav-unsited', { kind: 'navigate', url: 'https://unsited.test/x' })
        expect(navigated.outcome).toBe('failed')
        expect(h.driver.dispatchCounts.get('d7-nav-unsited') ?? 0).toBe(0)
        await h.store.close()
    })

    it('holds an unmatched non-form click for approval on a site without auto rules', async () => {
        const h = await createHarness('abp-d7-strict-', undefined, [{ origin, actions: [] }])
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/cart`, elements: [{ ref: '@go' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        const result = await runStep(h, 'd7-click', { kind: 'click', ref: '@go' })
        expect(result.outcome).toBe('awaiting-user')
        expect(result.pendingApproval?.actionId).toBe('d7-click')
        expect(h.driver.dispatchCounts.get('d7-click') ?? 0).toBe(0)
        await h.store.close()
    })

    const held: SitePolicy[] = [{ origin, actions: [
        { match: { kinds: ['navigate'], targetPaths: ['/api/delete*'] }, risk: 'requires-approval' },
        { match: { kinds: ['link', 'navigate'] }, risk: 'auto' },
    ] }]

    it('applies the navigation policy to openPage exactly as to a navigate step (P0-1)', async () => {
        const h = await createHarness('abp-d7-openpage-', undefined, held)
        const opensBefore = h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length
        await expect(h.runtime.openPage(h.auth, { taskId: h.task.taskId, url: `${origin}/api/delete?id=1`, requestId: 'd7-open-held' as RequestId }))
            .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', mayHaveSideEffects: false })
        expect(h.driver.targetLedger.filter((entry) => entry.operation === 'openTab').length).toBe(opensBefore)
        const navigated = await runStep(h, 'd7-nav', { kind: 'navigate', url: `${origin}/api/delete?id=1` })
        expect(navigated).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff', mayHaveSideEffects: false })
        expect(h.driver.dispatchCounts.get('d7-nav') ?? 0).toBe(0)
        await h.store.close()
    })

    it('asks for approval before an unmatched fill and dispatches it once after approval, value-free (P0-2)', async () => {
        const h = await createHarness('abp-d7-fill-', undefined, held)
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/transfer`, elements: [{ ref: '@to' as never, role: 'textbox', name: 'Recipient', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        const filled = await runStep(h, 'd7-fill', { kind: 'fill', ref: '@to', value: 'synthetic-recipient-789' })
        expect(filled.outcome).toBe('awaiting-user')
        expect(h.driver.dispatchCounts.get('d7-fill') ?? 0).toBe(0)
        const approval = filled.pendingApproval!
        expect(approval.description).toContain('Recipient')
        expect(approval.description).not.toContain('synthetic-recipient-789')
        const approved = await h.runtime.approve(ui(h, ['approve']), { taskId: h.task.taskId, approvalId: approval.approvalId,
            bindingHash: approval.bindingHash, requestId: 'd7-fill-approve' as RequestId, decision: 'approve' })
        expect(approved.batch?.outcome).toBe('succeeded')
        expect(h.driver.dispatchCounts.get('d7-fill')).toBe(1)
        await h.store.close()
    })

    it('refuses executable and unsited link destinations and links inside forms are held (P0-2)', async () => {
        const h = await createHarness('abp-d7-links-', undefined, held)
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/cart`, linkUrls: { '@js': 'javascript:submitOrder()', '@away': 'https://elsewhere.test/x' },
            elements: [{ ref: '@js' as never, role: 'link', name: 'Order now', visible: true, frameOrigin: origin },
                { ref: '@away' as never, role: 'link', name: 'Away', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        for (const ref of ['@js', '@away']) {
            const result = await runStep(h, `d7-link-${ref.slice(1)}`, { kind: 'click', ref })
            expect(result.steps[0].error?.code, ref).toBe('ORIGIN_DENIED')
            expect(h.driver.dispatchCounts.get(`d7-link-${ref.slice(1)}`) ?? 0, ref).toBe(0)
        }
        await h.store.close()
    })

    it('hands a form it cannot bind to the user instead of asking for approval, and resumes the agent after the user (P0-5)', async () => {
        const permissive: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }] }]
        const h = await createHarness('abp-d7-opaque-', undefined, permissive)
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/login`, form: { action: `${origin}/session`, method: 'post', enctype: 'application/x-www-form-urlencoded',
            target: '', fields: [['user', 'a'], ['pw', { password: 8 }]], submitter: null, opaque: true },
            elements: [{ ref: '@go' as never, role: 'button', name: 'Sign in', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        const result = await runStep(h, 'd7-opaque', { kind: 'click', ref: '@go' })
        expect(result).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff' })
        expect(result.pendingApproval).toBeUndefined()
        expect(h.driver.dispatchCounts.get('d7-opaque') ?? 0).toBe(0)
        const leases = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const control = ui(h, ['takeOver', 'releaseControl'])
        const taken = await h.runtime.takeOver(control, { taskId: h.task.taskId, tabId: h.opened.tabId,
            expectedEpoch: leases.owner(h.opened.tabId, h.profileId).leaseEpoch, requestId: 'd7-opaque-take' as RequestId })
        const released = await h.runtime.releaseControl(control, { taskId: h.task.taskId, tabId: h.opened.tabId,
            expectedEpoch: taken.leaseEpoch, requestId: 'd7-opaque-release' as RequestId })
        const resumed = await h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: released.task.stateVersion, requestId: 'd7-opaque-resume' as RequestId })
        expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(h.driver.dispatchCounts.get('d7-opaque') ?? 0).toBe(0)
        await h.store.close()
    })

    it('hands the action to the user when the driver cannot verify it (transformed frame), without dispatch (P0-7)', async () => {
        const permissive: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }] }]
        const h = await createHarness('abp-d7-geometry-', undefined, permissive)
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/cart`, elements: [{ ref: '@go' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        h.driver.failNext('click', new BrowserRuntimeError('APPROVAL_REQUIRED', 'transformed frame', false, false))
        const result = await runStep(h, 'd7-geometry', { kind: 'click', ref: '@go' })
        expect(result).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff', mayHaveSideEffects: false })
        expect((await h.runtime.getTask(h.auth, { taskId: h.task.taskId })).uncertainActions).toEqual([])
        await h.store.close()
    })

    it('passes the classified binding to the driver for re-verification at click time (P0-4)', async () => {
        const permissive: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }] }]
        const h = await createHarness('abp-d7-expect-', undefined, permissive)
        const form: FormSubmission = { action: `${origin}/cart/update`, method: 'post', enctype: 'application/x-www-form-urlencoded', target: '',
            fields: [['qty', '2']], submitter: null, opaque: false }
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/cart`, form, elements: [{ ref: '@go' as never, role: 'button', name: 'Update', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        await runStep(h, 'd7-expect', { kind: 'click', ref: '@go' })
        expect(h.driver.clickExpectations.at(-1)).toEqual({ role: 'button', name: 'Update', formDigest: formDigest(form) })
        await h.store.close()
    })

    it('refuses a click whose element was relabelled since the snapshot, before classifying or dispatching it', async () => {
        const h = await createHarness('abp-d7-relabel-')
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/start`, elements: [{ ref: '@go' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/start`, currentNames: { '@go': 'Pay now' },
            elements: [{ ref: '@go' as never, role: 'button', name: 'Continue', visible: true, frameOrigin: origin }] })
        const result = await runStep(h, 'd7-relabel', { kind: 'click', ref: '@go' })
        expect(result.outcome).toBe('failed')
        expect(result.steps[0].error?.code).toBe('STALE_REF')
        expect(h.driver.dispatchCounts.get('d7-relabel') ?? 0).toBe(0)
        await h.store.close()
    })

    /** The user's own resume (interactive credential) after a takeover; returns the task view. */
    const userResumeAfterTurn = async (h: Awaited<ReturnType<typeof createHarness>>, tabId: TabId, id: string, page?: FakePage) => {
        const leases = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const control = ui(h, ['takeOver', 'releaseControl', 'resume'])
        const taken = await h.runtime.takeOver(control, { taskId: h.task.taskId, tabId, expectedEpoch: leases.owner(tabId, h.profileId).leaseEpoch, requestId: `${id}-take` as RequestId })
        if (page) h.driver.seedTab(tabId, page)
        const released = await h.runtime.releaseControl(control, { taskId: h.task.taskId, tabId, expectedEpoch: taken.leaseEpoch, requestId: `${id}-release` as RequestId })
        return h.runtime.resume(control, { taskId: h.task.taskId, expectedVersion: released.task.stateVersion, requestId: `${id}-resume` as RequestId })
    }
    const lastAttention = (h: Awaited<ReturnType<typeof createHarness>>) =>
        h.store.events(h.task.taskId, 0).filter((event) => event.data.attention).at(-1)?.data

    it('lets the user hand a handed-off action back to the agent with their own resume, and records it for the agent', async () => {
        const permissive: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }] }]
        const h = await createHarness('abp-d8-handoff-', undefined, permissive)
        h.driver.seedTab(h.opened.tabId, { url: `${origin}/login`, form: { action: `${origin}/session`, method: 'post', enctype: 'application/x-www-form-urlencoded',
            target: '', fields: [['user', 'a']], submitter: null, opaque: true },
            elements: [{ ref: '@go' as never, role: 'button', name: 'Sign in', visible: true, frameOrigin: origin }] })
        await observeHarnessTab(h)
        expect(await runStep(h, 'd8-handoff', { kind: 'click', ref: '@go' })).toMatchObject({ outcome: 'awaiting-user', waitReason: 'handoff' })
        const resumed = await userResumeAfterTurn(h, h.opened.tabId, 'd8-handoff')
        expect(resumed).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(resumed.waitReason).toBeUndefined()
        expect(lastAttention(h)).toMatchObject({ attention: 'user-resumed', waitCompleted: 'handoff' })
        expect(h.driver.dispatchCounts.get('d8-handoff') ?? 0).toBe(0)
        await h.store.close()
    })

    it('applies the site loginCompleteWhen to the user\'s own resume too, and records the completed login for the agent', async () => {
        const sites: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }], loginCompleteWhen: { urlPrefix: `${origin}/account`, text: 'Signed in' } }]
        const h = await createHarness('abp-d8-login-', undefined, sites)
        const login = await h.runtime.openPage(h.auth, { taskId: h.task.taskId, url: `${origin}/login`, requestId: 'd8-login' as RequestId })
        expect(await userResumeAfterTurn(h, login.tabId, 'd8-error', { url: `${origin}/error`, text: 'Something failed', elements: [] }))
            .toMatchObject({ status: 'awaiting-user', waitReason: 'login' })
        expect(await userResumeAfterTurn(h, login.tabId, 'd8-partial', { url: `${origin}/account`, text: 'Welcome', elements: [] }))
            .toMatchObject({ status: 'awaiting-user', waitReason: 'login' })
        expect(await userResumeAfterTurn(h, login.tabId, 'd8-done', { url: `${origin}/account`, text: 'Welcome. Signed in', elements: [] }))
            .toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        expect(lastAttention(h)).toMatchObject({ attention: 'user-resumed', waitCompleted: 'login' })
        await h.store.close()
    })

    it('completes a login wait only when the site condition holds, not merely when the page left the login path', async () => {
        const sites: SitePolicy[] = [{ origin, actions: [{ match: {}, risk: 'auto' }], loginCompleteWhen: { urlPrefix: `${origin}/account`, text: 'Signed in' } }]
        const h = await createHarness('abp-d7-login-', undefined, sites)
        const login = await h.runtime.openPage(h.auth, { taskId: h.task.taskId, url: `${origin}/login`, requestId: 'd7-login' as RequestId })
        const leases = (h.runtime as unknown as { leases: { owner(tabId: string, profileId: ProfileId): { leaseEpoch: number } } }).leases
        const userTurn = async (page: FakePage, id: string) => {
            const taken = await h.runtime.takeOver(ui(h, ['takeOver', 'releaseControl']), { taskId: h.task.taskId, tabId: login.tabId,
                expectedEpoch: leases.owner(login.tabId, h.profileId).leaseEpoch, requestId: `${id}-take` as RequestId })
            h.driver.seedTab(login.tabId, page)
            const released = await h.runtime.releaseControl(ui(h, ['takeOver', 'releaseControl']), { taskId: h.task.taskId, tabId: login.tabId,
                expectedEpoch: taken.leaseEpoch, requestId: `${id}-release` as RequestId })
            return h.runtime.resume(h.auth, { taskId: h.task.taskId, expectedVersion: released.task.stateVersion, requestId: `${id}-resume` as RequestId })
        }
        expect(await userTurn({ url: `${origin}/error`, text: 'Something failed', elements: [] }, 'd7-error')).toMatchObject({ status: 'awaiting-user', waitReason: 'login' })
        expect(await userTurn({ url: `${origin}/account`, text: 'Welcome', elements: [] }, 'd7-partial')).toMatchObject({ status: 'awaiting-user', waitReason: 'login' })
        expect(await userTurn({ url: `${origin}/account`, text: 'Welcome. Signed in', elements: [] }, 'd7-done')).toMatchObject({ status: 'paused', pauseReason: 'awaiting-agent' })
        await h.store.close()
    })
})
