/**
 * A03 — same-task reconnect and event cursor.
 *
 * The viewer (interactive capability, the only credential that may subscribe)
 * disconnects at eventSeq=N while the agent side keeps producing events. On
 * reconnect it must get the same task and exactly the events after N; overlap
 * and at-least-once replays are deduped client-side by seq; an out-of-range
 * cursor yields snapshot-required. Nothing is resubmitted by the reconnect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskEvent, TaskId, TaskSpaceId, TabId } from '../contracts'
import {
    answerEntries, answerSteps, cleanupTask, evidence, expectCode, openReleasedBarrier, repeat, rid, startSuiteStack,
    type SuiteStack,
} from './a01a03a07a10Helpers'
import { PROFILE_A } from './pocStack'

const RESTORE_TARGET_MS = 10_000

/** Client-side event log: dedupe by seq, detect gaps and conflicting duplicates. */
class EventLog {
    readonly bySeq = new Map<number, TaskEvent>()
    duplicates = 0
    constructor(readonly taskId: TaskId) {}
    add(events: TaskEvent[]): void {
        for (const event of events) {
            expect(event.taskId, 'event for another task delivered on this cursor').toBe(this.taskId)
            const known = this.bySeq.get(event.seq)
            if (known) {
                expect(JSON.stringify(event), `seq ${event.seq} was redelivered with different content`).toBe(JSON.stringify(known))
                this.duplicates += 1
                continue
            }
            this.bySeq.set(event.seq, event)
        }
    }
    get cursor(): number { return Math.max(0, ...this.bySeq.keys()) }
    assertContiguous(from: number, to: number): void {
        const missing: number[] = []
        for (let seq = from; seq <= to; seq++) if (!this.bySeq.has(seq)) missing.push(seq)
        expect(missing, `events lost between ${from} and ${to}`).toEqual([])
    }
    assertNoRegression(): void {
        const ordered = [...this.bySeq.values()].sort((a, b) => a.seq - b.seq)
        for (let index = 1; index < ordered.length; index++) {
            expect(ordered[index].stateVersion, `stateVersion regressed at seq ${ordered[index].seq}`).toBeGreaterThanOrEqual(ordered[index - 1].stateVersion)
        }
    }
    count(type: TaskEvent['type']): number { return [...this.bySeq.values()].filter((event) => event.type === type).length }
}

