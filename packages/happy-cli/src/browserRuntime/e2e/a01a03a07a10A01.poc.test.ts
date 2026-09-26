/**
 * A01 (deterministic path) — work continues after every client is gone.
 *
 * A task reaches the /barrier page with a pre-submitted batch whose waitFor
 * blocks on the barrier. The harness then destroys every Runtime HTTP
 * connection of the test, confirms from inside the Runtime container that no
 * client connection is established, and only then releases the barrier. The
 * fixture ledger must show the answer written once, with the nonce, after the
 * release; the journal must show those inputs came from the pre-submitted batch.
 * A fresh client then reads the same task and finishes it (steps 5–6).
 *
 * "Client" here = the test's RuntimeClient/HTTP connections. The real Desktop
 * process-tree kill and the real agent path (step 4) are covered elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionId, TabId, TaskId, TaskSpaceId } from '../contracts'
import {
    aid, answerEntries, barrierUrl, cleanupTask, containerFingerprint, eventsUntil, evidence, repeat, rid,
    runtimeConnections, sid, startSuiteStack, waitForNoRuntimeConnections, type SuiteStack,
} from './a01a03a07a10Helpers'
import { PROFILE_A, SITE_A } from './pocStack'

describe('A01 deterministic continuation without clients', () => {
    let suite: SuiteStack
    let taskSpaceId: TaskSpaceId

    beforeAll(async () => {
        suite = await startSuiteStack('a01')
        const { token } = suite.mintAgent()
        const { client, close } = suite.client(token)
        try {
            taskSpaceId = (await client.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        } finally {
            close()
        }
    }, 300_000)

    afterAll(() => suite?.down())

    it.each(repeat(10))('iteration %i: pre-submitted batch completes after all clients are closed', async (iteration) => {
        const key = `a01-${iteration}`
        const nonce = `nonce-${iteration}-${Date.now().toString(36)}`
        const { token } = suite.mintAgent()
        const first = suite.client(token)
        let taskId: TaskId | undefined
        let tabId: TabId | undefined
        try {
            // Step 1: task at the barrier, identifiers recorded.
            const task = await first.client.createTask({ taskSpaceId, requestId: rid() })
            taskId = task.taskId
            const opened = await first.client.openPage({ taskId, url: barrierUrl(SITE_A, suite.run, key), requestId: rid() })
            tabId = opened.tabId
            const waitAction = aid('wait') as ActionId
            const observeAction = aid('observe') as ActionId
            const fillAction = aid('fill') as ActionId
            const clickAction = aid('click') as ActionId
            const submitted = await first.client.submitBatch({
                taskId,
                expectedVersion: opened.task.stateVersion,
                requestId: rid(),
                steps: [
                    { stepId: sid('wait'), actionId: waitAction, tabId, kind: 'waitFor', until: { kind: 'text', text: 'NONCE:' }, timeoutMs: 120_000 },
                    { stepId: sid('page'), actionId: observeAction, tabId, kind: 'observe', name: 'page', timeoutMs: 10_000 },
                    { stepId: sid('fill'), actionId: fillAction, tabId, kind: 'fill', ref: '$page.Answer', value: nonce, timeoutMs: 10_000 },
                    { stepId: sid('click'), actionId: clickAction, tabId, kind: 'click', ref: '$page.Submit answer', timeoutMs: 10_000 },
                ],
            })
            const batchId = submitted.batchId
            // The answer form does not exist before the release, so the batch
            // observes the released page itself and targets named in-batch refs
            // (the agent never saw those elements; no ref from another snapshot).
            // The answer click is not approval-required, so it confirms without a
            // postcondition step; the fixture ledger is the postcondition here.
            // The waitFor intent is durable = the batch is parked at the barrier.
            // subscribe is a client (viewer) operation; agent grants cannot carry it.
            const viewer = suite.client(suite.mintInteractive())
            const parked = await eventsUntil(viewer.client, taskId, 0, (events) => events.some((event) => event.type === 'action-intent' && event.data.actionId === waitAction))
            const atBarrier = await first.client.getTask({ taskId })
            expect(atBarrier.status).toBe('running')
            expect(atBarrier.currentBatchId).toBe(batchId)
            const ids = {
                taskId,
                profileId: atBarrier.profileId,
                taskSpaceId: atBarrier.taskSpaceId,
                browserInstanceId: atBarrier.browserInstanceId,
                runtimeFingerprint: containerFingerprint(`abp-${suite.run}-runtime`),
                browserFingerprint: containerFingerprint(`abp-${suite.run}-browser-a`),
                batchId,
                parkedAtSeq: parked.at(-1)?.seq,
            }

            // Step 2: every client connection of the test goes away.
            const closedAtMs = Date.now()
            suite.closeAll()
            const noClient = await waitForNoRuntimeConnections(suite.run)

            // Step 3: release only after "no client" was recorded.
            // Host and container clocks differ by a few ms, so the causal order is
            // also recorded on the host clock: noClient → releaseRequested.
            const releaseRequestedAtMs = Date.now()
            await suite.stack.releaseBarrier(key, nonce)
            const ledger = await suite.stack.waitForLedger((entries) => answerEntries(entries, key).length >= 1, { timeoutMs: 60_000, settleMs: 2_000 })
            const connectionsWhileProgressing = runtimeConnections(suite.run)
            const answers = answerEntries(ledger, key)
            if (answers.length === 0) {
                const probe = suite.client(token)
                const stuck = await probe.client.getTask({ taskId })
                probe.close()
                evidence('A01', { iteration, noAnswer: { status: stuck.status, pauseReason: stuck.pauseReason, lastBatch: stuck.lastBatch && {
                    outcome: stuck.lastBatch.outcome, completedSteps: stuck.lastBatch.completedSteps, failedStep: stuck.lastBatch.failedStep,
                    errors: stuck.lastBatch.steps.filter((step) => step.error).map((step) => [step.stepId, step.error?.code, step.error?.message]) } } })
            }
            const release = ledger.find((entry) => entry.kind === 'barrier-release' && entry.key === key)
            expect(connectionsWhileProgressing, 'a client reconnected before the ledger result was checked').toBe(0)
            expect(release, 'barrier release not ledgered').toBeDefined()
            expect(answers, 'answer must be written exactly once').toHaveLength(1)
            expect(answers[0].correct, 'answer must carry the released nonce').toBe(true)
            expect(answers[0].atMs).toBeGreaterThanOrEqual(release!.atMs)
            expect(noClient.atMs).toBeLessThanOrEqual(releaseRequestedAtMs)

            // Step 5: a fresh client reads the same task; inputs came from the pre-submitted batch.
            const second = suite.client(token)
            const secondViewer = suite.client(suite.mintInteractive())
            const events = await eventsUntil(secondViewer.client, taskId, 0, (all) => all.some((event) => event.type === 'state-changed' && event.data.batchOutcome !== undefined))
            const after = await second.client.getTask({ taskId })
            expect(after.taskId).toBe(taskId)
            expect(after.status).toBe('paused')
            expect(after.pauseReason).toBe('awaiting-agent')
            expect(after.lastBatch?.batchId).toBe(batchId)
            expect(after.lastBatch?.outcome).toBe('succeeded')
            expect(after.lastBatch?.completedSteps).toEqual(['wait', 'page', 'fill', 'click'])
            const accepted = events.filter((event) => event.type === 'batch-accepted')
            expect(accepted, 'no batch may be submitted after the client closed').toHaveLength(1)
            const dispatched = events.filter((event) => event.type === 'action-dispatched')
            const fillEvent = dispatched.find((event) => event.data.actionId === fillAction)
            const clickEvent = dispatched.find((event) => event.data.actionId === clickAction)
            expect(fillEvent && clickEvent, 'fill/click must be dispatched by the pre-submitted batch').toBeTruthy()
            expect(fillEvent!.atMs).toBeGreaterThanOrEqual(release!.atMs)
            expect(clickEvent!.atMs).toBeGreaterThanOrEqual(fillEvent!.atMs)
            const intents = events.filter((event) => event.type === 'action-intent').map((event) => event.data.actionId)
            const batchActions = [waitAction, observeAction, fillAction, clickAction]
            expect(intents.filter((id) => batchActions.includes(id as ActionId))).toEqual(batchActions)
            second.close()
            secondViewer.close()

            // Step 6: "Desktop relaunch" = another fresh client; same task, same profile, no new browser.
            const third = suite.client(token)
            const finished = await third.client.finishTask({ taskId, expectedVersion: after.stateVersion, requestId: rid() })
            expect(finished.status).toBe('succeeded')
            third.close()
            const relaunch = suite.client(token)
            const reread = await relaunch.client.getTask({ taskId })
            expect(reread.status).toBe('succeeded')
            expect(reread.profileId).toBe(ids.profileId)
            expect(reread.taskSpaceId).toBe(ids.taskSpaceId)
            expect(reread.browserInstanceId).toBe(ids.browserInstanceId)
            expect(containerFingerprint(`abp-${suite.run}-browser-a`)).toBe(ids.browserFingerprint)
            const answersAfter = answerEntries(await suite.stack.ledger(), key)
            expect(answersAfter).toHaveLength(1)

            evidence('A01', {
                iteration,
                ...ids,
                closedAtMs,
                noClientAtMs: noClient.atMs,
                noClientPolls: noClient.polls,
                releaseRequestedAtMs,
                releaseLedgerAtMs: release!.atMs,
                answerLedgerAtMs: answers[0].atMs,
                answerCount: answers.length,
                answerCorrect: answers[0].correct,
                fillDispatch: { seq: fillEvent!.seq, atMs: fillEvent!.atMs },
                clickDispatch: { seq: clickEvent!.seq, atMs: clickEvent!.atMs },
                batchAcceptedCount: accepted.length,
                finalStatus: reread.status,
                highWatermarkSeq: reread.highWatermarkSeq,
            })
        } finally {
            const cleanup = suite.client(token)
            if (taskId) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, tabId ? [tabId] : [])
            suite.closeAll()
        }
    }, 240_000)
})
