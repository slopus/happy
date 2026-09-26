/**
 * A04 — persistent login on the execution machine + login/captcha handoff.
 *
 * The agent never logs in itself: a navigate landing on /login* or /challenge*
 * parks the task in awaiting-user(login|captcha); the human takes over, solves
 * it on the X display (xdotool, the noVNC input path — never CDP), releases,
 * and the agent resumes the same batch.
 *
 * Persistence (profile A): login via that handoff, the resumed batch sets storage canaries, then cookie /
 * localStorage / IndexedDB are re-checked from fresh grants after (1) dropping
 * every client, (2) killing Chromium, (3) restarting the browser container.
 * Profile B must stay unauthenticated.
 *
 * Handoff (profile B, per-iteration tag so no earlier cookie satisfies it):
 * a task reaching /protected-strict/<tag> must persist awaiting-user(login)
 * with no client; takeOver → human login → releaseControl → resume continues
 * the same task (ledger `a02a04-after`). Negative paths must not continue.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type TabId, type TaskId, type TaskSpaceId, type TaskView } from '../contracts'
import type { RuntimeClient } from '../runtimeClient'
import { PROFILE_A, PROFILE_B, SITE_A, startPocStack, type LedgerEntry, type PocStack } from './pocStack'
import { STRICT_PASSWORD, Viewer, cleanupTask, clientFor, waitHealthy, runtimePort, mintAgent, mintInteractive, allEvents, evidence, range, repeat, rid, sleep, step, tagOf, waitForTask } from './a02a04Helpers'

const ITERATIONS = repeat(3)

let stack: PocStack
beforeAll(async () => { stack = await startPocStack() }, 300_000)
afterAll(() => stack?.down({ purge: true }))
const openTasks: Array<{ token: string; taskId: TaskId; taskSpaceId: TaskSpaceId }> = []
/** Clients are rebuilt at cleanup: the Runtime port may have moved after restart-runtime. */
const cleanupAll = async () => {
    for (const t of openTasks.splice(0)) await cleanupTask(clientFor(stack, t.token), t.taskId, t.taskSpaceId)
}
afterEach(cleanupAll, 120_000)

async function openTask(profile: 'a' | 'b', url: string) {
    const { token, grantId } = mintAgent(stack, { profileId: profile === 'a' ? PROFILE_A : PROFILE_B })
    const client = clientFor(stack, token)
    const { taskSpaceId } = await client.createSpace({ profileId: profile === 'a' ? PROFILE_A : PROFILE_B, requestId: rid() })
    let task: TaskView
    try {
        task = await client.createTask({ taskSpaceId, requestId: rid() })
    } catch (error) {
        await client.closeSpace({ taskSpaceId, requestId: rid() }).catch(() => undefined)
        throw error
    }
    openTasks.push({ token, taskId: task.taskId, taskSpaceId })
    const opened = await client.openPage({ taskId: task.taskId, url, requestId: rid() })
    return { client, token, grantId, taskSpaceId, taskId: task.taskId, tabId: opened.tabId, task: opened.task }
}

async function pageText(client: RuntimeClient, taskId: TaskId, tabId: TabId, needle: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const observation = await client.observe({ taskId, tabId })
        if (observation.text.includes(needle) || Date.now() > deadline) return observation
        await sleep(200)
    }
}

/** Fresh grant, fresh task: what the profile's storage looks like right now. */
async function probeStorage(profile: 'a' | 'b', tag: string) {
    const deadline = Date.now() + 90_000
    for (;;) {
        try {
            const t = await openTask(profile, `${SITE_A}/a02a04-storage-check/${tag}?run=${stack.run}`)
            try {
            const storage = await pageText(t.client, t.taskId, t.tabId, 'COOKIE=')
            const protectedTab = await t.client.openPage({ taskId: t.taskId, url: `${SITE_A}/protected-strict/${tag}?run=${stack.run}`,
                requestId: rid() })
            // Unauthenticated: the redirect lands on /login-strict and the Runtime parks the task in awaiting-user(login).
            const waitReason = protectedTab.task.status === 'awaiting-user' ? protectedTab.task.waitReason : undefined
            const authenticated = waitReason ? false
                : (await pageText(t.client, t.taskId, protectedTab.tabId, 'STRICT AUTHENTICATED', 5_000)).text.includes('STRICT AUTHENTICATED')
            return { storage: storage.text.trim(), authenticated, waitReason, browserInstanceId: t.task.browserInstanceId }
            } finally {
                await cleanupAll()
            }
        } catch (error) {
            // Browser is coming back after a fault; retry until the hang guard.
            await cleanupAll()
            if (Date.now() > deadline || !(error instanceof BrowserRuntimeError && error.retryable)) throw error
            await sleep(1_000)
        }
    }
}

