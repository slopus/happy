/**
 * A01 with a separate execution machine and the real Desktop GUI as the client.
 * H (ABP_EXEC_MACHINE) runs the stack, the Happy daemon and the agent; this
 * machine runs the Desktop app (client C) and plays the auth server.
 *
 *  1. The user starts a personal chat on machine H from the Desktop GUI; the
 *     daemon on H spawns the session (its env points at the Runtime and at a
 *     grant file that is still empty, so no browser call can succeed yet).
 *  2. The harness finds the new session on H's daemon and writes its grant.
 *  3. The user sends the A01 task in the same chat and quits the Desktop: the
 *     whole Desktop process tree is terminated and must be empty.
 *  4. Only then the fixture barrier is released; everything after it is the
 *     agent's own judgement and tool calls on H.
 *  5. The Desktop is relaunched and the user reopens the chat: the result and
 *     the same task/profile are checked from the reconnected client.
 *
 * Usage: ABP_EXEC_MACHINE=abp-exec ABP_EXEC_HOST=<ip> tsx src/browserRuntime/e2e/realAgentA01DesktopGui.ts \
 *          --run <stackRun> --iteration <n> --machine <happyMachineIdPrefix>
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskEvent, TaskId } from '../contracts'
import { DesktopGui, desktopProcesses, launchDesktop, quitDesktop, signalDesktop, startClientProxy } from './desktopGuiClient'
import {
    clientProcessCount, evidenceFile, execDaemonSessions, execMachine, fixtureControl, prodIdentity, ledger, loadRun, now, parseArgs, sleep,
    userClient, waitForTranscript, writeAgentGrant,
} from './realAgentHarness'

const WAIT_STEP_LIMIT_MS = 120_000
const PROMPT_TEMPLATE = readFileSync(join(import.meta.dirname, 'realAgentA01.prompt.txt'), 'utf8')
/** The grant file the daemon on H hands to every session it spawns. */
const DAEMON_GRANT_FILE = process.env.ABP_EXEC_DAEMON_GRANT_FILE ?? '/home/agent/abp-grants/current.token'

