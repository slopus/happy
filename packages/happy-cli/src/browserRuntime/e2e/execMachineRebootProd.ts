/**
 * GD6 on an installed H (production layout): reboot the machine while a real agent
 * task waits for approval, then check that every service came back by itself
 * (systemd: firewall, egress rules, proxy, stack, Happy daemon), that abp-install
 * check passes, that the same task was restored from its journal and shown as
 * interrupted (never as having run continuously), and that H's daemon told the
 * owning agent session about it when that session still runs (recorded).
 *
 * Usage: (production env as for realAgentA08) tsx src/browserRuntime/e2e/execMachineRebootProd.ts --run <run> --iteration <n> --task <taskId> --session <agentSessionId>
 * Needs a task held pending approval (realAgentA08 with ABP_A08_HOLD_FILE).
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { TaskId } from '../contracts'
import { evidenceFile, execMachine, loadRun, now, onExecMachine, parseArgs, sleep, userClient, userTexts } from './realAgentHarness'

async function main(): Promise<void> {
    if (!execMachine) throw new Error('ABP_EXEC_MACHINE is required')
    const args = parseArgs(process.argv.slice(2))
    const ctx = loadRun(args.run)
    const taskId = args.task as TaskId
    const { data: evidence, save } = evidenceFile(join(ctx.runDir, `reboot-prod-${args.iteration}.json`))
    Object.assign(evidence, { run: ctx.run, iteration: args.iteration, taskId, agentSessionId: args.session })

    const before = await userClient(ctx, 'reboot').getTask({ taskId })
    const bootBefore = (await onExecMachine('cat /proc/sys/kernel/random/boot_id')).trim()
    const wakesBefore = (await userTexts(args.session)).filter((text) => text.startsWith(`[agent-browser] task ${taskId}`)).length
    evidence.before = { status: before.status, pauseReason: before.pauseReason, waitReason: before.waitReason, pendingApproval: Boolean(before.pendingApproval), highWatermarkSeq: before.highWatermarkSeq }
    save()

    const rebootAt = now()
    execFileSync('orb', ['restart', execMachine], { stdio: 'ignore', timeout: 300_000 })
    let ready = false
    for (const deadline = now() + 300_000; !ready && now() < deadline; await sleep(3_000)) {
        ready = await onExecMachine('/usr/local/sbin/abp-stack status 2>/dev/null | grep -q "runtime ready" && echo yes || true').then((out) => out.trim() === 'yes').catch(() => false)
    }
    evidence.readyWithinMs = ready ? now() - rebootAt : null
    evidence.bootIdChanged = (await onExecMachine('cat /proc/sys/kernel/random/boot_id')).trim() !== bootBefore
    evidence.services = (await onExecMachine('systemctl is-active abp-firewall abp-egress abp-egress-proxy abp-stack abp-happy-daemon || true')).trim().split('\n')
    // First run right after ready, then settle for up to 60 s: both are recorded; the verdict uses the
    // settled result and the first run's failing lines are kept so a slow service is visible.
    const installer = process.env.ABP_EXEC_INSTALLER ?? '/opt/src/happy3/packages/happy-cli/scripts/agent-browser/abp-install'
    const runCheck = () => onExecMachine(`${installer} check 2>&1 || true`).catch((error) => String(error))
    const first = await runCheck()
    evidence.installCheckFirst = { summary: first.trim().split('\n').at(-1), failed: first.split('\n').filter((line) => /^(FAIL|fail|not ok|✗)/.test(line.trim())).map((line) => line.trim().slice(0, 160)) }
    let settled = first
    for (const deadline = now() + 60_000; !/all checks passed/.test(settled) && now() < deadline; await sleep(5_000)) settled = await runCheck()
    evidence.installCheck = settled.trim().split('\n').at(-1)
    // Harness-only pieces are not services: bring the test fixture and the Mac tunnel back.
    await onExecMachine('docker start abp-test-fixture >/dev/null 2>&1 || true; systemctl reset-failed abp-test-tunnel 2>/dev/null; systemctl is-active abp-test-tunnel >/dev/null || systemd-run --unit abp-test-tunnel --property=Restart=always /usr/bin/socat TCP-LISTEN:38780,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:38700 >/dev/null 2>&1 || true')
    save()
    if (!ready) throw new Error('the stack did not become ready after the reboot')

    let after = await userClient(ctx, 'reboot').getTask({ taskId })
    for (const deadline = now() + 60_000; now() < deadline && after.status !== 'paused'; await sleep(2_000)) after = await userClient(ctx, 'reboot').getTask({ taskId })
    const events = await userClient(ctx, 'reboot').subscribe({ taskId, afterSeq: before.highWatermarkSeq })
    const newTypes = events.kind === 'events' ? [...new Set(events.events.map((event) => event.type))] : ['snapshot-required']
    let wakes = wakesBefore
    for (const deadline = now() + 180_000; now() < deadline && wakes === wakesBefore; await sleep(3_000)) {
        wakes = (await userTexts(args.session)).filter((text) => text.startsWith(`[agent-browser] task ${taskId}`)).length
    }
    Object.assign(evidence, {
        after: { status: after.status, pauseReason: after.pauseReason, pendingApproval: Boolean(after.pendingApproval), sameTask: after.taskId === taskId, profileId: after.profileId },
        eventTypesAfterReboot: newTypes,
        daemonWakesAfterReboot: wakes - wakesBefore,
    })
    evidence.pass = evidence.bootIdChanged === true
        && (evidence.services as string[]).every((state) => state === 'active')
        && /all checks passed/.test(String(evidence.installCheck))
        && after.taskId === taskId && after.status === 'paused' && newTypes.includes('recovered')
    // A reboot also ends the agent session process; the daemon only re-invokes sessions it still runs,
    // so daemonWakesAfterReboot is recorded, not required (the task waits for the user in the console).
    save()
    console.log(JSON.stringify({ pass: evidence.pass, readyWithinMs: evidence.readyWithinMs, after: evidence.after, wakes: wakes - wakesBefore }))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})
