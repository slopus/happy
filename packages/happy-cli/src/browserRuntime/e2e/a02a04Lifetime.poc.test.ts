/**
 * A02 — connection / idle / grant lifetime, real-time variant on the real stack.
 *
 * The Runtime has no viewer-based GC: nothing reaps a browser or task because
 * no client is connected (pinnedProfiles() is exposed for a future GC, see
 * admin/debug). The minute-scale boundaries (userWaitMs 10 min,
 * pausedBrowserRetentionMs 10 min, terminalBrowserIdleMs 5 min,
 * workerStaleMs 60 s) are covered with a controlled clock in runtime.test.ts;
 * here we run the shortest real timings reachable: a test idle window
 * (ABP_A02_IDLE_MS, default 20 s), short grant/capability TTLs (seconds), and
 * "not extended" checks for duplicate resume / viewer heartbeats.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AgentSessionId, type TaskEvent, type TaskId, type TaskSpaceId, type TaskView } from '../contracts'
import type { RuntimeClient } from '../runtimeClient'
import { PROFILE_A, SITE_A, startPocStack, type LedgerEntry, type PocStack } from './pocStack'
import {
    admin, allEvents, cleanupTask, clientFor, evidence, mintAgent, mintInteractive, range, repeat, rid, sleep, step, tagOf, waitForTask,
} from './a02a04Helpers'

const ITERATIONS = repeat(3)
const IDLE_MS = Number(process.env.ABP_A02_IDLE_MS ?? 20_000)
const TICK_MS = 4_000

let stack: PocStack
beforeAll(async () => { stack = await startPocStack() }, 300_000)
afterAll(() => stack?.down({ purge: true }))

const opened: Array<{ agentSessionId: AgentSessionId; taskId: TaskId; taskSpaceId: TaskSpaceId }> = []
afterEach(async () => {
    // A fresh grant for the same agent session: the task's own grant may be expired or revoked by now.
    for (const t of opened.splice(0))
        await cleanupTask(clientFor(stack, mintAgent(stack, { agentSessionId: t.agentSessionId }).token), t.taskId, t.taskSpaceId,
            (taskId, actionId) => admin(stack, '/admin/reconcile-action', { taskId, actionId, confirmed: true }))
}, 120_000)

async function openTask(url: string, ttlMs?: number) {
    const agentSessionId = `agent-a02-${Math.random().toString(36).slice(2)}` as AgentSessionId
    const { token, grantId } = mintAgent(stack, { agentSessionId, ...(ttlMs ? { ttlMs } : {}) })
    const client = clientFor(stack, token)
    const { taskSpaceId } = await client.createSpace({ profileId: PROFILE_A, requestId: rid() })
    const task = await client.createTask({ taskSpaceId, requestId: rid() })
    opened.push({ agentSessionId, taskId: task.taskId, taskSpaceId })
    const page = await client.openPage({ taskId: task.taskId, url, requestId: rid() })
    return { client, token, grantId, agentSessionId, taskId: task.taskId, tabId: page.tabId, task: page.task }
}

const ticks = (entries: LedgerEntry[], tag: string) => entries.filter((e) => e.kind === 'a02a04-tick' && e.tag === tag)
const tickUrl = (tag: string, n: number, ms = TICK_MS) => `${SITE_A}/a02a04-tick/${tag}?run=${stack.run}&n=${n}&ms=${ms}`

/** Submit N slow navigate steps and return without waiting (the client then goes away). */
async function submitTicks(t: Awaited<ReturnType<typeof openTask>>, tag: string, n: number, ms = TICK_MS) {
    const submitted = await t.client.submitBatch({ taskId: t.taskId, expectedVersion: t.task.stateVersion, requestId: rid(),
        steps: range(n).map((k) => step(t.tabId, 'navigate', { url: tickUrl(tag, k + 1, ms), timeoutMs: ms + 10_000 })) }, { waitMs: 0 })
    expect(submitted.accepted).toBe(true)
    return submitted
}

