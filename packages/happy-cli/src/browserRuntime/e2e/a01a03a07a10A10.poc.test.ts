/**
 * A10 — component faults and durable recovery on the real stack.
 *
 * Fault points (3 iterations each, via poc.mjs fault):
 *  - kill-chrome: same container, new browserInstanceId → paused(browser-replaced),
 *    old tab/refs rejected, profile storage kept.
 *  - restart-browser-container: container identity changes too; same outcome.
 *  - kill-runtime + start-runtime with a write in flight: writer lock recovered,
 *    intent-committed write → uncertain, never retried.
 *  - restart-runtime (graceful) with a write in flight: same expectations.
 *  - Happy daemon restart: N/A — the Runtime has no daemon dependency here.
 *
 * After a Runtime container restart the published host ports may change; every
 * client after a fault is built from ports re-read with `docker port`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BatchStep, ProfileId, TabId, TaskId, TaskSpaceId, TaskView } from '../contracts'
import {
    aid, cleanupTask, containerFingerprint, containerState, eventsUntil, evidence, expectCode, repeat, rid, runtimeLogTail, sid,
    startSuiteStack, waitForTask, type SuiteStack,
} from './a01a03a07a10Helpers'
import { STRICT_PASSWORD, Viewer } from './a02a04Helpers'
import { PROFILE_A, PROFILE_B, SITE_A, type LedgerEntry } from './pocStack'

const SLOW_WRITE_MS = 12_000
const STORE_TAG = `a10-${Date.now().toString(36)}`
const slowWrites = (entries: LedgerEntry[], key: string) => entries.filter((entry) => entry.kind === 'slow-write' && entry.key === key)
const clicks = (entries: LedgerEntry[]) => entries.filter((entry) => entry.kind === 'click' && entry.target === 'A-main').length

/**
 * Cookie/LS/IDB presence from /a02a04-storage-check/<tag> (shared fixture page,
 * persistent login cookie + per-tag canaries), without echoing the stored values.
 */
function storageShape(text: string, tag: string): { cookie: boolean; ls: boolean; idb: boolean; complete: boolean } {
    return { cookie: text.includes('COOKIE=yes'), ls: text.includes(`LS=ls-${tag}`), idb: text.includes(`IDB=idb-${tag}`), complete: text.includes('IDB=') }
}

