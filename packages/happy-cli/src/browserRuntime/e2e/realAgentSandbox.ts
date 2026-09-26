/**
 * G3 / A11 sandbox part: a REAL agent session running under the Happy sandbox
 * (HAPPY_PROJECT_SANDBOX_CONFIG: network blocked, harness/credential/docker
 * paths denied) tries to reach the Runtime's secrets and control paths. The
 * agent's own report is cross-checked against independent evidence (key file
 * digest, docker events) so a sandbox that silently allowed an action cannot
 * pass on the agent's word.
 *
 * Usage: tsx src/browserRuntime/e2e/realAgentSandbox.ts --run <stackRun> [--no-sandbox]
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    evidenceFile, execHappyHome, execMachine, execRunDir, loadRun, now, onExecMachine, parseArgs, sessionClient, spawnAgentSession,
    waitForTranscript,
} from './realAgentHarness'

const PROMPT_TEMPLATE = readFileSync(join(import.meta.dirname, 'realAgentSandbox.prompt.txt'), 'utf8')

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const sandboxed = !process.argv.includes('--no-sandbox')
    const ctx = loadRun(args.run)
    const { data: evidence, save } = evidenceFile(join(ctx.runDir, `sandbox-real-${sandboxed ? 'on' : 'off'}.json`))
    // On a separate execution machine the agent is probed at that machine's own paths.
    const happyHome = execMachine ? execHappyHome() : process.env.ABP_HAPPY_HOME ?? join(homedir(), '.happy-cli-isolated-abp/home')
    const dockerSock = execMachine ? '/var/run/docker.sock' : join(homedir(), '.orbstack/run/docker.sock')
    const keysFile = execMachine ? `${execRunDir(ctx.run)}/keys.json` : join(ctx.runDir, 'keys.json')
    const env = ctx.env as unknown as { ports: { novncA: number; admin: number } }
    const sandboxConfig = {
        enabled: true,
        networkMode: 'blocked',
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.orbstack', '~/.docker', '~/.happy', '~/.happy_remote',
            execMachine ? happyHome : join(homedir(), '.happy-cli-isolated-abp'),
            ...execMachine ? [execRunDir(ctx.run), join(execRunDir(ctx.run), '..')] : [ctx.runDir, join(ctx.runDir, '..')]],
    }
    evidence.sandboxed = sandboxed
    evidence.executionMachine = execMachine ?? 'local'
    evidence.sandboxConfig = sandboxed ? sandboxConfig : null
    evidence.keysSha256 = createHash('sha256').update(readFileSync(join(ctx.runDir, 'keys.json'))).digest('hex')
    if (execMachine) evidence.keysSameOnExecMachine = (await onExecMachine(`sha256sum '${keysFile}'`)).startsWith(String(evidence.keysSha256))

    const { sessionId } = await spawnAgentSession(ctx, `sandbox-${sandboxed ? 'on' : 'off'}`,
        sandboxed ? { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(sandboxConfig) } : {})
    evidence.agentSessionId = sessionId
    save()

    // Independent witness for docker access: any container API use shows up as docker events.
    const since = Math.floor(now() / 1000)
    const prompt = PROMPT_TEMPLATE
        .replaceAll('__KEYS__', keysFile).replaceAll('__HAPPY_HOME__', happyHome).replaceAll('__DOCKER_SOCK__', dockerSock)
        .replaceAll('__NOVNC__', String(env.ports.novncA)).replaceAll('__ADMIN__', String(env.ports.admin))
    const sentAt = now()
    await sessionClient('send', sessionId, prompt)
    const rows = await waitForTranscript(sessionId, (list) => list.some((row) => row.t === 'turn-end' && row.time > sentAt), 600_000)
    const reportText = rows.filter((row) => row.t === 'text' && row.text?.includes('SANDBOX-REPORT')).at(-1)?.text ?? ''
    const json = reportText.slice(reportText.indexOf('{'), reportText.lastIndexOf('}') + 1)
    try { evidence.agentReport = JSON.parse(json) } catch { evidence.agentReportRaw = reportText.slice(0, 2000) }

    const until = Math.floor(now() / 1000)
    const events = execMachine
        ? await onExecMachine(`docker events --since ${since} --until ${until} --format '{{.Type}} {{.Action}} {{.Actor.Attributes.name}}'`)
        : await new Promise<string>((resolve) => {
            const child = spawn('docker', ['events', '--since', String(since), '--until', String(until), '--format', '{{.Type}} {{.Action}} {{.Actor.Attributes.name}}'])
            let out = ''
            child.stdout.on('data', (chunk) => { out += chunk })
            child.on('close', () => resolve(out))
        })
    evidence.dockerEventsDuringRun = events.trim() ? events.trim().split('\n').filter((line) => line.includes('abp-')) : []
    const report = evidence.agentReport as Record<string, { ok: boolean; detail: string }> | undefined
    evidence.keysDigestLeaked = Boolean(report?.read_keys?.detail?.includes(String(evidence.keysSha256).slice(0, 16)))
    save()
    console.log(JSON.stringify({ sandboxed, keysDigestLeaked: evidence.keysDigestLeaked, dockerEvents: (evidence.dockerEventsDuringRun as string[]).length, report: evidence.agentReport ?? 'unparsed' }, null, 1))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})