async function main(): Promise<void> {
    if (!execMachine) throw new Error('ABP_EXEC_MACHINE is required')
    const args = parseArgs(process.argv.slice(2))
    const ctx = loadRun(args.run)
    const iteration = args.iteration ?? '1'
    const barrierKey = `k${iteration}-${now().toString(36)}`
    const title = `ABP ${ctx.run}-${iteration}-${now().toString(36)}`
    const shots = (name: string) => join(ctx.runDir, `a01-gui-${iteration}-${name}.png`)
    const { data: evidence, save } = evidenceFile(join(ctx.runDir, `a01-gui-${iteration}.json`))
    // quit: the whole Desktop tree ends; sleep: it is frozen (SIGSTOP) and later continued;
    // netcut: only the Desktop's (Chromium) traffic is cut through a local proxy, then restored.
    const fault = (args['client-fault'] ?? 'quit') as 'quit' | 'sleep' | 'netcut'
    if (!['quit', 'sleep', 'netcut'].includes(fault)) throw new Error('--client-fault quit|sleep|netcut')
    Object.assign(evidence, { run: ctx.run, iteration, barrierKey, executionMachine: execMachine, client: 'desktop-gui', fault })
    const proxy = fault === 'netcut' ? await startClientProxy() : undefined
    if (proxy) {
        await quitDesktop()
        launchDesktop(join(ctx.runDir, `desktop-netcut-${iteration}.log`), { proxyPort: proxy.port })
    }

    // 1. The user opens a chat on H from the Desktop.
    const before = new Set(await execDaemonSessions())
    let gui = await DesktopGui.connect()
    await gui.startPersonalChat(args.machine, `${title} 연결 확인: 도구를 쓰지 말고 ready 한 단어로만 답해줘.`)
    let sessionId: string | undefined
    for (const deadline = now() + 120_000; !sessionId && now() < deadline; await sleep(1_000)) {
        sessionId = (await execDaemonSessions()).find((id) => !before.has(id))
    }
    if (!sessionId) {
        await gui.screenshot(shots('no-session'))
        throw new Error('the Desktop did not start a session on the execution machine')
    }
    evidence.agentSessionId = sessionId
    save()

    // 2. Bind an agent grant to exactly that session.
    // Production layout: the Runtime broker already issued this session's grant at spawn.
    evidence.grantId = prodIdentity ? 'broker' : await writeAgentGrant(ctx, sessionId, `a01-gui-${iteration}`, DAEMON_GRANT_FILE)
    await waitForTranscript(sessionId, (rows) => rows.some((row) => row.t === 'turn-end'), 180_000)

    // 3. The A01 task from the same chat, then the Desktop quits.
    evidence.promptTemplateSha256 = createHash('sha256').update(PROMPT_TEMPLATE).digest('hex')
    evidence.guiSendStartedAtMs = now()
    await gui.sendInOpenChat(PROMPT_TEMPLATE.replace('__PROFILE__', prodIdentity?.profileId ?? 'profile-a').replace('__RUN__', ctx.run).replace('__KEY__', barrierKey).replace(/\n/g, ' '))
    const sentAt = now()
    // Delivered = the agent has started working on it on H (not just "left the composer").
    const started = await waitForTranscript(sessionId, (rows) => rows.some((row) => row.t === 'tool-call-start' && row.time > sentAt), 180_000)
    if (!started.some((row) => row.t === 'tool-call-start' && row.time > sentAt)) throw new Error('the task never reached the agent')
    await gui.screenshot(shots('before-quit'))
    gui.close()
    let quit = { before: [] as Array<{ pid: number; command: string }>, killedAfterGrace: 0, remaining: 0 }
    if (fault === 'quit') {
        quit = await quitDesktop()
        evidence.desktopQuit = { atMs: now(), processesBefore: quit.before, killedAfterGrace: quit.killedAfterGrace, remaining: quit.remaining }
    } else if (fault === 'sleep') {
        const stopped = await signalDesktop('SIGSTOP')
        evidence.desktopSleep = { atMs: now(), processes: stopped.processes, states: stopped.states, allStopped: stopped.states.length === stopped.processes && stopped.states.every((state) => state === 'T') }
    } else {
        evidence.proxyBeforeCut = proxy!.stats()
        evidence.desktopNetcut = { atMs: now(), connectionsCut: proxy!.cut() }
    }
    save()

    // 4. Wait for the agent's waitFor batch, then release the barrier with no client alive.
    const isWaitBatch = (row: { t: string; name?: string }) => row.t === 'tool-call-start' && Boolean(row.name?.endsWith('browser_task_submit_batch'))
    const waitingRows = await waitForTranscript(sessionId, (rows) => rows.some(isWaitBatch), 180_000)
    const waitingSince = waitingRows.find(isWaitBatch)?.time
    if (!waitingSince) throw new Error('agent never submitted the waiting batch')
    evidence.agentWaitBatchStartedAtMs = waitingSince
    evidence.desktopProcessesAtRelease = (await desktopProcesses()).length
    if (fault === 'sleep') evidence.desktopStatesAtRelease = (await signalDesktop('SIGSTOP')).states
    if (proxy) evidence.proxyAtRelease = proxy.stats()
    evidence.clientProcessesAtRelease = await clientProcessCount()
    const released = now()
    evidence.barrierReleasedAtMs = released
    evidence.releaseWithinWaitLimit = released - waitingSince < WAIT_STEP_LIMIT_MS
    await fixtureControl(ctx, 'POST', '/control/barrier/release', { run: ctx.run, key: barrierKey, nonce: `N${randomBytes(4).toString('hex')}` })
    save()

    const rows = await waitForTranscript(sessionId, (list) => list.some((row) => row.t === 'turn-end' && row.time > released), 600_000)
    evidence.agentToolCallsAfterRelease = rows
        .filter((row) => row.t === 'tool-call-start' && row.time > released && row.name?.includes('browser_task_'))
        .map((row) => ({ name: row.name!.replace('mcp__happy__', ''), atMs: row.time }))
    evidence.finalAgentText = rows.filter((row) => row.t === 'text' && row.text).at(-1)?.text?.slice(0, 200)
    evidence.desktopProcessesAtTurnEnd = (await desktopProcesses()).length

    const entries = await ledger(ctx)
    const answers = entries.filter((entry) => entry.kind === 'answer' && entry.key === barrierKey)
    evidence.ledgerAnswers = answers.map((entry) => ({ correct: entry.correct, atMs: entry.atMs }))
    save()

    // 5. The client comes back: relaunch after quit; wake-up or network return keep the same window.
    let reopened = true
    if (fault === 'quit') {
        launchDesktop(join(ctx.runDir, 'desktop-relaunch.log'))
        gui = await DesktopGui.connect()
        reopened = await gui.openPersonalChatByTitle(title)
    } else {
        if (fault === 'sleep') evidence.desktopWake = { atMs: now(), states: (await signalDesktop('SIGCONT')).states }
        else { proxy!.restore(); evidence.netRestoredAtMs = now() }
        gui = await DesktopGui.connect()
    }
    const shown = reopened && await gui.waitFor(`document.body.innerText.includes('A01-DONE')`, 180_000)
    await gui.screenshot(shots('after-reconnect'))
    evidence.desktopReconnect = { reopenedChat: reopened, showsAgentResult: shown }
    gui.close()

    const taskId = /taskId=(\S+)/.exec(String(evidence.finalAgentText ?? ''))?.[1] as TaskId | undefined
    if (taskId) try {
        const viewer = userClient(ctx, `viewer-a01-gui-${iteration}`)
        const task = await viewer.getTask({ taskId })
        const events = await viewer.subscribe({ taskId, afterSeq: 0 })
        const list = events.kind === 'events' ? events.events : [] as TaskEvent[]
        evidence.task = { taskId, status: task.status, profileId: task.profileId, agentSessionId: task.agentSessionId, highWatermarkSeq: task.highWatermarkSeq }
        evidence.batchesAccepted = list.filter((event) => event.type === 'batch-accepted')
            .map((event) => ({ seq: event.seq, atMs: event.atMs, afterRelease: event.atMs > released }))
    } catch (error) {
        evidence.reconnectError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    const batches = (evidence.batchesAccepted ?? []) as Array<{ afterRelease: boolean }>
    const task = evidence.task as { status?: string; agentSessionId?: string; profileId?: string } | undefined
    const sleepHeld = fault !== 'sleep' || ((evidence.desktopSleep as { allStopped?: boolean })?.allStopped === true
        && (evidence.desktopStatesAtRelease as string[]).every((state) => state === 'T'))
    const cutHeld = fault !== 'netcut' || (evidence.proxyAtRelease as { tunnels: number }).tunnels === (evidence.proxyBeforeCut as { tunnels: number }).tunnels
    if (proxy) {
        // Leave a normal client behind: a Desktop pointing at a closed proxy has no network at all.
        await quitDesktop()
        await proxy.close()
        launchDesktop(join(ctx.runDir, 'desktop-after-netcut.log'))
        await DesktopGui.connect().then((restored) => restored.close()).catch(() => undefined)
    }
    evidence.pass = quit.remaining === 0 && sleepHeld && cutHeld
        && (fault !== 'quit' || evidence.desktopProcessesAtRelease === 0) && evidence.clientProcessesAtRelease === 0
        && evidence.releaseWithinWaitLimit === true
        && answers.length === 1 && answers[0].correct === true
        && batches.some((batch) => batch.afterRelease)
        && task?.status === 'succeeded' && task.agentSessionId === sessionId && task.profileId === (prodIdentity?.profileId ?? 'profile-a')
        && shown === true
    save()
    console.log(JSON.stringify({ pass: evidence.pass, sessionId }))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})