const count = (entries: LedgerEntry[], kind: string, tag: string) => entries.filter((e) => e.kind === kind && e.tag === tag)

describe('A04 persistent login (profile A) and isolation (profile B)', () => {
    it.each(range(ITERATIONS))('iteration %i: viewer login survives client drop, kill-chrome, browser container restart', async (i) => {
        // Fresh tag per iteration: the persistent login cookie and the LS/IDB canaries are distinct per store and iteration.
        const tag = tagOf('pa', i)
        const viewerA = new Viewer(stack, 'a')
        const t = await reachWait('login', tag, 'a', [
            step(PLACEHOLDER_TAB, 'navigate', { url: `${SITE_A}/a02a04-storage-setup/${tag}?run=${stack.run}` }),
            step(PLACEHOLDER_TAB, 'waitFor', { until: { kind: 'text', text: 'STORAGE SET' } }),
        ])
        const { human, epoch } = await takeOver(t.taskId, t.tabId, PROFILE_A)
        await viewerA.login(tag, STRICT_PASSWORD)
        const login = await stack.waitForLedger((entries) => count(entries, 'a02a04-login', tag).length > 0)
        expect(count(login, 'a02a04-login', tag).map((e) => e.ok)).toEqual([true])
        await release(human, t.taskId, t.tabId, epoch)
        const resumed = await resume(t.client, t.taskId)
        expect(resumed, `resume after login failed: ${resumed instanceof Error ? resumed.message : ''}`).not.toBeInstanceOf(Error)
        const setup = await waitForTask(t.client, t.taskId, (task) => task.status !== 'running')
        expect(setup.lastBatch?.outcome, 'resumed batch must set the storage canaries').toBe('succeeded')
        await cleanupAll()

        // Fresh cookies live only in Chromium memory until its ~30 s commit; wait for the row before stopping the browser.
        const cookieCommitMs = await viewerA.waitCookieOnDisk(`abp_s_${tag}`)
        const expected = `COOKIE=yes LS=ls-${tag} IDB=idb-${tag}`
        const phases: Record<string, unknown> = { cookieCommitMs }
        // (1) all clients dropped: nothing of the old client is reused, only a fresh grant.
        const afterDrop = await probeStorage('a', tag)
        phases.clientDrop = { storageIntact: afterDrop.storage.includes(expected), authenticated: afterDrop.authenticated }
        expect(afterDrop.storage.includes(expected), `storage after client drop: ${afterDrop.storage.replaceAll(tag, '<tag>')}`).toBe(true)
        expect(afterDrop.authenticated).toBe(true)

        // (2a) normal browser shutdown/restart (acceptance: 정상 종료/재시작), same profile volume.
        new Viewer(stack, 'a').gracefulBrowserRestart()
        const afterGraceful = await probeStorage('a', tag)
        phases.gracefulRestart = { storageIntact: afterGraceful.storage.includes(expected), authenticated: afterGraceful.authenticated,
            newInstance: afterGraceful.browserInstanceId !== afterDrop.browserInstanceId }
        expect(afterGraceful.browserInstanceId, 'graceful restart must produce a new browser instance').not.toBe(afterDrop.browserInstanceId)
        expect(afterGraceful.storage.includes(expected), `storage after graceful restart: ${afterGraceful.storage.replaceAll(tag, '<tag>')}`).toBe(true)
        expect(afterGraceful.authenticated).toBe(true)

        // (2b) Chromium killed (fault kill-chrome: SIGTERM to every chromium process) and restarted on the same volume.
        stack.fault('kill-chrome', 'a')
        const afterKill = await probeStorage('a', tag)
        phases.killChrome = { storageIntact: afterKill.storage.includes(expected), authenticated: afterKill.authenticated,
            newInstance: afterKill.browserInstanceId !== afterGraceful.browserInstanceId }
        expect(afterKill.browserInstanceId, 'kill-chrome must produce a new browser instance').not.toBe(afterGraceful.browserInstanceId)
        expect(afterKill.storage.includes(expected), `storage after kill-chrome: ${afterKill.storage.replaceAll(tag, '<tag>')}`).toBe(true)
        expect(afterKill.authenticated).toBe(true)

        // (3) browser container restarted (same profile volume).
        stack.fault('restart-browser-container', 'a')
        await waitHealthy(stack)
        const afterRestart = await probeStorage('a', tag)
        phases.restartContainer = { storageIntact: afterRestart.storage.includes(expected), authenticated: afterRestart.authenticated,
            newInstance: afterRestart.browserInstanceId !== afterKill.browserInstanceId }
        expect(afterRestart.browserInstanceId).not.toBe(afterKill.browserInstanceId)
        expect(afterRestart.storage.includes(expected), `storage after container restart: ${afterRestart.storage.replaceAll(tag, '<tag>')}`).toBe(true)
        expect(afterRestart.authenticated).toBe(true)

        // Profile B never logged in: no cookie, no storage, /protected bounces to /login.
        const b = await probeStorage('b', tag)
        phases.profileB = { storage: b.storage.replace(tag, '<tag>'), authenticated: b.authenticated }
        expect(b.storage.includes('COOKIE=no LS=none IDB=none'), `profile B storage: ${b.storage.replaceAll(tag, '<tag>')}`).toBe(true)
        expect(b.authenticated).toBe(false)
        expect(b.waitReason, 'profile B /protected must land on the login wait').toBe('login')
        evidence({ card: 'A04', path: 'persistence', iteration: i, phases, desktopCookieUpload: 'none (no API exists)' })
    }, 360_000)
})

