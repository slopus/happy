/**
 * A10 "전용 H 재부팅": reboot the dedicated execution machine H while a task has
 * an open tab and live refs, then check what comes back by itself (docker
 * restart policy, systemd Happy daemon) and that the Runtime restores the saved
 * task instead of pretending it ran continuously.
 *
 * Usage: ABP_EXEC_MACHINE=abp-exec ABP_EXEC_HOST=<ip> tsx src/browserRuntime/e2e/execMachineReboot.ts --run <stackRun> --iteration <n>
 * Writes scripts/browser-poc/.abp/<run>/reboot-<n>.json (no secrets).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mintAgentGrant } from '../auth'
import {
    AGENT_OPERATIONS, type ActionId, type AgentSessionId, type GrantId, type RequestId, type StepId, type TabId, type TaskId,
} from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE } from './pocStack'
import { evidenceFile, execFetch, execHappyHome, execMachine, loadRun, now, onExecMachine, parseArgs, sleep, userClient } from './realAgentHarness'

const rid = () => randomUUID() as RequestId

/** The run's docker volumes (profiles, journal) with their creation time: same volume = same saved state. */
const volumes = (run: string) => onExecMachine(`docker volume ls -q --filter label=ai.saycode.abp-run=${run} | xargs -r docker volume inspect --format '{{.Name}} {{.CreatedAt}}'`)
    .then((out) => out.trim().split('\n').sort())

