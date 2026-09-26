/**
 * A08 — approval while no client is attached (R8). Source: Saydo
 * specs/agent-browser-poc/acceptance.md A08.
 *
 * The harness plays both the agent (agent grant) and the user UI
 * (interactive capability). "No client" = nothing but the agent is talking
 * to the Runtime when the risky submit is reached. Risky writes are counted
 * from the fixture ledger (`risky` entries), namespaced per iteration.
 *
 * Expiry uses the Runtime's real userWaitMs (10 min, not configurable in the
 * container), so that path only runs with ABP_A08_EXPIRY=1 (1 iteration by
 * default, ABP_REPEAT overrides). The kill+start restart variant defaults to
 * 3 iterations (each failing iteration currently exceeds 60 s).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BatchResult, PendingApprovalSummary, ProfileId, TaskView } from '../contracts'
import type { RuntimeClient } from '../runtimeClient'
import {
    admin, allEvents, cleanupSpace, client, count, evidence, expectCode, ledgerRun, mintAgent, mintInteractive, newTaskWithPage,
    observeUntil, pageUrl, range, releaseBarrier, repeat, restartRuntime, rid, settledLedger, step, waitForTask, waitHealthy,
    waitLedger, type OpenedTask,
} from './a05a06a08a09a11Helpers'
import { PRINCIPAL_B, PROFILE_A, PROFILE_B, SITE_A, SITE_B, startPocStack, type PocStack } from './pocStack'

const N = repeat(10)
const SETTLE_MS = 1_500

let stack: PocStack

/** Recreate the stack if a previous iteration left it unusable (dead Runtime / leaked quota). */
/** Fixture pages poll their barrier every 500 ms; give the mutation several polls. */
const MUTATION_SETTLE_MS = 3_000

async function ensureStack(reason?: string): Promise<void> {
    let healthy = !reason
    if (healthy) {
        try { await waitHealthy(stack, 3_000) } catch { healthy = false }
    }
    if (healthy) return
    evidence('A08', { harness: 'stack-recreated', reason: reason ?? 'runtime unhealthy' })
    stack.down({ purge: true })
    stack = await startPocStack()
}

interface Reached {
    t: OpenedTask
    agent: RuntimeClient
    ui: RuntimeClient
    L: string
    approval: PendingApprovalSummary
    batch: BatchResult
    toolReturnMs: number
    grantId: string
}

/** Agent (no client attached) drives a task to the risky submit. */
async function reachApproval(label: string, options: { path?: string; params?: Record<string, string>; profileId?: ProfileId } = {}): Promise<Reached> {
    const L = ledgerRun(stack, label)
    const grant = mintAgent(stack, { profileId: options.profileId ?? PROFILE_A })
    const agent = client(stack, grant.token)
    const ui = client(stack, mintInteractive(stack, { profileId: options.profileId ?? PROFILE_A }).token)
    const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, options.path ?? '/x5/risky-mutating', options.params ?? {}, L), { profileId: options.profileId })
    const o = await agent.observe({ taskId: t.taskId, tabId: t.tabId })
    const confirm = o.elements.find((e) => e.name === 'Confirm payment')!
    const started = Date.now()
    // A submit is only confirmed by an explicit postcondition step (the page shows PAYMENT SENT once the write is acknowledged).
    const submitted = await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [
        step(t.tabId, 'click', { ref: confirm.ref, snapshotId: o.snapshotId }),
        step(t.tabId, 'waitFor', { until: { kind: 'text', text: 'PAYMENT SENT' }, timeoutMs: 15_000 }),
    ] }, { waitMs: 60_000 })
    const toolReturnMs = Date.now() - started
    expect(submitted.result?.outcome, 'the tool call must return awaiting-user instead of blocking').toBe('awaiting-user')
    expect(submitted.result?.waitReason).toBe('approval')
    expect(submitted.result?.pendingApproval).toBeDefined()
    return { t, agent, ui, L, approval: submitted.result!.pendingApproval!, batch: submitted.result!, toolReturnMs, grantId: grant.grantId }
}

async function approve(r: Reached, via: RuntimeClient = r.ui, overrides: { bindingHash?: string; decision?: 'approve' | 'reject'; requestId?: string } = {}) {
    return via.approve({
        taskId: r.t.taskId,
        approvalId: r.approval.approvalId,
        bindingHash: overrides.bindingHash ?? r.approval.bindingHash,
        requestId: (overrides.requestId ?? rid()) as never,
        decision: overrides.decision ?? 'approve',
    })
}

async function riskyWrites(L: string): Promise<number> {
    return count(await settledLedger(stack, L, SETTLE_MS), 'risky')
}

