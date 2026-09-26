/**
 * A01 real-agent path (T09 walking skeleton / T28): a real Happy agent session,
 * spawned by an isolated Happy daemon running this branch, drives the browser
 * Runtime through the browser_task_* MCP tools. The prompting client exits
 * before the fixture barrier is released, so everything after the release is
 * the agent's own post-close judgement and tool calls.
 *
 * Usage (from packages/happy-cli, stack already up via stackCli.ts):
 *   tsx src/browserRuntime/e2e/realAgentA01.ts --run <stackRun> --iteration <n>
 * Env: ABP_HAPPY_HOME (isolated daemon home), ABP_SESSION_CLIENT_DIR (Desktop
 * worktree holding .abp-harness/sessionClient.ts).
 * Writes scripts/browser-poc/.abp/<run>/a01-real-<n>.json (no secrets).
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskEvent, TaskId } from '../contracts'
import {
    clientProcessCount, evidenceFile, fixtureControl, ledger, loadRun, now, parseArgs, sessionClient, spawnAgentSession,
    userClient, waitForTranscript, prodIdentity,
} from './realAgentHarness'

/** The waitFor step the agent submits may block at most this long (contracts). */
const WAIT_STEP_LIMIT_MS = 120_000
const PROMPT_TEMPLATE = readFileSync(join(import.meta.dirname, 'realAgentA01.prompt.txt'), 'utf8')

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const ctx = loadRun(args.run)
    const iteration = args.iteration ?? '1'
    const barrierKey = `k${iteration}-${now().toString(36)}`
    const { data: evidence, save } = evidenceFile(join(ctx.runDir, `a01-real-${iteration}.json`))
    evidence.run = ctx.run
    evidence.iteration = iteration
    evidence.barrierKey = barrierKey

    // 1–2. Real agent session through the daemon, with an agent grant bound to it.
    const { sessionId } = await spawnAgentSession(ctx, `a01-${iteration}`)
    evidence.agentSessionId = sessionId
    save()

    // 3. The client sends the fixed prompt and exits.
    evidence.promptTemplateSha256 = createHash('sha256').update(PROMPT_TEMPLATE).digest('hex')
    evidence.clientSendStartedAtMs = now()
    await sessionClient('send', sessionId, PROMPT_TEMPLATE.replace('__PROFILE__', prodIdentity?.profileId ?? 'profile-a').replace('__RUN__', ctx.run).replace('__KEY__', barrierKey))
    evidence.clientExitedAtMs = now()
    evidence.clientProcessesAfterExit = await clientProcessCount()
    save()

    // 4. Wait until the agent is blocked in its waitFor batch.
    const isWaitBatch = (row: { t: string; name?: string }) => row.t === 'tool-call-start' && Boolean(row.name?.endsWith('browser_task_submit_batch'))
    const waitingRows = await waitForTranscript(sessionId, (rows) => rows.some(isWaitBatch), 180_000)
    const waitingSince = waitingRows.find(isWaitBatch)?.time
    if (!waitingSince) throw new Error('agent never submitted the waiting batch')
    evidence.agentWaitBatchStartedAtMs = waitingSince

    // 5. Only now, with no client process alive, release the barrier.
    evidence.clientProcessesAtRelease = await clientProcessCount()
    const released = now()
    evidence.barrierReleasedAtMs = released
    evidence.releaseWithinWaitLimit = released - waitingSince < WAIT_STEP_LIMIT_MS
    await fixtureControl(ctx, 'POST', '/control/barrier/release', { run: ctx.run, key: barrierKey, nonce: `N${randomBytes(4).toString('hex')}` })
    save()

    // 6. Let the agent finish its turn on its own.
    const rows = await waitForTranscript(sessionId, (list) => list.some((row) => row.t === 'turn-end' && row.time > released), 600_000)
    evidence.agentToolCallsAfterRelease = rows
        .filter((row) => row.t === 'tool-call-start' && row.time > released && row.name?.includes('browser_task_'))
        .map((row) => ({ name: row.name!.replace('mcp__happy__', ''), atMs: row.time }))
    evidence.finalAgentText = rows.filter((row) => row.t === 'text' && row.text).at(-1)?.text?.slice(0, 200)

    // 7. Independent evidence: fixture ledger and the Runtime's own task journal.
    const entries = await ledger(ctx)
    const answers = entries.filter((entry) => entry.kind === 'answer' && entry.key === barrierKey)
    evidence.ledgerAnswers = answers.map((entry) => ({ correct: entry.correct, atMs: entry.atMs }))
    evidence.ledgerBarrierReleaseAtMs = entries.find((entry) => entry.kind === 'barrier-release' && entry.key === barrierKey)?.atMs

    const taskId = /taskId=(\S+)/.exec(String(evidence.finalAgentText ?? ''))?.[1] as TaskId | undefined
    if (taskId) try {
        // Reconnect as the user: same task, same profile, full event history.
        const viewer = userClient(ctx, `viewer-a01-${iteration}`)
        const task = await viewer.getTask({ taskId })
        const events = await viewer.subscribe({ taskId, afterSeq: 0 })
        const list = events.kind === 'events' ? events.events : [] as TaskEvent[]
        evidence.task = { taskId, status: task.status, profileId: task.profileId, agentSessionId: task.agentSessionId, highWatermarkSeq: task.highWatermarkSeq }
        evidence.batchesAccepted = list.filter((event) => event.type === 'batch-accepted')
            .map((event) => ({ seq: event.seq, atMs: event.atMs, afterRelease: event.atMs > released }))
        evidence.writeIntentsAfterRelease = list.filter((event) => event.type === 'action-intent' && event.atMs > released).length
    } catch (error) {
        evidence.reconnectError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    const batches = (evidence.batchesAccepted ?? []) as Array<{ afterRelease: boolean }>
    const task = evidence.task as { status?: string; agentSessionId?: string } | undefined
    evidence.pass = evidence.clientProcessesAtRelease === 0
        && evidence.releaseWithinWaitLimit === true
        && answers.length === 1 && answers[0].correct === true
        && batches.some((batch) => batch.afterRelease)
        && task?.status === 'succeeded'
        && task.agentSessionId === sessionId
    save()
    console.log(JSON.stringify({ pass: evidence.pass }))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})
