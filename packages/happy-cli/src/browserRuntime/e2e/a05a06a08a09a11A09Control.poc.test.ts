/**
 * A09 — takeover / Stop / late effect (R9). Source: Saydo
 * specs/agent-browser-poc/acceptance.md A09.
 *
 * Hang kinds: `waitFor` (fixture barrier never released until the harness
 * says so) and `slow-nav` (navigation whose response the fixture delays, i.e.
 * the driver call is dispatched but not confirmed). Control ops: Stop
 * (cancel), grant revocation (admin, standing in for the auth server) and
 * user takeover. Every combination runs ABP_REPEAT (default 10) times.
 *
 * In the control matrix Stop is the user's (interactive capability carrying
 * `cancel`); the late-confirmation paths stop through the agent grant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionId, TaskEvent } from '../contracts'
import type { RuntimeClient } from '../runtimeClient'
import {
    admin, allEvents, cleanupSpace, client, count, evidence, expectCode, ledgerRun, mintAgent, mintInteractive,
    newTaskWithPage, observeUntil, pageUrl, range, releaseBarrier, repeat, rid, settledLedger, step, tabLease, waitForTask, waitHealthy, waitUserOwner,
    waitLedger,
} from './a05a06a08a09a11Helpers'
import { SITE_A, startPocStack, type PocStack } from './pocStack'

const N = repeat(10)
const FENCE_ACK_MS = 2_000
const SLOW_MS = 6_000

let stack: PocStack

async function ensureStack(reason?: string): Promise<void> {
    let healthy = !reason
    if (healthy) {
        try { await waitHealthy(stack, 3_000) } catch { healthy = false }
    }
    if (healthy) return
    evidence('A09', { harness: 'stack-recreated', reason: reason ?? 'runtime unhealthy' })
    stack.down({ purge: true })
    stack = await startPocStack()
}

const eventsFor = (events: TaskEvent[], actionId: ActionId) => events.filter((e) => e.data.actionId === actionId)

/** Waits (event cursor) until the given action has an intent record, i.e. the step is in flight. */
async function waitInFlight(ui: RuntimeClient, taskId: Parameters<RuntimeClient['getTask']>[0]['taskId'], actionId: ActionId): Promise<void> {
    const deadline = Date.now() + 20_000
    for (;;) {
        const events = await allEvents(ui, taskId)
        if (eventsFor(events, actionId).some((e) => e.type === 'action-intent')) return
        if (Date.now() > deadline) throw new Error('step never became in-flight')
        await ui.subscribe({ taskId, afterSeq: events.at(-1)?.seq ?? 0 }, { waitMs: 2_000 })
    }
}