type Flow = 'login' | 'captcha'
const flowUrls = (flow: Flow, tag: string) => flow === 'login'
    ? { start: `${SITE_A}/protected-strict/${tag}?run=${stack.run}`, prefix: `${SITE_A}/protected-strict/${tag}` }
    : { start: `${SITE_A}/captcha-protected/${tag}?run=${stack.run}`, prefix: `${SITE_A}/captcha-protected/${tag}` }

const PLACEHOLDER_TAB = '__tab__' as TabId
/**
 * Task starts on a neutral page, then one batch navigates to the protected page (redirected to /login-strict or
 * /challenge-strict) followed by `rest` (default: the /a02a04-after continuation witness). The Runtime must stop
 * the batch at awaiting-user(<flow>) and persist it with no client.
 */
async function reachWait(flow: Flow, tag: string, profile: 'a' | 'b' = 'b', rest?: unknown[]) {
    const urls = flowUrls(flow, tag)
    const t = await openTask(profile, `${SITE_A}/a02a04-tick/${tag}?run=${stack.run}&n=0&ms=0`)
    const tail = (rest ?? [step(PLACEHOLDER_TAB, 'navigate', { url: `${SITE_A}/a02a04-after/${tag}?run=${stack.run}` })])
        .map((s) => ({ ...(s as object), tabId: t.tabId }) as never)
    const submitted = await t.client.submitBatch({ taskId: t.taskId, expectedVersion: t.task.stateVersion, requestId: rid(), steps: [
        step(t.tabId, 'navigate', { url: urls.start }), ...tail,
    ] }, { waitMs: 30_000 })
    expect(submitted.result?.outcome, `batch should stop at awaiting-user(${flow})`).toBe('awaiting-user')
    expect(submitted.result?.waitReason).toBe(flow)
    // No client for a while: a fresh client (same grant, new connection) sees the persisted wait.
    await sleep(1_500)
    const fresh = clientFor(stack, t.token)
    const persisted = await fresh.getTask({ taskId: t.taskId })
    expect(persisted.status).toBe('awaiting-user')
    expect(persisted.waitReason).toBe(flow)
    return { ...t, client: fresh }
}

