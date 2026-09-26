/**
 * A08 real-agent path: the agent reaches an approval-required fixture action
 * with no client connected, the approval is persisted and the agent's turn
 * ends; the user reconnects and approves; the client that handled the event
 * wakes the owning agent session with a message carrying only
 * taskId/status/eventSeq; the agent finishes the SAME task. A duplicate
 * wake-up message must not cause another dispatch.
 *
 * Usage: tsx src/browserRuntime/e2e/realAgentA08.ts --run <stackRun> --iteration <n>
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskEvent, TaskId } from '../contracts'
import {
    clientProcessCount, evidenceFile, ledger, loadRun, now, parseArgs, sessionClient, sleep, spawnAgentSession,
    userClient, userTexts, waitForTranscript, prodIdentity,
} from './realAgentHarness'

const PROMPT_TEMPLATE = readFileSync(join(import.meta.dirname, 'realAgentA08.prompt.txt'), 'utf8')

/** Same text the Desktop helper buildAgentAttentionFollowUp produces: ids and status only, never page text. */
function followUp(taskId: string, status: string, eventSeq: number): string {
    return `[agent-browser] task ${taskId} status=${status} eventSeq=${eventSeq}. Call getTask for the current state before continuing.`
}

const riskyCount = async (ctx: ReturnType<typeof loadRun>) => (await ledger(ctx)).filter((entry) => entry.kind === 'risky').length

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const ctx = loadRun(args.run)
    const iteration = args.iteration ?? '1'
    const { data: evidence, save } = evidenceFile(join(ctx.runDir, `a08-real-${iteration}.json`))
    evidence.run = ctx.run
    evidence.iteration = iteration
    evidence.promptTemplateSha256 = createHash('sha256').update(PROMPT_TEMPLATE).digest('hex')
    const riskyBefore = await riskyCount(ctx)

    const { sessionId } = await spawnAgentSession(ctx, `a08-${iteration}`)
    evidence.agentSessionId = sessionId
    save()

    // 1. The client sends the task and exits; the agent runs alone until it hits the approval gate.
    await sessionClient('send', sessionId, PROMPT_TEMPLATE.replace('__PROFILE__', prodIdentity?.profileId ?? 'profile-a').replace('__RUN__', ctx.run))
    evidence.clientExitedAtMs = now()
    evidence.clientProcessesAfterExit = await clientProcessCount()
    let rows = await waitForTranscript(sessionId, (list) => list.some((row) => row.t === 'text' && row.text?.includes('A08-WAITING')), 300_000)
    const waiting = rows.find((row) => row.t === 'text' && row.text?.includes('A08-WAITING'))
    const taskId = /taskId=(\S+)/.exec(waiting?.text ?? '')?.[1] as TaskId | undefined
    evidence.agentStoppedAtApproval = Boolean(waiting)
    evidence.taskId = taskId
    save()
    if (!taskId) throw new Error('agent did not stop at the approval gate')
    await waitForTranscript(sessionId, (list) => list.some((row) => row.t === 'turn-end' && row.time >= (waiting?.time ?? 0)), 60_000)

    // 2. While nobody is connected: the approval is durable and nothing was sent.
    // A fresh capability per call: server capabilities live 5 minutes and this run can outlast one.
    const user = new Proxy({} as ReturnType<typeof userClient>, { get: (_target, key) => { const client = userClient(ctx, `viewer-a08-${iteration}`) as never; const value = (client as Record<string | symbol, unknown>)[key]; return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value } })
    const pending = await user.getTask({ taskId })
    evidence.beforeApproval = { status: pending.status, waitReason: pending.waitReason, hasPendingApproval: Boolean(pending.pendingApproval), riskyWrites: (await riskyCount(ctx)) - riskyBefore }
    save()
    if (!pending.pendingApproval) throw new Error('no pending approval persisted')

    // Optional hold (upgrade/reboot drills): the approval stays pending while the operator acts on H.
    const hold = process.env.ABP_A08_HOLD_FILE
    if (hold) {
        writeFileSync(`${hold}.waiting`, String(taskId))
        while (!existsSync(hold)) await sleep(2_000)
        const survived = await user.getTask({ taskId })
        evidence.afterHold = { status: survived.status, waitReason: survived.waitReason, hasPendingApproval: Boolean(survived.pendingApproval), sameTask: survived.taskId === taskId }
        save()
        if (!survived.pendingApproval) throw new Error('the pending approval did not survive the hold')
        Object.assign(pending, { pendingApproval: survived.pendingApproval })
    }

    // 3. The user reconnects and approves exactly this action.
    const approvedAt = now()
    const approval = await user.approve({
        taskId,
        approvalId: pending.pendingApproval.approvalId,
        bindingHash: pending.pendingApproval.bindingHash,
        requestId: `approve-${iteration}-${approvedAt}` as never,
        decision: 'approve',
    })
    evidence.approveOutcome = approval.outcome
    for (const deadline = now() + 30_000; now() < deadline && (await riskyCount(ctx)) - riskyBefore < 1;) await sleep(250)
    const afterApproval = await user.getTask({ taskId })
    const events = await user.subscribe({ taskId, afterSeq: 0 })
    const list = events.kind === 'events' ? events.events : [] as TaskEvent[]
    const attention = list.filter((event) => event.type === 'agent-attention-required').at(-1)
    evidence.afterApproval = { status: afterApproval.status, pauseReason: afterApproval.pauseReason, riskyWrites: (await riskyCount(ctx)) - riskyBefore, attentionEventSeq: attention?.seq }
    save()
    if (!attention) throw new Error('no agent-attention-required event')

    // 4. Wake the owning agent session. Production layout: nobody sends it — the daemon on H
    //    delivers the attention event itself (D10); no client process exists at that point.
    const wakeAt = prodIdentity ? approvedAt : now()
    if (prodIdentity) {
        evidence.wakeBy = 'daemon-attention-watcher'
        evidence.clientProcessesAtWake = await clientProcessCount()
        const wakeText = `[agent-browser] task ${taskId}`
        let woke = false
        for (const deadline = now() + 300_000; !woke && now() < deadline; await sleep(2_000)) woke = (await userTexts(sessionId)).some((text) => text.startsWith(wakeText))
        evidence.daemonWakeSeen = woke
    } else {
        await sessionClient('send', sessionId, followUp(taskId, `${afterApproval.status}:${afterApproval.pauseReason ?? ''}`, attention.seq))
    }
    evidence.clientProcessesAfterWake = await clientProcessCount()
    rows = await waitForTranscript(sessionId, (list2) => list2.some((row) => row.t === 'turn-end' && row.time > wakeAt), 300_000)
    evidence.agentToolCallsAfterWake = rows.filter((row) => row.t === 'tool-call-start' && row.time > wakeAt && row.name?.includes('browser_task_')).map((row) => row.name!.replace('mcp__happy__', ''))
    evidence.agentReplyAfterWake = rows.filter((row) => row.t === 'text' && row.time > wakeAt && row.text).at(-1)?.text?.slice(0, 160)
    const finished = await user.getTask({ taskId })
    evidence.finalStatus = finished.status
    save()

    // 5. A duplicated wake-up (at-least-once delivery) must not dispatch anything again.
    const dupAt = now()
    const seqBeforeDup = finished.highWatermarkSeq
    await sessionClient('send', sessionId, followUp(taskId, `${afterApproval.status}:${afterApproval.pauseReason ?? ''}`, attention.seq))
    await waitForTranscript(sessionId, (list2) => list2.some((row) => row.t === 'turn-end' && row.time > dupAt), 300_000)
    const afterDup = await user.subscribe({ taskId, afterSeq: seqBeforeDup })
    const dupEvents = afterDup.kind === 'events' ? afterDup.events : []
    evidence.duplicateWake = {
        newDispatchEvents: dupEvents.filter((event) => ['batch-accepted', 'action-intent', 'action-dispatched'].includes(event.type)).length,
        riskyWrites: (await riskyCount(ctx)) - riskyBefore,
        status: (await user.getTask({ taskId })).status,
    }

    const before = evidence.beforeApproval as { riskyWrites: number; status: string }
    const after = evidence.afterApproval as { riskyWrites: number }
    const dup = evidence.duplicateWake as { newDispatchEvents: number; riskyWrites: number; status: string }
    evidence.pass = before.status === 'awaiting-user' && before.riskyWrites === 0
        && evidence.approveOutcome === 'approved' && after.riskyWrites === 1
        && evidence.finalStatus === 'succeeded'
        && (!prodIdentity || (evidence.daemonWakeSeen === true && evidence.clientProcessesAtWake === 0))
        && dup.newDispatchEvents === 0 && dup.riskyWrites === 1 && dup.status === 'succeeded'
    save()
    console.log(JSON.stringify({ pass: evidence.pass, taskId }))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})