async function main(): Promise<void> {
    if (!execMachine) throw new Error('ABP_EXEC_MACHINE is required')
    const args = parseArgs(process.argv.slice(2))
    const iteration = args.iteration ?? '1'
    let ctx = loadRun(args.run)
    const { data: evidence, save } = evidenceFile(join(ctx.runDir, `reboot-${iteration}.json`))
    Object.assign(evidence, { run: ctx.run, iteration, executionMachine: execMachine })

    const containers = (await onExecMachine(`docker ps -q --filter label=ai.saycode.abp-run=${ctx.run}`)).trim().split('\n').filter(Boolean)
    // Services on H must come back on their own: containers via restart policy, the daemon via systemd.
    await onExecMachine(`docker update --restart unless-stopped ${containers.join(' ')} >/dev/null`)
    evidence.restartPolicy = 'unless-stopped'
    evidence.containers = containers.length

    const issuedAt = now()
    const agentSessionId = `agent-reboot-${iteration}-${randomBytes(3).toString('hex')}` as AgentSessionId
    const grant = mintAgentGrant({
        kind: 'agent-grant', grantId: `grant-${ctx.run}-reboot-${iteration}` as GrantId, principalId: PRINCIPAL_A, workspaceId: WORKSPACE,
        machineId: MACHINE, agentSessionId, profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B], operations: [...AGENT_OPERATIONS],
        taskSpaceIds: [], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 55 * 60_000,
    }, ctx.keys, issuedAt)
    const agent = new RuntimeClient({ baseUrl: ctx.runtimeUrl, token: grant, fetchImpl: execFetch })
    const tag = `rb${iteration}${randomBytes(2).toString('hex')}`

    const space = await agent.createSpace({ profileId: PROFILE_A, requestId: rid() })
    const task = await agent.createTask({ taskSpaceId: space.taskSpaceId, requestId: rid() })
    const taskId = task.taskId
    const volumesBefore = await volumes(ctx.run)
    const opened = await agent.openPage({ taskId, url: `${SITE_A}/oopif?run=${ctx.run}`, requestId: rid() })
    const observed = await agent.observe({ taskId, tabId: opened.tabId })
    const oldRef = observed.elements.find((element) => element.name === 'Buy')?.ref
    const before = await agent.getTask({ taskId })
    const bootBefore = (await onExecMachine('cat /proc/sys/kernel/random/boot_id')).trim()
    Object.assign(evidence, {
        taskId, taskSpaceId: space.taskSpaceId,
        before: { status: before.status, pauseReason: before.pauseReason, browserInstanceId: before.browserInstanceId, highWatermarkSeq: before.highWatermarkSeq, tabs: before.tabs.length },
        volumesBefore,
    })
    save()

    // Reboot H.
    const rebootAt = now()
    execFileSync('orb', ['restart', execMachine], { stdio: 'ignore', timeout: 300_000 })
    evidence.rebootCommandMs = now() - rebootAt
    const bootAfter = (await onExecMachine('cat /proc/sys/kernel/random/boot_id')).trim()
    evidence.bootIdChanged = bootAfter !== bootBefore
    save()

    // Ports may be reassigned when containers come back: read them from H again.
    let health: unknown
    for (const deadline = now() + 240_000; now() < deadline && !health; await sleep(2_000)) {
        try {
            const port = (name: string, internal: number) => onExecMachine(`docker port abp-${ctx.run}-${name} ${internal} | head -1 | sed 's/.*://'`).then((out) => Number(out.trim()))
            const ports = { ...ctx.env.ports, runtime: await port('runtime', 8787), control: await port('fixture', 9099) }
            if (!ports.runtime) continue
            ctx = { ...ctx, env: { ...ctx.env, ports }, runtimeUrl: ctx.runtimeUrl.replace(/:\d+$/, `:${ports.runtime}`), agentRuntimeUrl: `http://127.0.0.1:${ports.runtime}` }
            const response = await execFetch(`${ctx.runtimeUrl}/v1/health`)
            const body = await response.json() as { ok?: boolean; profiles?: Array<{ connected: boolean }> }
            if (body.ok && body.profiles?.every((profile) => profile.connected)) health = body
        } catch { /* still booting */ }
    }
    evidence.recoveredWithinMs = health ? now() - rebootAt : null
    evidence.portsAfter = ctx.env.ports
    evidence.daemonActive = (await onExecMachine('systemctl is-active abp-happy-daemon || true')).trim()
    evidence.daemonStatus = (await onExecMachine(`su agent -c 'HAPPY_HOME_DIR=${execHappyHome()} /home/agent/.happy-cli-isolated-abp/prefix/bin/happy daemon status' 2>&1 | grep -c "Daemon is running" || true`)).trim() === '1'
    save()
    if (!health) throw new Error('the Runtime did not come back after the reboot')

    // Same task, restored from its journal, visibly interrupted.
    const fresh = new RuntimeClient({ baseUrl: ctx.runtimeUrl, token: grant, fetchImpl: execFetch })
    let after = await fresh.getTask({ taskId })
    for (const deadline = now() + 60_000; now() < deadline && after.status !== 'paused'; await sleep(1_000)) after = await fresh.getTask({ taskId })
    const viewer = userClient(ctx, `viewer-reboot-${iteration}`)
    const events = await viewer.subscribe({ taskId, afterSeq: 0 })
    const list = events.kind === 'events' ? events.events : []
    evidence.after = {
        status: after.status, pauseReason: after.pauseReason, browserInstanceId: after.browserInstanceId, highWatermarkSeq: after.highWatermarkSeq,
        tabs: after.tabs.length, sameTask: after.taskId === taskId, sameProfile: after.profileId === PROFILE_A,
    }
    evidence.eventsBeforeKept = list.filter((event) => event.seq <= before.highWatermarkSeq).length === before.highWatermarkSeq
    evidence.eventTypesAfterReboot = [...new Set(list.filter((event) => event.seq > before.highWatermarkSeq).map((event) => event.type))]

    // Old tab and ref must be dead; the task resumes on the new browser with the profile intact.
    const oldObserve = await fresh.observe({ taskId, tabId: opened.tabId }).then(() => 'allowed', (error) => error.code as string)
    const oldClick = oldRef
        ? await fresh.submitBatch({ taskId, expectedVersion: after.stateVersion, requestId: rid(), steps: [{ stepId: 'old' as StepId, actionId: `old-${tag}` as ActionId, tabId: opened.tabId, kind: 'click', ref: oldRef, timeoutMs: 5_000 }] })
            .then(() => 'accepted', (error) => error.code as string)
        : 'no-ref'
    const resumed = await fresh.resume({ taskId, expectedVersion: (await fresh.getTask({ taskId })).stateVersion, requestId: rid() })
    const check = await fresh.openPage({ taskId, url: `${SITE_A}/marker?label=reboot-${tag}`, requestId: rid() })
    const volumesAfter = await volumes(ctx.run)
    const finished = await fresh.finishTask({ taskId, expectedVersion: check.task.stateVersion, requestId: rid() })
    for (const tabId of [check.tabId]) await fresh.closePage({ taskSpaceId: space.taskSpaceId, tabId, requestId: rid() }).catch(() => undefined)
    await fresh.closeSpace({ taskSpaceId: space.taskSpaceId, requestId: rid() }).catch((error) => { evidence.closeSpaceError = String(error.code ?? error) })
    Object.assign(evidence, { oldObserve, oldClick, resumedStatus: `${resumed.status}:${resumed.pauseReason ?? ''}`, volumesKept: JSON.stringify(volumesAfter) === JSON.stringify(volumesBefore), finishedStatus: finished.status })

    const a = evidence.after as { status: string; browserInstanceId: string; sameTask: boolean; sameProfile: boolean }
    evidence.pass = evidence.bootIdChanged === true
        && a.sameTask && a.sameProfile && a.status === 'paused' && a.browserInstanceId !== before.browserInstanceId
        && evidence.eventsBeforeKept === true
        && oldObserve !== 'allowed' && oldClick !== 'accepted'
        && evidence.volumesKept === true
        && finished.status === 'succeeded'
        && evidence.daemonActive === 'active'
    save()
    writeFileSync(join(ctx.runDir, 'env.json'), JSON.stringify(ctx.env, null, 2))
    console.log(JSON.stringify({ pass: evidence.pass, recoveredWithinMs: evidence.recoveredWithinMs, after: evidence.after }))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})