/** Interactive takeOver with the epoch from TaskView.tabLeases; waits until the owner is really the user (settling). */
async function takeOver(taskId: TaskId, tabId: TabId, profileId: typeof PROFILE_A | typeof PROFILE_B = PROFILE_B) {
    const human = clientFor(stack, mintInteractive(stack, { profileId }))
    const lease = (await human.getTask({ taskId })).tabLeases?.find((l) => l.tabId === tabId)
    expect(lease, 'TaskView.tabLeases must expose the task tab').toBeDefined()
    const control = await human.takeOver({ taskId, tabId, expectedEpoch: lease!.leaseEpoch, requestId: rid() })
    expect(control.task.pauseReason).toBe('user-control')
    const owned = await waitForTask(human, taskId, (task) => task.tabLeases?.find((l) => l.tabId === tabId)?.owner.kind === 'user', 15_000)
    const now = owned.tabLeases!.find((l) => l.tabId === tabId)!
    expect(now.owner.kind, `owner must become user after takeOver (settling=${control.settling})`).toBe('user')
    return { human, control, epoch: now.leaseEpoch }
}

async function release(human: RuntimeClient, taskId: TaskId, tabId: TabId, epoch: number) {
    const released = await human.releaseControl({ taskId, tabId, expectedEpoch: epoch, requestId: rid() })
    expect(released.task.pauseReason).toBe('user-input-complete')
    return released
}

async function resume(client: RuntimeClient, taskId: TaskId): Promise<TaskView | BrowserRuntimeError> {
    const current = await client.getTask({ taskId })
    try {
        return await client.resume({ taskId, expectedVersion: current.stateVersion, requestId: rid() })
    } catch (error) {
        if (error instanceof BrowserRuntimeError) return error
        throw error
    }
}

async function humanSolves(flow: Flow, tag: string, password = STRICT_PASSWORD) {
    const viewer = new Viewer(stack, 'b')
    if (flow === 'login') await viewer.login(tag, password)
    else await viewer.solveChallenge(tag)
    const kind = flow === 'login' ? 'a02a04-login' : 'a02a04-challenge'
    const ledger = await stack.waitForLedger((entries) => count(entries, kind, tag).length > 0, { timeoutMs: 15_000 })
    return count(ledger, kind, tag)
}

/** Full happy handoff; returns the continued task. */
async function completeHandoff(flow: Flow, tag: string, t: { client: RuntimeClient; taskId: TaskId; tabId: TabId }, options: { afterRuntimeRestart?: boolean } = {}) {
    const { human, epoch } = await takeOver(t.taskId, t.tabId)
    const attempts = await humanSolves(flow, tag)
    expect(attempts.at(-1)?.ok).toBe(true)
    await release(human, t.taskId, t.tabId, epoch)
    const resumed = await resume(t.client, t.taskId)
    expect(resumed, `resume after ${flow} failed: ${resumed instanceof Error ? resumed.message : ''}`).not.toBeInstanceOf(Error)
    let done = await waitForTask(t.client, t.taskId, (task) => task.status !== 'running')
    if (options.afterRuntimeRestart) {
        // The restarted Runtime no longer holds the submitted (unredacted) steps, so it must
        // not replay the persisted redacted ones: the batch ends interrupted with nothing
        // sent, and the agent resubmits the continuation on the same task.
        expect(done.lastBatch?.outcome, 'interrupted batch after a Runtime restart').toBe('failed')
        expect(done.lastBatch?.mayHaveSideEffects).toBe(false)
        const before = await stack.waitForLedger(() => true, { settleMs: 1_500 })
        expect(count(before, 'a02a04-after', tag).length, 'a redacted step must never be replayed').toBe(0)
        await t.client.submitBatch({ taskId: t.taskId, expectedVersion: done.stateVersion, requestId: rid(), steps: [
            step(t.tabId, 'navigate', { url: `${SITE_A}/a02a04-after/${tag}?run=${stack.run}` }),
        ] }, { waitMs: 30_000 })
        done = await waitForTask(t.client, t.taskId, (task) => task.status !== 'running')
    }
    const ledger = await stack.waitForLedger((entries) => count(entries, 'a02a04-after', tag).length > 0)
    const after = count(ledger, 'a02a04-after', tag)
    expect(after.length, `same task must continue exactly once after the handoff at the SUBMITTED url (…?run=<run>; a resumed step replayed from `
        + `redacted persisted steps loses its query string); task after resume: ${JSON.stringify({ status: done.status,
        pauseReason: done.pauseReason, waitReason: done.waitReason, batch: done.lastBatch })}`).toBe(1)
    expect(after[0][flow === 'login' ? 'loggedIn' : 'passed']).toBe(true)
    expect(done.taskId).toBe(t.taskId)
    expect(done.pauseReason).toBe('awaiting-agent')
    const events = await allEvents(human, t.taskId)
    if (options.afterRuntimeRestart) {
        // The resume found no live steps and recorded the interruption instead of replaying.
        expect(events.some((e) => e.type === 'recovered' && e.data.interrupted === true)).toBe(true)
    } else {
        expect(events.some((e) => e.type === 'state-changed' && e.data.resumedAfter === flow)).toBe(true)
    }
    return done
}