async function pauseEvent(viewer: RuntimeClient, taskId: TaskId, reason: string): Promise<TaskEvent | undefined> {
    return (await allEvents(viewer, taskId)).find((e) => e.type === 'state-changed' && e.data.pauseReason === reason)
}

describe('A02 running task without any client', () => {
    it.each(range(ITERATIONS))('iteration %i: progresses past the idle window; browser not reaped', async (i) => {
        const tag = tagOf('idle', i)
        const steps = Math.ceil(IDLE_MS / TICK_MS) + 1
        const t = await openTask(tickUrl(tag, 0, 0))
        await submitTicks(t, tag, steps)
        const disconnectedAt = Date.now()
        // From here on: no Runtime client call until the ledger shows all steps (fixture ledger is the independent witness).
        const midDebug = await admin<{ pinnedProfiles: string[]; drivers: Record<string, { connected: boolean }> }>(stack, '/admin/debug')
        const ledger = await stack.waitForLedger((entries) => ticks(entries, tag).filter((e) => Number(e.n) >= 1).length >= steps,
            { timeoutMs: steps * TICK_MS + 30_000, settleMs: 1_000 })
        const idleMs = Date.now() - disconnectedAt
        const done = ticks(ledger, tag).filter((e) => Number(e.n) >= 1)
        expect(done.map((e) => e.n), 'every step dispatched exactly once while no client was connected').toEqual(range(steps).map((k) => k + 1))
        expect(idleMs, 'the client-less window must exceed the test idle window').toBeGreaterThanOrEqual(IDLE_MS)
        const reconnect = clientFor(stack, t.token)
        // The batch result is stored in its own commit right after the pause commit: settle on both.
        const task = await waitForTask(reconnect, t.taskId, (v) => v.status !== 'running' && v.lastBatch !== undefined)
        expect(task.status).toBe('paused')
        expect(task.pauseReason).toBe('awaiting-agent')
        expect(task.lastBatch?.outcome).toBe('succeeded')
        expect(task.browserInstanceId, 'browser must not be reaped/replaced while no client is connected').toBe(t.task.browserInstanceId)
        expect(midDebug.pinnedProfiles).toContain(PROFILE_A)
        expect(midDebug.drivers[PROFILE_A].connected).toBe(true)
        evidence({ card: 'A02', path: 'no-client-idle', iteration: i, steps, idleWindowMs: IDLE_MS, clientlessMs: idleMs,
            tickSpanMs: done.at(-1)!.atMs - done[0].atMs, pinnedWhileRunning: true, browserReplaced: false,
            note: 'Runtime has no viewer-based GC; pinnedProfiles only' })
    }, 180_000)
})