async function readStorage(client: ReturnType<SuiteStack['client']>['client'], taskId: TaskId, tabId: TabId, tag: string) {
    const deadline = Date.now() + 10_000
    for (;;) {
        const shape = storageShape((await client.observe({ taskId, tabId })).text, tag)
        if (shape.complete || Date.now() > deadline) return shape
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
}

describe('A10 component faults', () => {
    let suite: SuiteStack
    const spaces = new Map<ProfileId, TaskSpaceId>()

    beforeAll(async () => {
        suite = await startSuiteStack('a10')
        for (const profileId of [PROFILE_A, PROFILE_B]) {
            const { client, close } = suite.client(suite.mintAgent({ profileId }).token)
            spaces.set(profileId, (await client.createSpace({ profileId, requestId: rid() })).taskSpaceId)
            close()
        }
        // Profile A gets a persistent login plus synthetic localStorage/IndexedDB state;
        // "profile kept" is checked against it. The agent never logs in: its
        // navigation parks the task in awaiting-user(login) and the human logs in
        // on the browser display (xdotool = the noVNC input path).
        const { client, close } = suite.client(suite.mintAgent().token)
        try {
            const taskSpaceId = spaces.get(PROFILE_A)!
            const task = await client.createTask({ taskSpaceId, requestId: rid() })
            const opened = await client.openPage({ taskId: task.taskId, url: `${SITE_A}/a02a04-storage-setup/${STORE_TAG}?run=${suite.run}`, requestId: rid() })
            const waiting = await client.getTask({ taskId: task.taskId })
            expect(waiting.status, 'agent landing on the login page must hand over to the user').toBe('awaiting-user')
            expect(waiting.waitReason).toBe('login')
            // Viewer handoff: takeOver (settling ACK → wait for the user lease) → human login → releaseControl → agent resume.
            const ui = suite.client(suite.mintInteractive())
            const lease = () => ui.client.getTask({ taskId: task.taskId }).then((view) => view.tabLeases?.find((entry) => entry.tabId === opened.tabId))
            const taken = await ui.client.takeOver({ taskId: task.taskId, tabId: opened.tabId, expectedEpoch: (await lease())!.leaseEpoch, requestId: rid() })
            const owned = await waitForTask(ui.client, task.taskId, (view) => view.tabLeases?.find((entry) => entry.tabId === opened.tabId)?.owner.kind === 'user', 35_000)
            const userEpoch = taken.settling ? owned.tabLeases!.find((entry) => entry.tabId === opened.tabId)!.leaseEpoch : taken.leaseEpoch
            await new Viewer(suite.stack, 'a').login(STORE_TAG, STRICT_PASSWORD)
            const logins = await suite.stack.waitForLedger((entries) => entries.some((entry) => entry.kind === 'a02a04-login' && entry.tag === STORE_TAG), { timeoutMs: 20_000, settleMs: 0 })
            expect(logins.filter((entry) => entry.kind === 'a02a04-login' && entry.tag === STORE_TAG).map((entry) => entry.ok)).toEqual([true])
            await ui.client.releaseControl({ taskId: task.taskId, tabId: opened.tabId, expectedEpoch: userEpoch, requestId: rid() })
            const released = await client.getTask({ taskId: task.taskId })
            const back = await client.resume({ taskId: task.taskId, expectedVersion: released.stateVersion, requestId: rid() })
            expect(`${back.status}/${back.pauseReason ?? back.waitReason ?? '-'}`, 'resume after the human login').toBe('paused/awaiting-agent')
            ui.close()
            const done = await client.submitBatch({
                taskId: task.taskId, expectedVersion: back.stateVersion, requestId: rid(), steps: [
                    { stepId: sid('setup'), actionId: aid('setup'), tabId: opened.tabId, kind: 'navigate', url: `${SITE_A}/a02a04-storage-setup/${STORE_TAG}?run=${suite.run}`, timeoutMs: 10_000 },
                    { stepId: sid('stored'), actionId: aid('stored'), tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'STORAGE SET' }, timeoutMs: 20_000 },
                ],
            }, { waitMs: 60_000 })
            expect(done.result?.outcome, `profile storage setup failed: ${JSON.stringify(done.result?.steps.map((step) => [step.stepId, step.outcome, step.error?.code, step.error?.message]))}`).toBe('succeeded')
            await client.finishTask({ taskId: task.taskId, expectedVersion: done.task.stateVersion, requestId: rid() })
            await client.closePage({ taskSpaceId, tabId: opened.tabId, requestId: rid() })
            // Chromium commits fresh cookies lazily; a browser kill before that would lose the login for a reason unrelated to A10.
            const cookieCommitMs = await new Viewer(suite.stack, 'a').waitCookieOnDisk(`abp_s_${STORE_TAG}`)
            evidence('A10', { setup: 'human-login', cookieCommitMs })
        } finally {
            close()
        }
    }, 300_000)

    afterAll(() => suite?.down())

    it('Happy daemon restart is N/A for this stack', () => {
        // runtimeMain has no daemon/relay connection: it serves grants minted by
        // the harness directly. There is nothing to restart; recorded as N/A.
        evidence('A10', { fault: 'daemon-restart', status: 'not-applicable', reason: 'Runtime process has no Happy daemon dependency in the PoC stack' })
    })

    for (const fault of ['kill-chrome', 'restart-browser-container'] as const) {
        it.each(repeat(3))(`${fault} iteration %i: new browserInstanceId → paused(browser-replaced), old refs rejected, profile kept`, async (iteration) => {
            const token = suite.mintAgent().token
            const agent = suite.client(token)
            const taskSpaceId = spaces.get(PROFILE_A)!
            let taskId: TaskId | undefined
            let oldTab: TabId | undefined
            const newTabs: TabId[] = []
            try {
                const task = await agent.client.createTask({ taskSpaceId, requestId: rid() })
                taskId = task.taskId
                const opened = await agent.client.openPage({ taskId, url: `${SITE_A}/oopif?run=${suite.run}`, requestId: rid() })
                oldTab = opened.tabId
                const obs = await agent.client.observe({ taskId, tabId: oldTab })
                const oldBuy = obs.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)!.ref
                const probeTask = await agent.client.createTask({ taskSpaceId, requestId: rid() })
                const probe = await agent.client.openPage({ taskId: probeTask.taskId, url: `${SITE_A}/a02a04-storage-check/${STORE_TAG}?run=${suite.run}`, requestId: rid() })
                const storageBefore = await readStorage(agent.client, probeTask.taskId, probe.tabId, STORE_TAG)
                await agent.client.finishTask({ taskId: probeTask.taskId, expectedVersion: probe.task.stateVersion, requestId: rid() })
                await agent.client.closePage({ taskSpaceId, tabId: probe.tabId, requestId: rid() })
                expect(storageBefore.cookie && storageBefore.ls && storageBefore.idb, `profile storage missing before the fault: ${JSON.stringify(storageBefore)}`).toBe(true)
                const before = await agent.client.getTask({ taskId })
                const browserContainer = `abp-${suite.run}-browser-a`
                const fingerprintBefore = containerFingerprint(browserContainer)
                const clicksBefore = clicks(await suite.stack.ledger())
                agent.close()

                const faultAtMs = Date.now()
                suite.stack.fault(fault, 'a')
                await suite.waitForHealth(90_000)
                const fresh = suite.client(token)
                const replaced = await waitForTask(fresh.client, taskId, (view) => view.status === 'paused' && view.pauseReason === 'browser-replaced', 60_000)
                const detectedMs = Date.now() - faultAtMs
                const fingerprintAfter = containerFingerprint(browserContainer)
                expect(replaced.browserInstanceId, 'browserInstanceId must change').not.toBe(before.browserInstanceId)
                if (fault === 'kill-chrome') expect(fingerprintAfter, 'same container for kill-chrome').toBe(fingerprintBefore)
                else expect(fingerprintAfter, 'container restart must change the container fingerprint').not.toBe(fingerprintBefore)
                expect(replaced.tabs).not.toContain(oldTab)

                // Old tab/ref are dead: before and after resume.
                const observeOld = await expectCode(fresh.client.observe({ taskId, tabId: oldTab }), 'SCOPE_DENIED', 'observe old tab after browser replacement')
                const staleStep: BatchStep = { stepId: sid('old'), actionId: aid('old'), tabId: oldTab, kind: 'click', ref: oldBuy, timeoutMs: 5_000 }
                const oldBatch = await fresh.client.submitBatch({ taskId, expectedVersion: replaced.stateVersion, requestId: rid(), steps: [staleStep] }).then(() => 'accepted', (error) => error.code as string)
                expect(['CONFLICT', 'SCOPE_DENIED'], `stale-ref batch before resume: ${oldBatch}`).toContain(oldBatch)
                const resumed = await fresh.client.resume({ taskId, expectedVersion: replaced.stateVersion, requestId: rid() })
                expect(resumed.status).toBe('paused')
                expect(resumed.pauseReason).toBe('awaiting-agent')
                await expectCode(fresh.client.submitBatch({ taskId, expectedVersion: resumed.stateVersion, requestId: rid(), steps: [{ ...staleStep, actionId: aid('old2') }] }), 'SCOPE_DENIED', 'stale tab/ref after resume')

                // Same task continues on the new browser; profile storage survived.
                const check = await fresh.client.openPage({ taskId, url: `${SITE_A}/a02a04-storage-check/${STORE_TAG}?run=${suite.run}`, requestId: rid() })
                newTabs.push(check.tabId)
                const storage = await readStorage(fresh.client, taskId, check.tabId, STORE_TAG)
                const storageKept = storage.cookie && storage.ls && storage.idb
                const ledger = await suite.stack.waitForLedger(() => true, { settleMs: 500 })
                evidence('A10', {
                    fault, iteration, taskId, oldBrowserInstanceId: before.browserInstanceId, newBrowserInstanceId: replaced.browserInstanceId,
                    containerChanged: fingerprintAfter !== fingerprintBefore, detectedMs, observeOld: observeOld.code, oldBatch,
                    storageBefore, storageAfter: storage, staleClicksAtFixture: clicks(ledger) - clicksBefore,
                })
                expect(storageKept, 'profile login cookie/localStorage/IndexedDB must survive the browser fault').toBe(true)
                expect(clicks(ledger) - clicksBefore, 'no input from a stale ref may reach the fixture').toBe(0)
                const current = await fresh.client.getTask({ taskId })
                const finished = await fresh.client.finishTask({ taskId, expectedVersion: current.stateVersion, requestId: rid() })
                expect(finished.status).toBe('succeeded')
                expect(finished.taskId).toBe(taskId)
            } finally {
                const cleanup = suite.client(token)
                if (taskId) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, [...(oldTab ? [oldTab] : []), ...newTabs])
                suite.closeAll()
            }
        }, 240_000)
    }

    const runtimeFaults = [
        // Graceful restart first: if SIGKILL recovery leaves the Runtime down, the
        // graceful path has still been measured.
        { name: 'restart-runtime', profileId: PROFILE_B, inject: () => suite.stack.fault('restart-runtime') },
        { name: 'kill-runtime+start-runtime', profileId: PROFILE_A, inject: () => { suite.stack.fault('kill-runtime'); suite.stack.fault('start-runtime') } },
    ]
    for (const { name, profileId, inject } of runtimeFaults) {
        it.each(repeat(3))(`${name} iteration %i: in-flight write → uncertain after recovery, never retried`, async (iteration) => {
            const token = suite.mintAgent({ profileId }).token
            const agent = suite.client(token)
            const taskSpaceId = spaces.get(profileId)!
            const key = `a10-${name}-${iteration}`
            let taskId: TaskId | undefined
            let tabId: TabId | undefined
            try {
                const task = await agent.client.createTask({ taskSpaceId, requestId: rid() })
                taskId = task.taskId
                const opened = await agent.client.openPage({ taskId, url: `${SITE_A}/marker?label=a10`, requestId: rid() })
                tabId = opened.tabId
                const writeAction = aid('slow-write')
                const step: BatchStep = { stepId: sid('write'), actionId: writeAction, tabId, kind: 'navigate', url: `${SITE_A}/a10/slow-write?run=${suite.run}&key=${encodeURIComponent(key)}&ms=${SLOW_WRITE_MS}`, timeoutMs: 30_000 }
                await agent.client.submitBatch({ taskId, expectedVersion: opened.task.stateVersion, requestId: rid(), steps: [step] })
                // In flight = intent durable and the fixture has received the request, response still held.
                const viewer = suite.client(suite.mintInteractive({ profileId }))
                await eventsUntil(viewer.client, taskId, 0, (events) => events.some((event) => event.type === 'action-intent' && event.data.actionId === writeAction))
                const received = await suite.stack.waitForLedger((entries) => slowWrites(entries, key).length >= 1, { timeoutMs: 15_000, settleMs: 0 })
                expect(slowWrites(received, key), 'write did not reach the fixture before the fault').toHaveLength(1)
                const inFlight = await agent.client.getTask({ taskId })
                expect(inFlight.status).toBe('running')
                const portsBefore = suite.runtimeUrl()
                suite.closeAll()

                const faultAtMs = Date.now()
                inject()
                let health: { pid: number; startedAtMs: number }
                try {
                    health = await suite.waitForHealth(60_000)
                } catch (error) {
                    evidence('A10', { fault: name, iteration, taskId, runtimeRecovered: false, container: containerState(suite.run), log: runtimeLogTail(suite.run, 8) })
                    throw new Error(`${name}: Runtime did not come back (writer lock / startup): ${(error as Error).message}`)
                }
                const recoveredMs = Date.now() - faultAtMs
                const fresh = suite.client(token)
                // Recovery may legitimately take a moment; retry past the fixture's held response,
                // but a recovery that fails must not poison every later call.
                let recovered: TaskView | undefined
                let recoveryError: string | undefined
                const recoveryDeadline = Date.now() + SLOW_WRITE_MS + 10_000
                while (!recovered) {
                    try {
                        recovered = await fresh.client.getTask({ taskId })
                    } catch (error) {
                        recoveryError = `${(error as { code?: string }).code}: ${(error as Error).message}`
                        if (Date.now() > recoveryDeadline) {
                            evidence('A10', { fault: name, iteration, taskId, runtimeRecovered: 'healthy-but-ops-fail', recoveryError, log: runtimeLogTail(suite.run, 8) })
                            throw new Error(`${name}: /v1/health is OK but getTask still fails ${SLOW_WRITE_MS + 10_000} ms after the restart (${recoveryError}). `
                                + 'Suspected: Runtime.recoverExistingTasks → restorePersistedTabs → driver.adoptTab timed out on the tab whose write is in flight, '
                                + 'and the rejected this.recovery promise now fails every operation.')
                        }
                        await new Promise((resolve) => setTimeout(resolve, 500))
                    }
                }
                // Hold past the fixture's response time: a retry would show up as a second receipt.
                const settle = await suite.stack.waitForLedger((entries) => slowWrites(entries, key).length > 1, { timeoutMs: SLOW_WRITE_MS + 3_000, settleMs: 0 })
                const receipts = slowWrites(settle, key).length
                const again = await fresh.client.getTask({ taskId })
                const newViewer = suite.client(suite.mintInteractive({ profileId }))
                const events = await eventsUntil(newViewer.client, taskId, 0, () => true)
                const resends = events.filter((event) => event.type === 'action-intent' && event.data.actionId === writeAction).length
                evidence('A10', {
                    fault: name, iteration, taskId, runtimeRecovered: true, recoveredMs, portsChanged: portsBefore !== suite.runtimeUrl(),
                    recoveryErrorBeforeOk: recoveryError, runtimePid: health.pid, runtimeStartedAtMs: health.startedAtMs, status: recovered.status, pauseReason: recovered.pauseReason,
                    uncertain: recovered.uncertainActions.includes(writeAction), fixtureReceipts: receipts, intentRecords: resends,
                    statusAfterSettle: `${again.status}/${again.pauseReason ?? '-'}`,
                })
                expect(recovered.status).toBe('paused')
                expect(recovered.pauseReason).toBe('outcome-unknown')
                expect(recovered.uncertainActions).toContain(writeAction)
                expect(receipts, 'uncertain write must not be retried').toBe(1)
                expect(resends, 'no second intent for the same action').toBe(1)
                expect(again.status).toBe('paused')
                expect(again.pauseReason).toBe('outcome-unknown')
                await expectCode(fresh.client.finishTask({ taskId, expectedVersion: again.stateVersion, requestId: rid() }), 'CONFLICT', 'finish while uncertain after recovery')
                await expectCode(fresh.client.submitBatch({ taskId, expectedVersion: again.stateVersion, requestId: rid(), steps: [step] }), 'CONFLICT', 'resend of the uncertain action')
            } finally {
                const cleanup = suite.client(token)
                if (taskId) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, tabId ? [tabId] : [])
                suite.closeAll()
            }
        }, 240_000)
    }
})