async function expectStillWaiting(flow: Flow, tag: string, t: { client: RuntimeClient; taskId: TaskId }) {
    const task = await t.client.getTask({ taskId: t.taskId })
    const ledger = await stack.waitForLedger(() => true, { settleMs: 1_500 })
    expect(task.status, `task must stay awaiting-user(${flow}) without the postcondition`).toBe('awaiting-user')
    expect(task.waitReason).toBe(flow)
    expect(count(ledger, 'a02a04-after', tag).length, 'task must not continue without the postcondition').toBe(0)
    return task
}

describe.each(['login', 'captcha'] as const)('A04 handoff: waitReason=%s', (flow) => {
    it.each(range(ITERATIONS))(`iteration %i: awaiting-user(${flow}) with no client → takeOver → human → release → resume continues same task`, async (i) => {
        const tag = tagOf(flow === 'login' ? 'hl' : 'hc', i)
        const started = Date.now()
        const t = await reachWait(flow, tag)
        await completeHandoff(flow, tag, t)
        evidence({ card: 'A04', path: `handoff-${flow}`, iteration: i, taskId: t.taskId, ms: Date.now() - started })
    }, 120_000)

    it.each(range(ITERATIONS))(`iteration %i: resume without ${flow} leaves the task waiting`, async (i) => {
        const tag = tagOf('nr', i)
        const t = await reachWait(flow, tag)
        const resumed = await resume(t.client, t.taskId)
        await expectStillWaiting(flow, tag, t)
        evidence({ card: 'A04', path: `resume-without-${flow}`, iteration: i,
            resume: resumed instanceof BrowserRuntimeError ? resumed.code : resumed.status })
    }, 120_000)

    it.each(range(ITERATIONS))(`iteration %i: "done" without doing anything keeps waiting; a later real ${flow} still continues`, async (i) => {
        const tag = tagOf('nd', i)
        const t = await reachWait(flow, tag)
        const { human, epoch } = await takeOver(t.taskId, t.tabId)
        await release(human, t.taskId, t.tabId, epoch)
        const resumed = await resume(t.client, t.taskId)
        await expectStillWaiting(flow, tag, t)
        await completeHandoff(flow, tag, t)
        evidence({ card: 'A04', path: `done-without-${flow}`, iteration: i,
            resume: resumed instanceof BrowserRuntimeError ? resumed.code : resumed.status })
    }, 150_000)
})

describe('A04 handoff negative: wrong password', () => {
    it.each(range(ITERATIONS))('iteration %i: failed login does not continue the task', async (i) => {
        const tag = tagOf('wp', i)
        const t = await reachWait('login', tag)
        const { human, epoch } = await takeOver(t.taskId, t.tabId)
        const attempts = await humanSolves('login', tag, 'wrong-password')
        expect(attempts.map((a) => a.ok)).toEqual([false])
        await release(human, t.taskId, t.tabId, epoch)
        const resumed = await resume(t.client, t.taskId)
        await expectStillWaiting('login', tag, t)
        evidence({ card: 'A04', path: 'wrong-password', iteration: i, loginAttempts: attempts.length,
            resume: resumed instanceof BrowserRuntimeError ? resumed.code : resumed.status })
    }, 120_000)
})