describe('A08 approval without a client', () => {
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it.each(range(N))('pending approval is durable, 1 write after approve, agent attention + finish, duplicates dispatch nothing #%i', async (i) => {
        const r = await reachApproval(`a08-happy-${i}`)
        try {
            const view = await r.ui.getTask({ taskId: r.t.taskId })
            expect(view.status).toBe('awaiting-user')
            expect(view.waitReason).toBe('approval')
            expect(view.pendingApproval?.approvalId).toBe(r.approval.approvalId)
            const requested = (await allEvents(r.ui, r.t.taskId)).filter((e) => e.type === 'approval-requested')
            expect(requested).toHaveLength(1)
            expect(await riskyWrites(r.L), 'no risky write before approval').toBe(0)

            const approved = await approve(r)
            expect(approved.outcome).toBe('approved')
            expect(approved.batch?.outcome).toBe('succeeded')
            let ledger = await waitLedger(stack, r.L, (e) => count(e, 'risky') >= 1, { settleMs: SETTLE_MS })
            expect(count(ledger, 'risky'), 'exactly one risky write after approval').toBe(1)

            const paused = await waitForTask(r.ui, r.t.taskId, (t) => t.status === 'paused')
            expect(paused.pauseReason).toBe('awaiting-agent')
            const events = await allEvents(r.ui, r.t.taskId)
            const consumed = events.find((e) => e.type === 'approval-consumed')
            const attention = events.filter((e) => e.type === 'agent-attention-required')
            expect(consumed).toBeDefined()
            expect(attention, 'agent-attention-required must be recorded once').toHaveLength(1)
            expect(attention[0].seq).toBeGreaterThan(consumed!.seq)

            // Duplicate approve (new requestId) and replayed approve (same requestId).
            const replayId = rid()
            const dup1 = await approve(r, r.ui, { requestId: replayId })
            const dup2 = await approve(r, r.ui, { requestId: replayId })
            expect(dup1.outcome).toBe('approved')
            expect(dup2.outcome).toBe('approved')

            // Harness plays the agent woken by the follow-up message (delivered twice).
            const seen = await r.agent.getTask({ taskId: r.t.taskId })
            const finished = await r.agent.finishTask({ taskId: r.t.taskId, expectedVersion: seen.stateVersion, requestId: rid() })
            expect(finished.status).toBe('succeeded')
            const again = await r.agent.getTask({ taskId: r.t.taskId })
            await expectCode(r.agent.finishTask({ taskId: r.t.taskId, expectedVersion: seen.stateVersion, requestId: rid() }), 'CONFLICT', 'second follow-up finish')
            await expectCode(r.agent.submitBatch({ taskId: r.t.taskId, expectedVersion: again.stateVersion, requestId: rid(), steps: [step(r.t.tabId, 'observe')] }), 'CONFLICT', 'second follow-up batch')
            ledger = await settledLedger(stack, r.L, SETTLE_MS)
            evidence('A08', { path: 'approve-once', i, toolReturnMs: r.toolReturnMs, approvalId: r.approval.approvalId, riskyWrites: count(ledger, 'risky'), attentionSeq: attention[0].seq, consumedSeq: consumed!.seq, finalStatus: finished.status, duplicateApprove: [dup1.outcome, dup2.outcome] })
            expect(count(ledger, 'risky'), 'duplicates must not dispatch again').toBe(1)
        } finally {
            expect(await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('other principal, agent grant and tampered bindingHash cannot approve; the real user still can (1 write) #%i', async (i) => {
        const r = await reachApproval(`a08-forged-${i}`)
        try {
            const other = client(stack, mintInteractive(stack, { principalId: PRINCIPAL_B }).token)
            const codes = [
                (await expectCode(approve(r, other), 'SCOPE_DENIED', 'principal B approve')).code,
                (await expectCode(approve(r, r.agent), 'SCOPE_DENIED', 'agent grant approve')).code,
                (await expectCode(approve(r, r.ui, { bindingHash: `${r.approval.bindingHash.slice(0, -4)}0000` }), ['APPROVAL_EXPIRED', 'CONFLICT', 'SCOPE_DENIED'], 'tampered binding')).code,
            ]
            expect(await riskyWrites(r.L)).toBe(0)
            const still = await r.ui.getTask({ taskId: r.t.taskId })
            expect(still.status).toBe('awaiting-user')
            const ok = await approve(r)
            expect(ok.outcome).toBe('approved')
            const ledger = await waitLedger(stack, r.L, (e) => count(e, 'risky') >= 1, { settleMs: SETTLE_MS })
            evidence('A08', { path: 'forged-approvals', i, codes, riskyWrites: count(ledger, 'risky') })
            expect(count(ledger, 'risky')).toBe(1)
        } finally {
            expect(await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId])).toBeUndefined()
        }
    })

    for (const mode of ['reload', 'origin', 'value', 'node'] as const) {
        it.each(range(N))(`changed ${mode} after the approval request: old approval executes nothing #%i`, async (i) => {
            const r = await reachApproval(`a08-${mode}-${i}`, { path: '/x5/risky-mutating', params: { key: 'mut', mode } })
            try {
                // While the approval is pending the agent may not observe the bound tab (it would
                // supersede the snapshot the approval is bound to).
                await expectCode(r.agent.observe({ taskId: r.t.taskId, tabId: r.t.tabId }), ['CONFLICT'], 'agent observe of an approval-bound tab')
                await releaseBarrier(stack, r.L, 'mut', `n${i}`)
                // The page applies the change on its next barrier poll (every 500 ms). A late change
                // can only make approve succeed and fail this test, never pass it falsely.
                await new Promise((resolve) => setTimeout(resolve, MUTATION_SETTLE_MS))
                let outcome: string
                try {
                    const result = await approve(r)
                    outcome = `resolved:${result.outcome}/${result.batch?.outcome ?? ''}`
                } catch (error) {
                    outcome = `rejected:${(error as { code?: string }).code}`
                }
                const ledger = await settledLedger(stack, r.L, SETTLE_MS)
                evidence('A08', { path: `changed-${mode}`, i, outcome, riskyWrites: count(ledger, 'risky'), amounts: ledger.filter((e) => e.kind === 'risky').map((e) => e.amount) })
                expect(count(ledger, 'risky'), `CONTRACT: approval bound to the old ${mode} must not execute`).toBe(0)
                expect(outcome.startsWith('rejected:'), `CONTRACT: approve must be refused after ${mode} change, got ${outcome}`).toBe(true)
            } finally {
                const leak = await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId])
                if (leak) console.log(`[cleanup-leak] changed-${mode} #${i}: ${leak}`)
                expect(leak).toBeUndefined()
            }
        })
    }

    it.each(range(N))('revoked execution grant: a still-valid approval executes nothing #%i', async (i) => {
        const r = await reachApproval(`a08-revoked-${i}`)
        try {
            await admin(stack, '/admin/revoke-grant', { grantId: r.grantId })
            const code = (await expectCode(approve(r), ['UNAUTHORIZED', 'APPROVAL_EXPIRED', 'SCOPE_DENIED'], 'approve after grant revocation')).code
            const task = await waitForTask(r.ui, r.t.taskId, (t) => t.status === 'paused')
            const writes = await riskyWrites(r.L)
            evidence('A08', { path: 'grant-revoked', i, code, status: task.status, pause: task.pauseReason, riskyWrites: writes })
            expect(writes).toBe(0)
            expect(task.pauseReason).toBe('grant-expired')
        } finally {
            // The revoked grant can no longer call the Runtime; the auth server re-issues one for the same agent session.
            const again = client(stack, mintAgent(stack, { agentSessionId: (await r.ui.getTask({ taskId: r.t.taskId })).agentSessionId }).token)
            expect(await cleanupSpace(stack, again, r.t.taskSpaceId, [r.t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('browser instance replaced (kill-chrome): old approval executes nothing #%i', async (i) => {
        const r = await reachApproval(`a08-browser-${i}`)
        try {
            stack.fault('kill-chrome', 'a')
            const task = await waitForTask(r.ui, r.t.taskId, (t) => t.status === 'paused' && t.pauseReason === 'browser-replaced', 60_000)
            await waitHealthy(stack)
            const code = (await expectCode(approve(r), ['APPROVAL_EXPIRED', 'TARGET_GONE', 'CONFLICT'], 'approve after browser replacement')).code
            const writes = await riskyWrites(r.L)
            evidence('A08', { path: 'browser-replaced', i, code, pause: task.pauseReason, pending: !!task.pendingApproval, riskyWrites: writes })
            expect(writes).toBe(0)
            expect(task.pendingApproval).toBeUndefined()
        } finally {
            expect(await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId])).toBeUndefined()
        }
    }, 120_000)

    it.each(range(process.env.ABP_A08_EXPIRY === '1' ? repeat(1) : 0))('approval expiry (real 10 min userWaitMs): paused, 0 writes, resume needs a fresh approval #%i', async (i) => {
        const r = await reachApproval(`a08-expiry-${i}`)
        try {
            const expired = await waitForTask(r.ui, r.t.taskId, (t) => t.status === 'paused', r.approval.expiresAtMs - Date.now() + 30_000)
            expect(expired.pauseReason).toBe('approval-expired')
            await expectCode(approve(r), 'APPROVAL_EXPIRED', 'approve after expiry')
            const current = () => r.agent.getTask({ taskId: r.t.taskId }).then((x) => x.stateVersion)
            await expectCode(r.agent.submitBatch({ taskId: r.t.taskId, expectedVersion: await current(), requestId: rid(), steps: [step(r.t.tabId, 'observe')] }), 'CONFLICT', 'batch after expiry')
            await expectCode(r.agent.openPage({ taskId: r.t.taskId, url: pageUrl(stack, SITE_A, '/marker'), requestId: rid() }), 'CONFLICT', 'openPage after expiry')
            const resumed = await r.agent.resume({ taskId: r.t.taskId, expectedVersion: await current(), requestId: rid() })
            const writes = await riskyWrites(r.L)
            evidence('A08', { path: 'expiry', i, pause: expired.pauseReason, resumedStatus: resumed.status, newApproval: resumed.pendingApproval?.approvalId !== r.approval.approvalId, riskyWrites: writes })
            expect(writes, 'expired approval must never execute').toBe(0)
            expect(resumed.status).toBe('awaiting-user')
            expect(resumed.pendingApproval?.approvalId).not.toBe(r.approval.approvalId)
        } finally {
            expect(await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId])).toBeUndefined()
        }
    }, 15 * 60_000)

    it.each(range(N))('reject cancels the task with 0 writes and a later approve is refused #%i', async (i) => {
        // Profile B so a quota leak here cannot starve the profile A paths.
        const r = await reachApproval(`a08-reject-${i}`, { profileId: PROFILE_B })
        try {
            const rejected = await approve(r, r.ui, { decision: 'reject' })
            expect(rejected.outcome).toBe('rejected')
            expect(rejected.task.status).toBe('cancelled')
            await expectCode(approve(r), 'APPROVAL_EXPIRED', 'approve after reject')
            const writes = await riskyWrites(r.L)
            evidence('A08', { path: 'reject', i, status: rejected.task.status, riskyWrites: writes })
            expect(writes).toBe(0)
        } finally {
            const leak = await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId])
            if (leak) await ensureStack(`reject cleanup failed: ${leak}`)
            expect(leak, 'CONTRACT: the space of a rejected (cancelled) task must be closable').toBeUndefined()
        }
    })

    // kill+start currently never comes back (stale writer lock) and each failing iteration costs
    // ~95 s (60 s health wait + stack re-creation), so that variant defaults to 3 iterations.
    for (const kind of ['restart-runtime', 'kill-runtime'] as const) {
        it.each(range(kind === 'kill-runtime' ? repeat(3) : N))(`Runtime ${kind === 'kill-runtime' ? 'kill+start' : 'graceful restart'} keeps the pending approval; approve then writes once #%i`, async (i) => {
            await ensureStack()
            const r = await reachApproval(`a08-${kind}-${i}`)
            let leak: string | undefined
            try {
                expect(await riskyWrites(r.L)).toBe(0)
                const startedAt = Date.now()
                if (kind === 'kill-runtime') await restartRuntime(stack)
                else {
                    stack.fault('restart-runtime')
                    await waitHealthy(stack)
                }
                const restartMs = Date.now() - startedAt
                const ui = r.ui
                const after: TaskView = await ui.getTask({ taskId: r.t.taskId })
                expect(after.status, 'pending approval must survive the Runtime restart').toBe('awaiting-user')
                expect(after.pendingApproval?.approvalId).toBe(r.approval.approvalId)
                expect(await riskyWrites(r.L), 'restart must not dispatch the pending action').toBe(0)
                let outcome: string
                try {
                    const res = await approve(r)
                    outcome = `${res.outcome}/${res.batch?.outcome ?? ''}`
                } catch (error) {
                    outcome = `rejected:${(error as { code?: string }).code}`
                }
                const ledger = await waitLedger(stack, r.L, (e) => count(e, 'risky') >= 1, { timeoutMs: 5_000, settleMs: SETTLE_MS })
                evidence('A08', { path: kind, i, restartMs, statusAfterRestart: after.status, approveOutcome: outcome, riskyWrites: count(ledger, 'risky') })
                expect(outcome, 'CONTRACT: the surviving approval must be usable once after restart').toBe('approved/succeeded')
                expect(count(ledger, 'risky')).toBe(1)
            } finally {
                leak = await cleanupSpace(stack, r.agent, r.t.taskSpaceId, [r.t.taskId]).catch((e: Error) => e.message)
                if (leak) await ensureStack(`${kind} cleanup failed: ${leak}`)
            }
            expect(leak, 'space must be closable after restart').toBeUndefined()
        }, 180_000)
    }
})