describe('A09 takeover / Stop / late effect', () => {
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    for (const hang of ['waitFor', 'slow-nav'] as const) {
        for (const op of ['cancel', 'revoke', 'takeover'] as const) {
            it.each(range(N))(`${op} during ${hang}: fence ACK < 2 s and no agent dispatch after it #%i`, async (i) => {
                await ensureStack()
                const L = ledgerRun(stack, `a09-${op}-${hang}-${i}`)
                const grant = mintAgent(stack)
                const agent = client(stack, grant.token)
                const ui = client(stack, mintInteractive(stack, { operations: ['approve', 'takeOver', 'releaseControl', 'getTask', 'subscribe', 'cancel', 'resume'] }).token)
                const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'P', key: 'gate' }, L))
                // Other Space of the same profile: VNC input is profile-global, so takeover must fence it too.
                const other = op === 'takeover' ? await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'Q' }, L)) : undefined
                let userEpoch: number | undefined
                try {
                    const seen = await agent.observe({ taskId: t.taskId, tabId: t.tabId })
                    const press = seen.elements.find((e) => e.name === 'Press P')!.ref
                    const hangStep = hang === 'waitFor'
                        ? step(t.tabId, 'waitFor', { until: { kind: 'text', text: 'GATE OPEN' }, timeoutMs: 120_000 })
                        : step(t.tabId, 'navigate', { url: pageUrl(stack, SITE_A, '/slow', { ms: String(SLOW_MS) }, L), timeoutMs: 30_000 })
                    const follow = step(t.tabId, 'click', { ref: press, snapshotId: seen.snapshotId })
                    await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [hangStep, follow] })
                    await waitInFlight(ui, t.taskId, hangStep.actionId)

                    const started = Date.now()
                    let fenceMs: number
                    let reported: number | undefined
                    let settling = false
                    if (op === 'cancel') {
                        const res = await ui.cancel({ taskId: t.taskId, requestId: rid() })
                        fenceMs = Date.now() - started
                        reported = res.fenceAckMs
                        expect(res.status).toBe('cancel-accepted')
                    } else if (op === 'revoke') {
                        await admin(stack, '/admin/revoke-grant', { grantId: grant.grantId })
                        fenceMs = Date.now() - started
                    } else {
                        const res = await ui.takeOver({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: (await tabLease(ui, t.taskId, t.tabId)).leaseEpoch, requestId: rid() })
                        fenceMs = Date.now() - started
                        settling = res.settling === true
                        // ACK first; the user owns input only once the in-flight driver call has settled.
                        if (!settling) expect(res.owner.kind).toBe('user')
                    }
                    const fenced = await ui.getTask({ taskId: t.taskId })

                    // Other Space input while the user holds the profile.
                    let otherOutcome: string | undefined
                    if (other) {
                        const otherPress = (await agent.observe({ taskId: other.taskId, tabId: other.tabId })).elements.find((e) => e.name === 'Press Q')!.ref
                        try {
                            const r = await agent.submitBatch({ taskId: other.taskId, expectedVersion: other.version, requestId: rid(), steps: [step(other.tabId, 'click', { ref: otherPress })] }, { waitMs: 15_000 })
                            otherOutcome = r.result?.outcome ?? 'pending'
                        } catch (error) {
                            otherOutcome = `rejected:${(error as { code?: string }).code}`
                        }
                    }

                    let settleMs: number | undefined
                    if (op === 'takeover') {
                        const owned = await waitUserOwner(ui, t.taskId, t.tabId)
                        userEpoch = owned.leaseEpoch
                        settleMs = owned.waitedMs
                    }
                    // Let the original wait / driver call finish late.
                    if (hang === 'waitFor') await releaseBarrier(stack, L, 'gate', `n${i}`)
                    const reader = op === 'revoke' ? client(stack, mintAgent(stack, { agentSessionId: fenced.agentSessionId }).token) : agent
                    await observeUntil(reader, t.taskId, t.tabId, (o) => hang === 'waitFor' ? o.text.includes('GATE OPEN') : o.text.includes('SLOW DONE'), 20_000).catch(() => undefined)
                    const ledger = await settledLedger(stack, L, 1_500)
                    const events = await allEvents(ui, t.taskId)
                    const after = await ui.getTask({ taskId: t.taskId })
                    evidence('A09', { path: `${op}-${hang}`, i, fenceMs, reportedFenceAckMs: reported, settling, settleMs, statusAtAck: `${fenced.status}/${fenced.pauseReason ?? ''}`, final: `${after.status}/${after.pauseReason ?? ''}`, followIntents: eventsFor(events, follow.actionId).length, pressesP: count(ledger, 'click', { target: 'P' }), otherOutcome, pressesQ: count(ledger, 'click', { target: 'Q' }), uncertain: after.uncertainActions.length, transitions: events.filter((e) => ['state-changed', 'input-owner-changed', 'late-result', 'action-failed', 'action-uncertain', 'cancel-accepted'].includes(e.type)).map((e) => `${e.seq}:${e.type}:${String(e.data.pauseReason ?? e.data.status ?? e.data.owner ?? e.data.batchOutcome ?? '')}`) })
                    expect(fenceMs, 'fence ACK must not wait for the hung wait/driver call').toBeLessThan(FENCE_ACK_MS)
                    expect(eventsFor(events, follow.actionId), 'no follow-up step may start after the fence').toHaveLength(0)
                    expect(count(ledger, 'click', { target: 'P' })).toBe(0)
                    expect(after.status).not.toBe('running')
                    if (op === 'cancel') expect(fenced.cancelRequested).toBe(true)
                    if (op === 'revoke') expect(after.pauseReason).toBe('grant-expired')
                    if (op === 'takeover') {
                        expect(after.pauseReason, 'CONTRACT: the aborted batch must not overwrite user-control once the late wait/driver result arrives').toBe('user-control')
                        expect(count(ledger, 'click', { target: 'Q' }), 'profile-wide user fence: other Space input must not dispatch').toBe(0)
                    }
                    if (hang === 'slow-nav') expect(after.uncertainActions, 'the in-flight navigation must be reported uncertain, not succeeded').toContain(hangStep.actionId)
                } finally {
                    if (userEpoch !== undefined) await ui.releaseControl({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: userEpoch, requestId: rid() }).catch(() => undefined)
                    const cleaner = op === 'revoke' ? client(stack, mintAgent(stack, { agentSessionId: (await ui.getTask({ taskId: t.taskId })).agentSessionId }).token) : agent
                    const leak = (await cleanupSpace(stack, cleaner, t.taskSpaceId, [t.taskId])) ?? (other ? await cleanupSpace(stack, agent, other.taskSpaceId, [other.taskId]) : undefined)
                    if (leak) await ensureStack(`cleanup failed: ${leak}`)
                    expect(leak).toBeUndefined()
                }
            }, 90_000)
        }
    }

    it.each(range(N))('after release the agent re-observes and must resume explicitly #%i', async (i) => {
        await ensureStack()
        const L = ledgerRun(stack, `a09-release-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const ui = client(stack, mintInteractive(stack).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'R' }, L))
        try {
            const taken = await ui.takeOver({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: (await tabLease(ui, t.taskId, t.tabId)).leaseEpoch, requestId: rid() })
            expect(taken.settling ?? false, 'idle tab: nothing in flight, owner changes immediately').toBe(false)
            await expectCode(agent.submitBatch({ taskId: t.taskId, expectedVersion: taken.task.stateVersion, requestId: rid(), steps: [step(t.tabId, 'observe')] }), 'CONFLICT', 'agent batch during user control')
            await expectCode(agent.resume({ taskId: t.taskId, expectedVersion: taken.task.stateVersion, requestId: rid() }), 'CONFLICT', 'agent resume during user control')
            const released = await ui.releaseControl({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: taken.leaseEpoch, requestId: rid() })
            expect(released.leaseEpoch).toBeGreaterThan(taken.leaseEpoch)
            expect(released.task.pauseReason).toBe('user-input-complete')
            const idle = await settledLedger(stack, L, 1_000)
            expect((await ui.getTask({ taskId: t.taskId })).pauseReason, 'release must not auto-resume').toBe('user-input-complete')
            const resumed = await agent.resume({ taskId: t.taskId, expectedVersion: released.task.stateVersion, requestId: rid() })
            expect(resumed.pauseReason).toBe('awaiting-agent')
            const press = (await agent.observe({ taskId: t.taskId, tabId: t.tabId })).elements.find((e) => e.name === 'Press R')!.ref
            const r = await agent.submitBatch({ taskId: t.taskId, expectedVersion: resumed.stateVersion, requestId: rid(), steps: [step(t.tabId, 'click', { ref: press })] }, { waitMs: 30_000 })
            const ledger = await waitLedger(stack, L, (e) => count(e, 'click') >= 1, { settleMs: 1_000 })
            evidence('A09', { path: 'release-resume', i, takeEpoch: taken.leaseEpoch, releaseEpoch: released.leaseEpoch, pressesWhileReleased: count(idle, 'click'), outcome: r.result?.outcome, presses: count(ledger, 'click') })
            expect(count(idle, 'click')).toBe(0)
            expect(r.result?.outcome).toBe('succeeded')
            expect(count(ledger, 'click')).toBe(1)
        } finally {
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('a viewer can take over an idle task with the lease epoch it can observe #%i', async (i) => {
        await ensureStack()
        const agent = client(stack, mintAgent(stack).token)
        const ui = client(stack, mintInteractive(stack).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'E' }, ledgerRun(stack, `a09-epoch-${i}`)))
        let userEpoch: number | undefined
        try {
            const observed = (await tabLease(ui, t.taskId, t.tabId)).leaseEpoch
            let outcome: string
            try {
                userEpoch = (await ui.takeOver({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: observed, requestId: rid() })).leaseEpoch
                outcome = 'taken'
            } catch (error) {
                outcome = `rejected:${(error as { code?: string }).code}`
            }
            evidence('A09', { path: 'idle-epoch-visibility', i, observedEpoch: observed, outcome })
            expect(outcome, 'CONTRACT: takeOver with the epoch exposed by TaskView.tabLeases must succeed for an idle tab').toBe('taken')
        } finally {
            if (userEpoch !== undefined) await ui.releaseControl({ taskId: t.taskId, tabId: t.tabId, expectedEpoch: userEpoch, requestId: rid() }).catch(() => undefined)
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    })

    it.each(range(N))('Stop on an uncertain action: late confirmation runs no follow-up and the cancelled task refuses every restart path #%i', async (i) => {
        await ensureStack()
        const L = ledgerRun(stack, `a09-late-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const ui = client(stack, mintInteractive(stack).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'L' }, L))
        try {
            const press = (await agent.observe({ taskId: t.taskId, tabId: t.tabId })).elements.find((e) => e.name === 'Press L')!.ref
            const nav = step(t.tabId, 'navigate', { url: pageUrl(stack, SITE_A, '/slow', { ms: String(SLOW_MS) }, L), timeoutMs: 30_000 })
            const follow = step(t.tabId, 'click', { ref: press })
            await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [nav, follow] })
            await waitInFlight(ui, t.taskId, nav.actionId)
            const started = Date.now()
            const cancelled = await agent.cancel({ taskId: t.taskId, requestId: rid() })
            const ackMs = Date.now() - started
            await observeUntil(agent, t.taskId, t.tabId, (o) => o.text.includes('SLOW DONE'), 20_000).catch(() => undefined)
            const paused = await ui.getTask({ taskId: t.taskId })
            expect(paused.cancelRequested).toBe(true)
            expect(paused.status).toBe('paused')
            expect(paused.pauseReason).toBe('cancelled-with-unknown-effect')
            // Late, trusted confirmation of the uncertain navigation.
            const confirmed = await admin<{ status: string }>(stack, '/admin/reconcile-action', { taskId: t.taskId, actionId: nav.actionId, confirmed: true })
            const ledger = await settledLedger(stack, L, 1_500)
            const events = await allEvents(ui, t.taskId)
            const final = await ui.getTask({ taskId: t.taskId })
            const codes: string[] = []
            for (const [label, p] of [
                ['resume', agent.resume({ taskId: t.taskId, expectedVersion: final.stateVersion, requestId: rid() })],
                ['submitBatch', agent.submitBatch({ taskId: t.taskId, expectedVersion: final.stateVersion, requestId: rid(), steps: [step(t.tabId, 'click', { ref: press })] })],
                ['openPage', agent.openPage({ taskId: t.taskId, url: pageUrl(stack, SITE_A, '/x5/panel', { label: 'L' }, L), requestId: rid() })],
                ['finishTask', agent.finishTask({ taskId: t.taskId, expectedVersion: final.stateVersion, requestId: rid() })],
                ['approve', ui.approve({ taskId: t.taskId, approvalId: 'approval-none' as never, bindingHash: 'x', requestId: rid(), decision: 'approve' })],
                ['newGrant-resume', client(stack, mintAgent(stack, { agentSessionId: final.agentSessionId }).token).resume({ taskId: t.taskId, expectedVersion: final.stateVersion, requestId: rid() })],
            ] as const) codes.push(`${label}:${(await expectCode(p, ['CONFLICT', 'APPROVAL_EXPIRED', 'SCOPE_DENIED'], label)).code}`)
            const afterAttempts = await settledLedger(stack, L, 1_000)
            evidence('A09', { path: 'late-confirmation', i, ackMs, reportedFenceAckMs: cancelled.fenceAckMs, pausedAs: paused.pauseReason, afterConfirm: confirmed.status, final: final.status, followIntents: eventsFor(events, follow.actionId).length, presses: count(afterAttempts, 'click'), refused: codes })
            expect(ackMs).toBeLessThan(FENCE_ACK_MS)
            expect(final.status).toBe('cancelled')
            expect(eventsFor(events, follow.actionId)).toHaveLength(0)
            expect(count(ledger, 'click')).toBe(0)
            expect(count(afterAttempts, 'click')).toBe(0)
            expect((await ui.getTask({ taskId: t.taskId })).status).toBe('cancelled')
        } finally {
            expect(await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])).toBeUndefined()
        }
    }, 60_000)

    it.each(range(N))('Stop → cancel-accepted → Runtime restart → late confirmation: cancel survives, no follow-up, space closable #%i', async (i) => {
        await ensureStack()
        const L = ledgerRun(stack, `a09-restart-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const ui = client(stack, mintInteractive(stack).token)
        const t = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'M' }, L))
        let leak: string | undefined
        try {
            const press = (await agent.observe({ taskId: t.taskId, tabId: t.tabId })).elements.find((e) => e.name === 'Press M')!.ref
            const nav = step(t.tabId, 'navigate', { url: pageUrl(stack, SITE_A, '/slow', { ms: String(SLOW_MS) }, L), timeoutMs: 30_000 })
            const follow = step(t.tabId, 'click', { ref: press })
            await agent.submitBatch({ taskId: t.taskId, expectedVersion: t.version, requestId: rid(), steps: [nav, follow] })
            await waitInFlight(ui, t.taskId, nav.actionId)
            await agent.cancel({ taskId: t.taskId, requestId: rid() })
            // Graceful restart (kill+start is blocked by the stale writer lock, reported under A08).
            stack.fault('restart-runtime')
            await waitHealthy(stack)
            const restarted = await ui.getTask({ taskId: t.taskId })
            expect(restarted.cancelRequested, 'cancelRequested must survive restart').toBe(true)
            expect(restarted.status).not.toBe('running')
            await admin(stack, '/admin/reconcile-action', { taskId: t.taskId, actionId: nav.actionId, confirmed: true })
            const final = await ui.getTask({ taskId: t.taskId })
            const ledger = await settledLedger(stack, L, 1_500)
            const events = await allEvents(ui, t.taskId)
            await expectCode(agent.resume({ taskId: t.taskId, expectedVersion: final.stateVersion, requestId: rid() }), 'CONFLICT', 'resume after restart')
            leak = await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId])
            evidence('A09', { path: 'cancel-restart-late-confirmation', i, afterRestart: `${restarted.status}/${restarted.pauseReason ?? ''}`, final: final.status, followIntents: eventsFor(events, follow.actionId).length, presses: count(ledger, 'click'), closeSpace: leak ?? 'ok' })
            expect(final.status).toBe('cancelled')
            expect(eventsFor(events, follow.actionId)).toHaveLength(0)
            expect(count(ledger, 'click')).toBe(0)
            expect(leak, 'CONTRACT: the cancelled task\'s space must be closable after a Runtime restart').toBeUndefined()
        } finally {
            if (leak === undefined) leak = await cleanupSpace(stack, agent, t.taskSpaceId, [t.taskId]).catch((e: Error) => e.message)
            if (leak) await ensureStack(`cleanup failed: ${leak}`)
        }
    }, 180_000)

    it.each(range(N))('closeSpace is refused while a paused / awaiting-user / uncertain task remains #%i', async (i) => {
        await ensureStack()
        const L = ledgerRun(stack, `a09-close-${i}`)
        const agent = client(stack, mintAgent(stack).token)
        const ui = client(stack, mintInteractive(stack).token)
        const paused = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'C' }, L))
        const S = paused.taskSpaceId
        const ids = [paused.taskId]
        try {
            const codes: string[] = []
            codes.push(`paused:${(await expectCode(agent.closeSpace({ taskSpaceId: S, requestId: rid() }), 'CONFLICT', 'closeSpace with paused task')).code}`)
            const risky = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/risky-submit', {}, L), { taskSpaceId: S })
            ids.push(risky.taskId)
            const confirm = (await agent.observe({ taskId: risky.taskId, tabId: risky.tabId })).elements.find((e) => e.name === 'Confirm payment')!.ref
            const pending = await agent.submitBatch({ taskId: risky.taskId, expectedVersion: risky.version, requestId: rid(), steps: [step(risky.tabId, 'click', { ref: confirm })] }, { waitMs: 30_000 })
            expect(pending.result?.outcome).toBe('awaiting-user')
            await agent.cancel({ taskId: paused.taskId, requestId: rid() })
            codes.push(`awaiting-user:${(await expectCode(agent.closeSpace({ taskSpaceId: S, requestId: rid() }), 'CONFLICT', 'closeSpace with awaiting-user task')).code}`)
            await agent.cancel({ taskId: risky.taskId, requestId: rid() })
            const unsure = await newTaskWithPage(agent, pageUrl(stack, SITE_A, '/x5/panel', { label: 'U' }, L), { taskSpaceId: S })
            ids.push(unsure.taskId)
            const nav = step(unsure.tabId, 'navigate', { url: pageUrl(stack, SITE_A, '/slow', { ms: String(SLOW_MS) }, L), timeoutMs: 30_000 })
            await agent.submitBatch({ taskId: unsure.taskId, expectedVersion: unsure.version, requestId: rid(), steps: [nav] })
            await waitInFlight(ui, unsure.taskId, nav.actionId)
            await agent.cancel({ taskId: unsure.taskId, requestId: rid() })
            const u = await waitForTask(ui, unsure.taskId, (x) => x.status !== 'running')
            expect(u.pauseReason).toBe('cancelled-with-unknown-effect')
            codes.push(`uncertain:${(await expectCode(agent.closeSpace({ taskSpaceId: S, requestId: rid() }), 'CONFLICT', 'closeSpace with uncertain task')).code}`)
            evidence('A09', { path: 'closeSpace-refused', i, codes })
        } finally {
            expect(await cleanupSpace(stack, agent, S, ids)).toBeUndefined()
        }
    }, 60_000)
})