describe('A02 grant expiry and revocation stop dispatch', () => {
    it.each(range(ITERATIONS))('iteration %i: short-ttl grant → paused(grant-expired) by the sweep, 0 new dispatch', async (i) => {
        const tag = tagOf('ttl', i)
        const ttlMs = 8_000
        const t = await openTask(tickUrl(tag, 0, 0), ttlMs)
        const expiresAt = t.task.createdAtMs - 1_000 + ttlMs // upper bound; grant minted just before createSpace
        await submitTicks(t, tag, 10, 3_000)
        const viewer = clientFor(stack, mintInteractive(stack))
        const paused = await waitForTask(viewer, t.taskId, (v) => v.pauseReason === 'grant-expired', ttlMs + 20_000)
        expect(paused.status).toBe('paused')
        expect(paused.pauseReason).toBe('grant-expired')
        const event = await pauseEvent(viewer, t.taskId, 'grant-expired')
        expect(event).toBeDefined()
        const settled = await stack.waitForLedger(() => true, { settleMs: 6_000 })
        const after = ticks(settled, tag).filter((e) => e.atMs > event!.atMs)
        expect(after.length, 'no navigate may be dispatched after grant-expired').toBe(0)
        expect(ticks(settled, tag).filter((e) => Number(e.n) >= 1).length).toBeLessThan(10)
        const denied = await t.client.getTask({ taskId: t.taskId }).then(() => 'ok', (e: BrowserRuntimeError) => e.code)
        expect(denied).toBe('UNAUTHORIZED')
        evidence({ card: 'A02', path: 'grant-expired', iteration: i, ttlMs, pauseLagMs: event!.atMs - expiresAt,
            dispatchedBefore: ticks(settled, tag).length, dispatchedAfter: after.length })
    }, 120_000)

    it.each(range(ITERATIONS))('iteration %i: admin revoke → paused(grant-expired), 0 new dispatch, revoked token rejected', async (i) => {
        const tag = tagOf('rev', i)
        const t = await openTask(tickUrl(tag, 0, 0))
        await submitTicks(t, tag, 10, 3_000)
        await stack.waitForLedger((entries) => ticks(entries, tag).some((e) => Number(e.n) >= 2), { timeoutMs: 20_000, settleMs: 0 })
        const revokedAt = Date.now()
        await admin(stack, '/admin/revoke-grant', { grantId: t.grantId })
        const viewer = clientFor(stack, mintInteractive(stack))
        const paused = await waitForTask(viewer, t.taskId, (v) => v.pauseReason === 'grant-expired', 15_000)
        expect(paused.pauseReason).toBe('grant-expired')
        const event = await pauseEvent(viewer, t.taskId, 'grant-expired')
        const settled = await stack.waitForLedger(() => true, { settleMs: 6_000 })
        const after = ticks(settled, tag).filter((e) => e.atMs > event!.atMs)
        expect(after.length, 'no navigate may be dispatched after revocation').toBe(0)
        const denied = await t.client.getTask({ taskId: t.taskId }).then(() => 'ok', (e: BrowserRuntimeError) => e.code)
        expect(denied).toBe('UNAUTHORIZED')
        evidence({ card: 'A02', path: 'grant-revoked', iteration: i, pauseLagMs: event!.atMs - revokedAt, dispatchedAfter: after.length })
    }, 120_000)
})

describe('A02 client capability expiry does not stop a task within its valid grant', () => {
    it.each(range(ITERATIONS))('iteration %i: viewer capability expires mid-run, task completes', async (i) => {
        const tag = tagOf('cap', i)
        const steps = 5
        const t = await openTask(tickUrl(tag, 0, 0))
        const viewer = clientFor(stack, mintInteractive(stack, { ttlMs: 3_000 }))
        await submitTicks(t, tag, steps, 2_000)
        expect((await viewer.getTask({ taskId: t.taskId })).status).toBe('running')
        await sleep(3_500) // let the viewer capability expire (hang guard / absence proof only)
        const denied = await viewer.getTask({ taskId: t.taskId }).then(() => 'ok', (e: BrowserRuntimeError) => e.code)
        expect(denied).toBe('UNAUTHORIZED')
        const ledger = await stack.waitForLedger((entries) => ticks(entries, tag).filter((e) => Number(e.n) >= 1).length >= steps,
            { timeoutMs: 40_000 })
        expect(ticks(ledger, tag).filter((e) => Number(e.n) >= 1).length).toBe(steps)
        const task = await waitForTask(t.client, t.taskId, (v) => v.status !== 'running' && v.lastBatch !== undefined)
        expect(task.pauseReason).toBe('awaiting-agent')
        expect(task.lastBatch?.outcome).toBe('succeeded')
        evidence({ card: 'A02', path: 'client-cap-expiry', iteration: i, viewerAfterExpiry: denied, steps })
    }, 120_000)
})

