/**
 * A07 — batch, duplicates and partial failure on the real stack.
 *
 * Every write is counted at the fixture (ledger = received requests), so a
 * duplicate dispatch hidden by fixture idempotency would still show up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionId, BatchStep, ElementRef, TabId, TaskId, TaskSpaceId } from '../contracts'
import {
    aid, answerEntries, answerSteps, approveAll, cleanupTask, eventsUntil, evidence, expectCode, openReleasedBarrier, repeat, rid,
    sid, startSuiteStack, type SuiteStack,
} from './a01a03a07a10Helpers'
import { PROFILE_A, SITE_A, type LedgerEntry } from './pocStack'

const clicks = (entries: LedgerEntry[], target = 'A-main') => entries.filter((entry) => entry.kind === 'click' && entry.target === target).length
const risky = (entries: LedgerEntry[], amount: string) => entries.filter((entry) => entry.kind === 'risky' && entry.amount === amount)

describe('A07 batch, duplicate and partial failure', () => {
    let suite: SuiteStack
    let taskSpaceId: TaskSpaceId

    beforeAll(async () => {
        suite = await startSuiteStack('a07')
        const { client, close } = suite.client(suite.mintAgent().token)
        taskSpaceId = (await client.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        close()
    }, 300_000)

    afterAll(() => suite?.down())

    /** Runs body with a fresh agent grant; always brings the task terminal and closes its tabs. */
    async function scenario(body: (agent: ReturnType<SuiteStack['client']>['client'], track: (taskId: TaskId, tabId?: TabId) => void) => Promise<void>) {
        const token = suite.mintAgent().token
        const agent = suite.client(token)
        const tracked: Array<{ taskId: TaskId; tabs: TabId[] }> = []
        try {
            await body(agent.client, (taskId, tabId) => {
                const entry = tracked.find((item) => item.taskId === taskId) ?? (tracked.push({ taskId, tabs: [] }), tracked.at(-1)!)
                if (tabId) entry.tabs.push(tabId)
            })
        } finally {
            const cleanup = suite.client(token)
            for (const { taskId, tabs } of tracked) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, tabs)
            suite.closeAll()
        }
    }

    async function openOopif(agent: ReturnType<SuiteStack['client']>['client'], track: (taskId: TaskId, tabId?: TabId) => void) {
        const task = await agent.createTask({ taskSpaceId, requestId: rid() })
        track(task.taskId)
        const opened = await agent.openPage({ taskId: task.taskId, url: `${SITE_A}/oopif?run=${suite.run}`, requestId: rid() })
        track(task.taskId, opened.tabId)
        const observation = await agent.observe({ taskId: task.taskId, tabId: opened.tabId })
        const buy = observation.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)
        if (!buy) throw new Error('main-frame Buy button not observed')
        return { taskId: task.taskId, tabId: opened.tabId, buy: buy.ref, version: opened.task.stateVersion, openActionId: opened.actionId }
    }

    const clickStep = (tabId: TabId, ref: ElementRef, actionId: ActionId, stepId = 'click'): BatchStep =>
        ({ stepId: sid(stepId), actionId, tabId, kind: 'click', ref, timeoutMs: 10_000 })

    it.each(repeat(10))('iteration %i: duplicate requestId (concurrent + after ACK loss) returns the same batch, ledger count 1', async (iteration) => {
        const key = `a07-dup-${iteration}`
        await scenario(async (agent, track) => {
            const { task, tabId, refs } = await openReleasedBarrier(suite, agent, taskSpaceId, key, `n-${key}`)
            track(task.taskId, tabId)
            const version = (await agent.getTask({ taskId: task.taskId })).stateVersion
            const request = { taskId: task.taskId, expectedVersion: version, requestId: rid(), steps: answerSteps(tabId, refs, `n-${key}`) }
            // Two concurrent sends of the same request (first ACK "lost"), then a late resend.
            const [a, b] = await Promise.all([agent.submitBatch(request, { waitMs: 30_000 }), agent.submitBatch(request, { waitMs: 30_000 })])
            const settled = await agent.getTask({ taskId: task.taskId })
            const late = await agent.submitBatch(request, { waitMs: 5_000 })
            expect(b.batchId).toBe(a.batchId)
            expect(late.batchId).toBe(a.batchId)
            expect(settled.lastBatch?.outcome).toBe('succeeded')
            const ledger = await suite.stack.waitForLedger((entries) => answerEntries(entries, key).length >= 1, { settleMs: 1_500 })
            expect(answerEntries(ledger, key), 'duplicate requestId must not dispatch twice').toHaveLength(1)
            const viewer = suite.client(suite.mintInteractive())
            const events = await eventsUntil(viewer.client, task.taskId, 0, () => true)
            expect(events.filter((event) => event.type === 'batch-accepted')).toHaveLength(1)
            evidence('A07', { path: 'dup-requestId', iteration, taskId: task.taskId, batchId: a.batchId, sends: 3, batchAccepted: 1, ledgerAnswers: 1 })
        })
    }, 120_000)

    it.each(repeat(10))('iteration %i: reusing an actionId in a new batch is CONFLICT (same or different payload)', async (iteration) => {
        await scenario(async (agent, track) => {
            const { taskId, tabId, buy, version } = await openOopif(agent, track)
            const before = clicks(await suite.stack.ledger())
            const actionId = aid('buy')
            const first = await agent.submitBatch({ taskId, expectedVersion: version, requestId: rid(), steps: [clickStep(tabId, buy, actionId)] }, { waitMs: 30_000 })
            expect(first.result?.outcome).toBe('succeeded')
            const afterFirst = await agent.getTask({ taskId })
            const fresh = await agent.observe({ taskId, tabId })
            const freshBuy = fresh.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)!.ref
            // Different payload under the same actionId.
            const differentPayload = await expectCode(
                agent.submitBatch({ taskId, expectedVersion: afterFirst.stateVersion, requestId: rid(), steps: [{ ...clickStep(tabId, freshBuy, actionId), timeoutMs: 9_000 }] }, { waitMs: 10_000 }),
                'CONFLICT', 'same actionId, different payload')
            // Identical step, new batch: the retransmission bypass the plan forbids.
            let samePayloadCode = 'accepted'
            let samePayloadBatch: string | undefined
            try {
                const again = await agent.submitBatch({ taskId, expectedVersion: afterFirst.stateVersion, requestId: rid(), steps: [clickStep(tabId, buy, actionId)] }, { waitMs: 10_000 })
                samePayloadBatch = again.batchId
            } catch (error) {
                samePayloadCode = (error as { code?: string }).code ?? String(error)
            }
            const ledger = await suite.stack.waitForLedger(() => true, { settleMs: 1_500 })
            const dispatched = clicks(ledger) - before
            evidence('A07', { path: 'actionId-reuse', iteration, taskId, differentPayload: differentPayload.code, samePayloadNewBatch: samePayloadCode, samePayloadBatch, ledgerClicks: dispatched })
            expect(dispatched, 'the reused actionId must never reach the fixture twice').toBe(1)
            expect(samePayloadCode, 'same actionId in a new batch must be rejected with CONFLICT, not accepted as a new batch').toBe('CONFLICT')
        })
    }, 120_000)

    it.each(repeat(10))('iteration %i: same requestId with a different payload is CONFLICT', async (iteration) => {
        await scenario(async (agent, track) => {
            const { taskId, tabId, buy, version } = await openOopif(agent, track)
            const before = clicks(await suite.stack.ledger())
            const requestId = rid()
            const first = await agent.submitBatch({ taskId, expectedVersion: version, requestId, steps: [clickStep(tabId, buy, aid('buy'))] }, { waitMs: 30_000 })
            expect(first.result?.outcome).toBe('succeeded')
            await expectCode(agent.submitBatch({ taskId, expectedVersion: version, requestId, steps: [clickStep(tabId, buy, aid('other'))] }), 'CONFLICT', 'same requestId, different steps')
            const ledger = await suite.stack.waitForLedger(() => true, { settleMs: 1_000 })
            expect(clicks(ledger) - before).toBe(1)
            evidence('A07', { path: 'requestId-payload-conflict', iteration, taskId, ledgerClicks: clicks(ledger) - before })
        })
    }, 120_000)

    it.each(repeat(10))('iteration %i: a middle-step failure keeps completed steps and never runs later steps', async (iteration) => {
        await scenario(async (agent, track) => {
            const { taskId, tabId, buy, version } = await openOopif(agent, track)
            const before = clicks(await suite.stack.ledger())
            const steps: BatchStep[] = [
                clickStep(tabId, buy, aid('first'), 's1'),
                { stepId: sid('s2'), actionId: aid('wait'), tabId, kind: 'waitFor', until: { kind: 'text', text: 'THIS TEXT NEVER APPEARS' }, timeoutMs: 1_500 },
                clickStep(tabId, buy, aid('never'), 's3'),
            ]
            const submitted = await agent.submitBatch({ taskId, expectedVersion: version, requestId: rid(), steps }, { waitMs: 30_000 })
            const result = submitted.result
            expect(result, 'batch did not settle').toBeDefined()
            expect(result!.outcome).toBe('failed')
            expect(result!.completedSteps).toEqual(['s1'])
            expect(result!.failedStep).toBe('s2')
            expect(result!.steps.find((step) => step.stepId === 's1')?.outcome).toBe('succeeded')
            expect(result!.steps.some((step) => step.stepId === 's3' && step.outcome === 'succeeded'), 'unexecuted step shown as success').toBe(false)
            expect(result!.mayHaveSideEffects).toBe(false)
            const ledger = await suite.stack.waitForLedger(() => true, { settleMs: 1_000 })
            expect(clicks(ledger) - before, 'only step 1 may reach the fixture').toBe(1)
            const task = await agent.getTask({ taskId })
            expect(task.status).not.toBe('succeeded')
            evidence('A07', { path: 'middle-step-failure', iteration, taskId, outcome: result!.outcome, completedSteps: result!.completedSteps, failedStep: result!.failedStep, ledgerClicks: 1, taskStatus: task.status })
        })
    }, 120_000)

    /**
     * Risky write (approval + postcondition) under three fixture behaviours:
     *  - normal: response arrives, page shows PAYMENT RECORDED → the waitFor
     *    postcondition confirms the click (control path).
     *  - hang: the fixture records the request and HOLDS the response (no socket
     *    reset). The postcondition never appears → uncertain. Both the Runtime's
     *    dispatch count and the fixture receipts must be exactly 1.
     *  - drop-after-record: the fixture resets the socket after recording. Chromium's
     *    network stack may transparently re-send the POST on a reset connection; that
     *    is a browser-level retry, not a Runtime duplicate. Asserted here: Runtime
     *    dispatched once, uncertain; receipts > 1 are recorded as browserLevelRetry.
     */
    const RISKY_MODES = [
        { mode: 'normal', digit: 1 },
        { mode: 'hang', digit: 7 },
        { mode: 'drop-after-record', digit: 3 },
    ] as const
    for (const { mode, digit } of RISKY_MODES) {
        it.each(repeat(10))(`iteration %i: risky write with fixture ${mode}`, async (iteration) => {
            const amount = `${digit}${String(iteration).padStart(3, '0')}.${Date.now() % 1000}`
            await suite.stack.fixtureFault('risky', mode)
            try {
                await scenario(async (agent, track) => {
                    const task = await agent.createTask({ taskSpaceId, requestId: rid() })
                    track(task.taskId)
                    const opened = await agent.openPage({ taskId: task.taskId, url: `${SITE_A}/risky-submit?run=${suite.run}`, requestId: rid() })
                    track(task.taskId, opened.tabId)
                    const observation = await agent.observe({ taskId: task.taskId, tabId: opened.tabId })
                    const input = observation.elements.find((element) => element.role === 'textbox')!
                    const confirm = observation.elements.find((element) => element.name === 'Confirm payment')!
                    const clickAction = aid('pay')
                    const submitted = await agent.submitBatch({
                        taskId: task.taskId, expectedVersion: opened.task.stateVersion, requestId: rid(),
                        steps: [
                            { stepId: sid('fill'), actionId: aid('amount'), tabId: opened.tabId, kind: 'fill', ref: input.ref, snapshotId: observation.snapshotId, value: amount, timeoutMs: 10_000 },
                            { ...clickStep(opened.tabId, confirm.ref, clickAction), snapshotId: observation.snapshotId },
                            { stepId: sid('recorded'), actionId: aid('recorded'), tabId: opened.tabId, kind: 'waitFor', until: { kind: 'text', text: 'PAYMENT RECORDED' }, timeoutMs: 6_000 },
                        ],
                    }, { waitMs: 30_000 })
                    expect(submitted.result?.outcome, 'risky fixture action must wait for approval').toBe('awaiting-user')
                    const viewer = suite.client(suite.mintInteractive())
                    const { result, approvals } = await approveAll(viewer.client, task.taskId, submitted.result)
                    const ledger = await suite.stack.waitForLedger((entries) => risky(entries, amount).length >= 1, { timeoutMs: 15_000, settleMs: 3_000 })
                    const received = risky(ledger, amount).length
                    const after = await agent.getTask({ taskId: task.taskId })
                    let finishCode = 'accepted'
                    try {
                        await agent.finishTask({ taskId: task.taskId, expectedVersion: after.stateVersion, requestId: rid() })
                    } catch (error) {
                        finishCode = (error as { code?: string }).code ?? String(error)
                    }
                    // Separate "who resent": Runtime dispatches vs requests the fixture received.
                    const journal = await eventsUntil(viewer.client, task.taskId, 0, () => true)
                    // The pre-approval intent is rolled back to 'planned' at approval-requested (never dispatched)
                    // and re-committed after approval: count intents/dispatches relative to approval-consumed.
                    const ofClick = (type: string) => journal.filter((event) => event.type === type && event.data.actionId === clickAction)
                    const consumedSeq = journal.find((event) => event.type === 'approval-consumed')?.seq ?? Number.POSITIVE_INFINITY
                    const runtimeIntents = ofClick('action-intent').filter((event) => event.seq > consumedSeq).length
                    const runtimeDispatches = ofClick('action-dispatched').length
                    const dispatchesBeforeApproval = ofClick('action-dispatched').filter((event) => event.seq < consumedSeq).length
                    const receivedAt = risky(ledger, amount).map((entry) => entry.atMs - risky(ledger, amount)[0].atMs)
                    evidence('A07', {
                        path: `risky-${mode}`, iteration, taskId: task.taskId, approvals, received, receivedAtDeltaMs: receivedAt,
                        intentsAfterApproval: runtimeIntents, intentsTotal: ofClick('action-intent').length, dispatchesBeforeApproval,
                        runtimeDispatches, browserLevelRetry: runtimeDispatches === 1 && received > 1,
                        batchOutcome: result?.outcome, mayHaveSideEffects: result?.mayHaveSideEffects, taskStatus: after.status,
                        pauseReason: after.pauseReason, uncertainActions: after.uncertainActions.length, finish: finishCode,
                    })
                    expect(approvals).toBe(1)
                    expect(consumedSeq, 'approval-consumed event missing from the journal').toBeLessThan(Number.POSITIVE_INFINITY)
                    expect(dispatchesBeforeApproval, 'nothing may be dispatched before approval').toBe(0)
                    expect(runtimeIntents, 'the Runtime must record exactly one intent for the click after approval').toBe(1)
                    expect(runtimeDispatches, 'the Runtime must dispatch the click exactly once (no auto resend)').toBe(1)
                    if (mode === 'normal') {
                        expect(received).toBe(1)
                        expect(result?.outcome, 'postcondition observed → confirmed').toBe('succeeded')
                        expect(after.uncertainActions).toEqual([])
                        expect(finishCode).toBe('accepted')
                        return
                    }
                    if (mode === 'hang') expect(received, 'held response: the fixture must receive the write exactly once').toBe(1)
                    else expect(received, 'reset: at least the Runtime\'s one dispatch reaches the fixture').toBeGreaterThanOrEqual(1)
                    expect(result?.outcome, `fixture ${mode}: the postcondition never appeared, so the batch must be uncertain, not ${result?.outcome}`).toBe('uncertain')
                    expect(result?.mayHaveSideEffects).toBe(true)
                    expect(after.uncertainActions).toContain(clickAction)
                    expect(finishCode, 'finishTask must be rejected while an action is uncertain').toBe('CONFLICT')
                })
            } finally {
                await suite.stack.fixtureFault('risky', 'normal')
            }
        }, 150_000)
    }

    it.each(repeat(10))('iteration %i: taskId survives openPage → batch → batch → finish; batch success never finishes the task', async (iteration) => {
        await scenario(async (agent, track) => {
            const before = clicks(await suite.stack.ledger())
            const created = await agent.createTask({ taskSpaceId, requestId: rid() })
            track(created.taskId)
            const openRequest = { taskId: created.taskId, url: `${SITE_A}/oopif?run=${suite.run}`, requestId: rid() }
            const opened = await agent.openPage(openRequest)
            track(created.taskId, opened.tabId)
            // openPage ACK lost → retry with the same requestId: no second tab/navigation.
            const reopened = await agent.openPage(openRequest)
            expect(reopened.tabId).toBe(opened.tabId)
            const obs = await agent.observe({ taskId: created.taskId, tabId: opened.tabId })
            const buy = obs.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)!.ref
            const b1 = await agent.submitBatch({ taskId: created.taskId, expectedVersion: opened.task.stateVersion, requestId: rid(), steps: [clickStep(opened.tabId, buy, aid('b1'))] }, { waitMs: 30_000 })
            expect(b1.result?.outcome).toBe('succeeded')
            const between = await agent.getTask({ taskId: created.taskId })
            expect(between.status, 'a successful batch must not finish the task').toBe('paused')
            expect(between.pauseReason).toBe('awaiting-agent')
            const obs2 = await agent.observe({ taskId: created.taskId, tabId: opened.tabId })
            const buy2 = obs2.elements.find((element) => element.name === 'Buy' && element.frameOrigin === SITE_A)!.ref
            const b2 = await agent.submitBatch({ taskId: created.taskId, expectedVersion: between.stateVersion, requestId: rid(), steps: [clickStep(opened.tabId, buy2, aid('b2'))] }, { waitMs: 30_000 })
            expect(b2.result?.outcome).toBe('succeeded')
            expect(b2.batchId).not.toBe(b1.batchId)
            const beforeFinish = await agent.getTask({ taskId: created.taskId })
            expect(beforeFinish.status).toBe('paused')
            expect(beforeFinish.tabs).toEqual([opened.tabId])
            const finished = await agent.finishTask({ taskId: created.taskId, expectedVersion: beforeFinish.stateVersion, requestId: rid() })
            for (const view of [opened.task, b1.task, b2.task, between, finished]) expect(view.taskId).toBe(created.taskId)
            expect(finished.status).toBe('succeeded')
            const viewer = suite.client(suite.mintInteractive())
            const events = await eventsUntil(viewer.client, created.taskId, 0, () => true)
            expect(events.filter((event) => event.type === 'page-opened'), 'openPage retry must not open a second page').toHaveLength(1)
            const ledger = await suite.stack.waitForLedger(() => true, { settleMs: 1_000 })
            expect(clicks(ledger) - before).toBe(2)
            evidence('A07', { path: 'task-continuity', iteration, taskId: created.taskId, batches: [b1.batchId, b2.batchId], pageOpened: 1, ledgerClicks: 2, finalStatus: finished.status })
        })
    }, 120_000)

    it.each(repeat(10))('iteration %i: browser timeout on a write → uncertain; new batch / same actionId / finish / resume rejected', async (iteration) => {
        await scenario(async (agent, track) => {
            const task = await agent.createTask({ taskSpaceId, requestId: rid() })
            track(task.taskId)
            const opened = await agent.openPage({ taskId: task.taskId, url: `${SITE_A}/marker?label=a07&run=${suite.run}`, requestId: rid() })
            track(task.taskId, opened.tabId)
            const navAction = aid('slow-nav')
            const navStep: BatchStep = { stepId: sid('nav'), actionId: navAction, tabId: opened.tabId, kind: 'navigate', url: `${SITE_A}/slow?ms=8000&run=${suite.run}`, timeoutMs: 1_000 }
            const submitted = await agent.submitBatch({ taskId: task.taskId, expectedVersion: opened.task.stateVersion, requestId: rid(), steps: [navStep] }, { waitMs: 30_000 })
            const result = submitted.result
            const after = await agent.getTask({ taskId: task.taskId })
            evidence('A07', { path: 'timeout-uncertain', iteration, taskId: task.taskId, outcome: result?.outcome, mayHaveSideEffects: result?.mayHaveSideEffects, status: after.status, pauseReason: after.pauseReason })
            expect(result?.outcome).toBe('uncertain')
            expect(result?.mayHaveSideEffects).toBe(true)
            expect(after.status).toBe('paused')
            expect(after.pauseReason).toBe('outcome-unknown')
            expect(after.uncertainActions).toContain(navAction)
            const marker: BatchStep = { stepId: sid('m'), actionId: aid('marker'), tabId: opened.tabId, kind: 'navigate', url: `${SITE_A}/marker?label=x`, timeoutMs: 10_000 }
            await expectCode(agent.submitBatch({ taskId: task.taskId, expectedVersion: after.stateVersion, requestId: rid(), steps: [marker] }), 'CONFLICT', 'new batch while uncertain')
            await expectCode(agent.submitBatch({ taskId: task.taskId, expectedVersion: after.stateVersion, requestId: rid(), steps: [navStep] }), 'CONFLICT', 'same actionId resent in a new batch while uncertain')
            await expectCode(agent.finishTask({ taskId: task.taskId, expectedVersion: after.stateVersion, requestId: rid() }), 'CONFLICT', 'finish while uncertain')
            await expectCode(agent.resume({ taskId: task.taskId, expectedVersion: after.stateVersion, requestId: rid() }), 'CONFLICT', 'resume while uncertain')
            const unchanged = await agent.getTask({ taskId: task.taskId })
            expect(unchanged.stateVersion).toBe(after.stateVersion)
            // Trusted postcondition (harness as broker) confirms, then the same task can finish.
            const reconciled = await suite.admin<{ status: string; pauseReason?: string; stateVersion: number }>('/admin/reconcile-action', { taskId: task.taskId, actionId: navAction, confirmed: true })
            expect(reconciled.pauseReason).toBe('awaiting-agent')
            const finished = await agent.finishTask({ taskId: task.taskId, expectedVersion: reconciled.stateVersion, requestId: rid() })
            expect(finished.status).toBe('succeeded')
        })
    }, 120_000)
})