describe('A03 reconnect and cursor', () => {
    let suite: SuiteStack
    let taskSpaceId: TaskSpaceId

    beforeAll(async () => {
        suite = await startSuiteStack('a03')
        const { client, close } = suite.client(suite.mintAgent().token)
        taskSpaceId = (await client.createSpace({ profileId: PROFILE_A, requestId: rid() })).taskSpaceId
        close()
    }, 300_000)

    afterAll(() => suite?.down())

    async function withTask<T>(key: string, body: (ctx: {
        agent: ReturnType<SuiteStack['client']>['client']
        taskId: TaskId
        tabId: TabId
        nonce: string
        refs: Awaited<ReturnType<typeof openReleasedBarrier>>['refs']
        version: number
    }) => Promise<T>): Promise<T> {
        const token = suite.mintAgent().token
        const agent = suite.client(token)
        const nonce = `n-${key}`
        let taskId: TaskId | undefined
        let tabId: TabId | undefined
        try {
            const opened = await openReleasedBarrier(suite, agent.client, taskSpaceId, key, nonce)
            taskId = opened.task.taskId
            tabId = opened.tabId
            const current = await agent.client.getTask({ taskId })
            return await body({ agent: agent.client, taskId, tabId, nonce, refs: opened.refs, version: current.stateVersion })
        } finally {
            const cleanup = suite.client(token)
            if (taskId) await cleanupTask(suite, cleanup.client, taskId, taskSpaceId, tabId ? [tabId] : [])
            suite.closeAll()
        }
    }

    it.each(repeat(10))('iteration %i: reconnect after N replays exactly N+1.. with the same ids (re-auth delay included)', async (iteration) => {
        const key = `a03-replay-${iteration}`
        await withTask(key, async ({ agent, taskId, tabId, nonce, refs, version }) => {
            // Viewer connected, reads to eventSeq=N, then disconnects.
            const viewer1 = suite.client(suite.mintInteractive())
            const before = new EventLog(taskId)
            const first = await viewer1.client.subscribe({ taskId, afterSeq: 0 })
            expect(first.kind).toBe('events')
            if (first.kind === 'events') before.add(first.events)
            const snapshotBefore = await viewer1.client.getTask({ taskId })
            const n = before.cursor
            viewer1.close()

            // H keeps working while C is away: N+1.. are produced.
            const submitted = await agent.submitBatch({ taskId, expectedVersion: version, requestId: rid(), steps: answerSteps(tabId, refs, nonce) }, { waitMs: 60_000 })
            expect(submitted.result?.outcome).toBe('succeeded')

            // Re-auth delay: the stale capability is refused, a fresh one is issued.
            const stale = suite.client(suite.mintInteractive({ ttlMs: -4_000 }))
            await expectCode(stale.client.getTask({ taskId }), 'UNAUTHORIZED', 'expired viewer capability')
            stale.close()
            await new Promise((resolve) => setTimeout(resolve, 500)) // simulated re-auth latency (not a sync point)

            const authAtMs = Date.now()
            const viewer2 = suite.client(suite.mintInteractive())
            const snapshot = await viewer2.client.getTask({ taskId })
            const after = new EventLog(taskId)
            for (let cursor = n; cursor < snapshot.highWatermarkSeq;) {
                const page = await viewer2.client.subscribe({ taskId, afterSeq: cursor })
                expect(page.kind, 'in-retention cursor must replay events').toBe('events')
                if (page.kind !== 'events' || page.events.length === 0) break
                after.add(page.events)
                cursor = after.cursor
            }
            const restoreMs = Date.now() - authAtMs

            expect(snapshot.taskId).toBe(taskId)
            expect(snapshot.profileId).toBe(snapshotBefore.profileId)
            expect(snapshot.taskSpaceId).toBe(snapshotBefore.taskSpaceId)
            expect(snapshot.browserInstanceId).toBe(snapshotBefore.browserInstanceId)
            expect(Math.min(...after.bySeq.keys()), 'replay must start right after the cursor').toBe(n + 1)
            after.assertContiguous(n + 1, snapshot.highWatermarkSeq)
            after.assertNoRegression()
            expect(snapshot.stateVersion).toBeGreaterThanOrEqual(snapshotBefore.stateVersion)
            expect(restoreMs, 'state restore after auth must meet the 10 s target').toBeLessThanOrEqual(RESTORE_TARGET_MS)

            // No resubmission: one batch in the whole journal, one ledgered answer.
            const all = new EventLog(taskId)
            const full = await viewer2.client.subscribe({ taskId, afterSeq: 0 })
            if (full.kind === 'events') all.add(full.events)
            expect(all.count('batch-accepted')).toBe(1)
            const ledger = await suite.stack.waitForLedger((entries) => answerEntries(entries, key).length >= 1, { settleMs: 1_000 })
            expect(answerEntries(ledger, key)).toHaveLength(1)

            const finished = await agent.finishTask({ taskId, expectedVersion: snapshot.stateVersion, requestId: rid() })
            expect(finished.status).toBe('succeeded')
            evidence('A03', {
                path: 'replay-after-disconnect', iteration, taskId, cursorN: n, highWatermarkSeq: snapshot.highWatermarkSeq,
                replayed: after.bySeq.size, restoreMs, batchAccepted: all.count('batch-accepted'), ledgerAnswers: 1,
            })
        })
    }, 180_000)

    it.each(repeat(10))('iteration %i: live long-poll across the replay/live boundary, duplicates deduped by seq', async (iteration) => {
        const key = `a03-live-${iteration}`
        await withTask(key, async ({ agent, taskId, tabId, nonce, refs, version }) => {
            const viewer = suite.client(suite.mintInteractive())
            const log = new EventLog(taskId)
            const initial = await viewer.client.subscribe({ taskId, afterSeq: 0 })
            if (initial.kind !== 'events') throw new Error('initial subscribe returned snapshot-required')
            log.add(initial.events)
            const h0 = log.cursor

            let batchDone = false
            let finalHwm = Number.POSITIVE_INFINITY
            let livePolls = 0
            const live = (async () => {
                // Long-poll from the replay boundary; must not miss events committed between polls.
                while (log.cursor < finalHwm) {
                    const page = await viewer.client.subscribe({ taskId, afterSeq: log.cursor }, { waitMs: batchDone ? 1_000 : 3_000 })
                    livePolls += 1
                    if (page.kind !== 'events') throw new Error('live subscribe returned snapshot-required')
                    log.add(page.events)
                    if (batchDone && page.events.length === 0 && log.cursor >= finalHwm) break
                }
            })()
            const submitted = await agent.submitBatch({ taskId, expectedVersion: version, requestId: rid(), steps: answerSteps(tabId, refs, nonce) }, { waitMs: 60_000 })
            expect(submitted.result?.outcome).toBe('succeeded')
            finalHwm = (await agent.getTask({ taskId })).highWatermarkSeq
            batchDone = true
            await live

            // At-least-once delivery: overlapping cursor and a full resend.
            const overlap = await viewer.client.subscribe({ taskId, afterSeq: Math.max(0, h0 - 2) })
            if (overlap.kind === 'events') log.add(overlap.events)
            log.add(initial.events)

            const snapshot = await viewer.client.getTask({ taskId })
            log.assertContiguous(1, snapshot.highWatermarkSeq)
            log.assertNoRegression()
            expect(log.duplicates, 'duplicates were injected and must have been dropped').toBeGreaterThan(0)
            expect(log.bySeq.size).toBe(snapshot.highWatermarkSeq)
            expect(log.count('batch-accepted')).toBe(1)
            const lastStateChange = [...log.bySeq.values()].filter((event) => event.type === 'state-changed' && event.data.status).at(-1)
            expect(lastStateChange?.data.status, 'state shown from events must match the snapshot').toBe(snapshot.status)

            const ledger = await suite.stack.waitForLedger((entries) => answerEntries(entries, key).length >= 1, { settleMs: 1_000 })
            expect(answerEntries(ledger, key)).toHaveLength(1)
            evidence('A03', {
                path: 'live-boundary-dedupe', iteration, taskId, replayBoundarySeq: h0, highWatermarkSeq: snapshot.highWatermarkSeq,
                livePolls, duplicatesDropped: log.duplicates, uniqueEvents: log.bySeq.size,
            })
        })
    }, 180_000)

    it.each(repeat(10))('iteration %i: a cursor outside the retained range yields snapshot-required', async (iteration) => {
        const key = `a03-stale-${iteration}`
        await withTask(key, async ({ taskId }) => {
            const viewer = suite.client(suite.mintInteractive())
            const snapshotTask = await viewer.client.getTask({ taskId })
            // A cursor from a different journal incarnation (ahead of the high
            // watermark) cannot be served as events: accepting it silently would
            // hide seq hwm+1..cursor once they are written.
            const ahead = await viewer.client.subscribe({ taskId, afterSeq: snapshotTask.highWatermarkSeq + 5 })
            evidence('A03', { path: 'stale-cursor-ahead', iteration, taskId, highWatermarkSeq: snapshotTask.highWatermarkSeq, kind: ahead.kind })
            expect(ahead.kind, `cursor ${snapshotTask.highWatermarkSeq + 5} > highWatermarkSeq ${snapshotTask.highWatermarkSeq} must return snapshot-required`).toBe('snapshot-required')
            if (ahead.kind === 'snapshot-required') {
                expect(ahead.snapshot.taskId).toBe(taskId)
                expect(ahead.highWatermarkSeq).toBe(snapshotTask.highWatermarkSeq)
            }
        })
    }, 120_000)

    it('retention-gap cursor (older than retained events) is not reachable on the real stack', () => {
        // TaskStore keeps every event of a task (no pruning); events are only
        // withheld 7 days after a terminal state. Producing a real gap needs a
        // fake clock (unit tests) — recorded here as not implementable in E2E.
        evidence('A03', { path: 'retention-gap', status: 'not-implementable-on-real-stack', reason: 'no event pruning; 7-day terminal retention needs clock control' })
    })
})