describe('A04 risky submit after login still needs its own approval', () => {
    it.each(range(ITERATIONS))('iteration %i: 0 writes before approval, 1 after', async (i) => {
        const tag = tagOf('rk', i)
        const t = await reachWait('login', tag)
        const continued = await completeHandoff('login', tag, t)
        const riskyUrl = `${SITE_A}/risky-submit?run=${stack.run}&tag=${tag}`
        const nav = await t.client.submitBatch({ taskId: t.taskId, expectedVersion: continued.stateVersion, requestId: rid(),
            steps: [step(t.tabId, 'navigate', { url: riskyUrl })] }, { waitMs: 30_000 })
        expect(nav.result?.outcome).toBe('succeeded')
        const observation = await t.client.observe({ taskId: t.taskId, tabId: t.tabId })
        const amount = observation.elements.find((e) => e.name.startsWith('Amount'))
        const confirm = observation.elements.find((e) => e.name === 'Confirm payment')
        expect(amount && confirm).toBeTruthy()
        const before = (await stack.ledger()).filter((e) => e.kind === 'risky').length
        let result = (await t.client.submitBatch({ taskId: t.taskId, expectedVersion: nav.task.stateVersion, requestId: rid(), steps: [
            step(t.tabId, 'fill', { ref: amount!.ref, value: '42', snapshotId: observation.snapshotId }),
            step(t.tabId, 'click', { ref: confirm!.ref, snapshotId: observation.snapshotId }),
            step(t.tabId, 'waitFor', { until: { kind: 'text', text: 'PAYMENT RECORDED' } }),
        ] }, { waitMs: 30_000 })).result
        expect(result?.outcome).toBe('awaiting-user')
        expect(result?.waitReason).toBe('approval')
        const settled = await stack.waitForLedger(() => true, { settleMs: 2_000 })
        const writesBeforeApproval = settled.filter((e) => e.kind === 'risky').length - before
        expect(writesBeforeApproval, 'risky submit dispatched before approval').toBe(0)
        const human = clientFor(stack, mintInteractive(stack, { profileId: PROFILE_B }))
        let approvals = 0
        while (result?.outcome === 'awaiting-user' && result.pendingApproval && approvals < 3) {
            approvals += 1
            const approved = await human.approve({ taskId: t.taskId, approvalId: result.pendingApproval.approvalId,
                bindingHash: result.pendingApproval.bindingHash, requestId: rid(), decision: 'approve' })
            result = approved.batch
        }
        expect(result?.outcome, 'approved write with an observed postcondition must be confirmed').toBe('succeeded')
        const after = await stack.waitForLedger((entries) => entries.filter((e) => e.kind === 'risky').length > before)
        expect(after.filter((e) => e.kind === 'risky').length - before).toBe(1)
        evidence({ card: 'A04', path: 'risky-after-login', iteration: i, writesBeforeApproval, approvals })
    }, 150_000)
})

// Last: after a Runtime restart the leaked spaces (closeSpace → TARGET_GONE) would exhaust the per-profile space limit for later tests.
describe.each(['login', 'captcha'] as const)('A04 handoff across Runtime restart: waitReason=%s', (flow) => {
    it.each(range(ITERATIONS))(`iteration %i: Runtime restart while awaiting-user(${flow}) keeps the wait; handoff still works`, async (i) => {
        const tag = tagOf('rr', i)
        const t = await reachWait(flow, tag)
        const portBefore = runtimePort(stack)
        stack.fault('restart-runtime')
        const portAfter = await waitHealthy(stack)
        evidence({ card: 'A04', note: 'runtime-restart-port', changed: portAfter !== portBefore })
        t.client = clientFor(stack, t.token)
        await expectStillWaiting(flow, tag, t)
        // The browser was not restarted, so the task's tab still exists and must stay addressable.
        const viewer = clientFor(stack, mintInteractive(stack, { profileId: PROFILE_B }))
        const lease = (await viewer.getTask({ taskId: t.taskId })).tabLeases?.find((l) => l.tabId === t.tabId)
        expect(lease, 'task tab must be re-adopted after a Runtime-only restart').toBeDefined()
        await completeHandoff(flow, tag, t, { afterRuntimeRestart: true })
        evidence({ card: 'A04', path: `runtime-restart-${flow}`, iteration: i, taskId: t.taskId })
    }, 240_000)
})