describe('A02 awaiting-user is kept within userWaitMs', () => {
    it.each(range(ITERATIONS))('iteration %i: approval wait survives the idle window with no client, 0 writes', async (i) => {
        const t = await openTask(`${SITE_A}/risky-submit?run=${stack.run}`)
        const observation = await t.client.observe({ taskId: t.taskId, tabId: t.tabId })
        const amount = observation.elements.find((e) => e.name.startsWith('Amount'))!
        const confirm = observation.elements.find((e) => e.name === 'Confirm payment')!
        const riskyBefore = (await stack.ledger()).filter((e) => e.kind === 'risky').length
        const submitted = await t.client.submitBatch({ taskId: t.taskId, expectedVersion: t.task.stateVersion, requestId: rid(), steps: [
            step(t.tabId, 'fill', { ref: amount.ref, value: '7' }), step(t.tabId, 'click', { ref: confirm.ref }),
        ] }, { waitMs: 30_000 })
        expect(submitted.result?.outcome).toBe('awaiting-user')
        const approval = submitted.result!.pendingApproval!
        await sleep(IDLE_MS) // no client for the idle window
        const reconnect = clientFor(stack, t.token)
        const task = await reconnect.getTask({ taskId: t.taskId })
        const debug = await admin<{ pinnedProfiles: string[] }>(stack, '/admin/debug')
        const writes = (await stack.ledger()).filter((e) => e.kind === 'risky').length - riskyBefore
        expect(task.status).toBe('awaiting-user')
        expect(task.waitReason).toBe('approval')
        expect(task.pendingApproval?.approvalId).toBe(approval.approvalId)
        expect(writes, 'no write while awaiting approval').toBe(0)
        expect(debug.pinnedProfiles).toContain(PROFILE_A)
        expect(approval.expiresAtMs - task.createdAtMs).toBeGreaterThan(9 * 60_000)
        evidence({ card: 'A02', path: 'awaiting-user-kept', iteration: i, heldMs: IDLE_MS, writes,
            approvalTtlMs: approval.expiresAtMs - task.updatedAtMs, expiryBoundary: 'fake-clock (runtime.test.ts)' })
    }, 120_000)
})

describe('A02 pinnedProfiles retention is not extended by duplicate resume / viewer heartbeat', () => {
    it.each(range(ITERATIONS))('iteration %i: updatedAtMs (retention clock) unchanged by 5 resumes + 5 viewer polls', async (i) => {
        const tag = tagOf('pin', i)
        const t = await openTask(tickUrl(tag, 0, 0))
        await submitTicks(t, tag, 1, 0)
        // Baseline only after the trailing batch-result commit (resultStored), which legitimately moves updatedAtMs.
        const paused = await waitForTask(t.client, t.taskId, (v) => v.pauseReason === 'awaiting-agent' && v.lastBatch !== undefined)
        expect(paused.pauseReason).toBe('awaiting-agent')
        const viewer = clientFor(stack, mintInteractive(stack))
        const results: Array<TaskView | string> = []
        for (const _ of range(5)) {
            results.push(await t.client.resume({ taskId: t.taskId, expectedVersion: paused.stateVersion, requestId: rid() })
                .catch((e: BrowserRuntimeError) => e.code))
            await viewer.getTask({ taskId: t.taskId })
            await viewer.subscribe({ taskId: t.taskId, afterSeq: paused.highWatermarkSeq })
        }
        const after = await t.client.getTask({ taskId: t.taskId })
        const debug = await admin<{ pinnedProfiles: string[] }>(stack, '/admin/debug')
        const later = (await allEvents(viewer, t.taskId)).filter((e) => e.seq > paused.highWatermarkSeq)
            .map((e) => ({ type: e.type, atMs: e.atMs, data: e.data }))
        expect(after.updatedAtMs, `duplicate resume / viewer heartbeat must not extend the retention clock; events after baseline: ${
            JSON.stringify(later)}; stateVersion ${paused.stateVersion}→${after.stateVersion}`).toBe(paused.updatedAtMs)
        expect(after.stateVersion).toBe(paused.stateVersion)
        expect(debug.pinnedProfiles).toContain(PROFILE_A)
        const finished = await t.client.finishTask({ taskId: t.taskId, expectedVersion: after.stateVersion, requestId: rid() })
        expect(finished.status).toBe('succeeded')
        evidence({ card: 'A02', path: 'pin-not-extended', iteration: i, resumes: results.map((r) => typeof r === 'string' ? r : r.status),
            updatedAtUnchanged: true, pinnedWhilePaused: true,
            boundaries: 'pausedBrowserRetentionMs/terminalBrowserIdleMs/userWaitMs/workerStaleMs → fake-clock (runtime.test.ts)' })
    }, 90_000)
})
