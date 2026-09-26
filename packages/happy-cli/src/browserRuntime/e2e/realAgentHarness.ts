/**
 * Shared plumbing for the real-agent PoC runs (A01, A08): an isolated Happy
 * daemon spawns a real agent session, the harness plays the auth server
 * (grants/capabilities) and the user client (Desktop's own CLI session code in
 * a separate short-lived process), and reads independent evidence from the
 * fixture ledger and the Runtime journal.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mintAgentGrant, mintInteractiveCapability, signServerCapability } from '../auth'
import { AGENT_OPERATIONS, INTERACTIVE_OPERATIONS, type AgentSessionId, type GrantId } from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE } from './pocStack'

const execFileAsync = promisify(execFile)

export const now = () => Date.now()
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface TranscriptRow { seq: number; time: number; t: string; name?: string; text?: string }

export interface RunContext {
    run: string
    runDir: string
    env: { ports: { control: number; runtime: number }; harnessToken: string }
    keys: { agentKey: string; interactiveKey: string }
    /** Where the harness reaches the Runtime (the execution machine's address when it is separate). */
    runtimeUrl: string
    /** Where the agent reaches the Runtime from its own machine. */
    agentRuntimeUrl: string
}

/**
 * Separate execution machine H (OrbStack Linux machine): the stack, the Happy daemon
 * and the agent run there; this process plays the auth server and the user's client.
 * ABP_EXEC_MACHINE = orb machine name, ABP_EXEC_HOST = its address.
 */
export const execMachine = process.env.ABP_EXEC_MACHINE

/**
 * Production layout on H (installed by abp-install): the Runtime issues agent grants to the
 * daemon's sessions itself (broker socket), and only server-signed (abp2) interactive
 * capabilities are accepted. The harness then signs capabilities with a TEST issuer key whose
 * public half was installed as a trusted issuer on H, standing in for the Saycode server.
 */
export const prodIdentity = process.env.ABP_PROD_MACHINE_ID ? {
    machineId: process.env.ABP_PROD_MACHINE_ID,
    principalId: requiredHarnessEnv('ABP_PROD_PRINCIPAL'),
    workspaceId: requiredHarnessEnv('ABP_PROD_WORKSPACE'),
    profileId: process.env.ABP_PROD_PROFILE ?? 'main',
    issuerKid: requiredHarnessEnv('ABP_TEST_ISSUER_KID'),
    issuerKeyFile: requiredHarnessEnv('ABP_TEST_ISSUER_KEY_FILE'),
} : undefined

function requiredHarnessEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required with ABP_PROD_MACHINE_ID`)
    return value
}
const execHost = () => process.env.ABP_EXEC_HOST ?? '127.0.0.1'
export const execHappyHome = () => process.env.ABP_EXEC_HAPPY_HOME ?? '/home/agent/.happy-cli-isolated-abp/home'
export const execUser = () => process.env.ABP_EXEC_USER ?? 'agent'

/**
 * fetch for calls from this machine to H. macOS Local Network privacy blocks the
 * harness' node process from LAN addresses (EHOSTUNREACH) while the system curl
 * is allowed, so requests go through curl; headers and body travel on stdin
 * (curl config), never on the command line.
 */
export const execFetch: typeof fetch = (input, init = {}) => new Promise((resolve, reject) => {
    const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
    const headers = new Headers(init.headers)
    const config = [
        `url = ${quote(String(input))}`,
        `request = ${quote(init.method ?? 'GET')}`,
        ...[...headers].map(([key, value]) => `header = ${quote(`${key}: ${value}`)}`),
        ...init.body !== undefined && init.body !== null ? [`data-binary = ${quote(String(init.body))}`] : [],
        'silent', 'show-error', 'max-time = 180', `write-out = "\\n%{http_code}"`,
    ].join('\n')
    const child = spawn('/usr/bin/curl', ['-K', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
        if (code !== 0) return reject(new TypeError(`fetch failed (curl ${code}): ${err.trim().slice(0, 200)}`))
        const split = out.lastIndexOf('\n')
        resolve(new Response(out.slice(0, split), { status: Number(out.slice(split + 1)) }))
    })
    child.stdin.end(config)
})
const harnessFetch: typeof fetch = (input, init) => execMachine ? execFetch(input, init) : fetch(input, init)

/** Run a root shell script on the execution machine, optionally feeding stdin. */
export function onExecMachine(script: string, stdin?: string): Promise<string> {
    if (!execMachine) throw new Error('ABP_EXEC_MACHINE is not set')
    return new Promise((resolve, reject) => {
        const child = spawn('orb', ['-m', execMachine, '-u', 'root', 'bash', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => { out += chunk })
        child.stderr.on('data', (chunk) => { err += chunk })
        child.on('error', reject)
        child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`exec machine script failed (${code}): ${err.slice(0, 300)}`)))
        child.stdin.end(stdin ?? '')
    })
}

/** The stack's harness-only run directory on the execution machine (root-only there). */
export const execRunDir = (run: string) => `${process.env.ABP_EXEC_RUN_ROOT ?? '/opt/happy/packages/happy-cli/scripts/browser-poc/.abp'}/${run}`

const daemonCall = (path: string) => `S=${execHappyHome()}/daemon.state.json; `
    + `curl -fsS -X POST -H "authorization: Bearer $(jq -r .controlSecret $S)" -H 'content-type: application/json' `
    + `--data-binary @- "http://127.0.0.1:$(jq -r .httpPort $S)${path}"`

/** Session ids the execution machine's daemon is tracking right now. */
export async function execDaemonSessions(): Promise<string[]> {
    const list = JSON.parse(await onExecMachine(daemonCall('/list'), '{}')) as { children: Array<{ happySessionId: string }> }
    return list.children.map((child) => child.happySessionId)
}

export function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {}
    for (let index = 0; index < argv.length; index++) {
        if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1]
    }
    return args
}

export function loadRun(run: string): RunContext {
    const runDir = join(import.meta.dirname, '../../../scripts/browser-poc/.abp', run)
    const env = JSON.parse(readFileSync(join(runDir, 'env.json'), 'utf8'))
    const keys = JSON.parse(readFileSync(join(runDir, 'keys.json'), 'utf8'))
    return { run, runDir, env, keys, runtimeUrl: `http://${execHost()}:${env.ports.runtime}`, agentRuntimeUrl: `http://127.0.0.1:${env.ports.runtime}` }
}

/** Evidence file that is rewritten after every step, so a harness failure never loses what happened. */
export function evidenceFile(path: string): { data: Record<string, unknown>; save(): void } {
    const data: Record<string, unknown> = {}
    const save = () => writeFileSync(path, JSON.stringify(data, null, 2))
    process.on('exit', save)
    return { data, save }
}

const happyHome = () => process.env.ABP_HAPPY_HOME ?? join(homedir(), '.happy-cli-isolated-abp/home')
const clientDir = () => process.env.ABP_SESSION_CLIENT_DIR ?? '/Users/justin/workspace/aplus-dev-studio-desktop/.aplus/worktrees/abp-desktop'

/** Mint an agent grant bound to one agent session and put it where that session reads it. */
export async function writeAgentGrant(ctx: RunContext, agentSessionId: string, label: string, file: string): Promise<GrantId> {
    const issuedAt = now()
    const grantId = `grant-${ctx.run}-${label}` as GrantId
    const token = mintAgentGrant({
        kind: 'agent-grant', grantId, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: agentSessionId as AgentSessionId, profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B],
        operations: [...AGENT_OPERATIONS], taskSpaceIds: [], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 55 * 60_000,
    }, ctx.keys, issuedAt)
    if (execMachine) {
        await onExecMachine(`umask 077; install -d -o ${execUser()} -m 700 "$(dirname '${file}')"; cat > '${file}'; chown ${execUser()} '${file}'; chmod 600 '${file}'`, token)
    } else {
        writeFileSync(file, token, { mode: 0o600 })
    }
    return grantId
}

/** Spawn a real agent session through the isolated daemon and bind an agent grant to it. */
export async function spawnAgentSession(ctx: RunContext, label: string, extraEnv: Record<string, string> = {}): Promise<{ sessionId: string; grantId: GrantId }> {
    let spawned: { success: boolean; sessionId: string }
    let grantFile: string
    if (execMachine && prodIdentity) {
        // The daemon registers the session with the Runtime broker; no grant file, no Runtime env.
        const workspace = `/work/${ctx.run}-${label}`
        await onExecMachine(`install -d -o ${execUser()} -g abp-work -m 2770 '${workspace}'`)
        const spawned = JSON.parse(await onExecMachine(daemonCall('/spawn-session'), JSON.stringify({ directory: workspace, agent: 'claude', environmentVariables: extraEnv })))
        if (!spawned.success) throw new Error('spawn failed')
        return { sessionId: spawned.sessionId, grantId: 'broker' as GrantId }
    }
    if (execMachine) {
        const workspace = `/home/${execUser()}/abp-poc-agent-ws/${ctx.run}-${label}`
        grantFile = `/home/${execUser()}/abp-grants/${ctx.run}-${label}.token`
        await onExecMachine(`install -d -o ${execUser()} -m 700 '${workspace}'`)
        spawned = JSON.parse(await onExecMachine(daemonCall('/spawn-session'), JSON.stringify({
            directory: workspace,
            agent: 'claude',
            environmentVariables: { ...extraEnv, HAPPY_BROWSER_TASK_RUNTIME_URL: ctx.agentRuntimeUrl, HAPPY_BROWSER_TASK_GRANT_FILE: grantFile },
        })))
    } else {
        const daemon = JSON.parse(readFileSync(join(happyHome(), 'daemon.state.json'), 'utf8'))
        const workspace = join(homedir(), 'abp-poc-agent-ws', `${ctx.run}-${label}`)
        mkdirSync(workspace, { recursive: true })
        const grantDir = join(happyHome(), '..', 'grants')
        mkdirSync(grantDir, { recursive: true, mode: 0o700 })
        grantFile = join(grantDir, `${ctx.run}-${label}.token`)
        const response = await fetch(`http://127.0.0.1:${daemon.httpPort}/spawn-session`, {
            method: 'POST',
            headers: { authorization: `Bearer ${daemon.controlSecret}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                directory: workspace,
                agent: 'claude',
                environmentVariables: { ...extraEnv, HAPPY_BROWSER_TASK_RUNTIME_URL: ctx.agentRuntimeUrl, HAPPY_BROWSER_TASK_GRANT_FILE: grantFile },
            }),
        })
        spawned = await response.json() as { success: boolean; sessionId: string }
    }
    if (!spawned.success) throw new Error('spawn failed')
    const grantId = await writeAgentGrant(ctx, spawned.sessionId, label, grantFile)
    return { sessionId: spawned.sessionId, grantId }
}

/** The user's reconnecting client with an interactive capability (approve/takeover + read). */
export function userClient(ctx: RunContext, viewerSessionId: string): RuntimeClient {
    const issuedAt = now()
    if (prodIdentity) {
        const token = signServerCapability({
            kind: 'interactive', capabilityId: `cap-${ctx.run}-${viewerSessionId}-${issuedAt}`, principalId: prodIdentity.principalId as never,
            workspaceId: prodIdentity.workspaceId as never, machineId: prodIdentity.machineId as never, viewerSessionId,
            profileId: prodIdentity.profileId as never, aud: prodIdentity.machineId, iss: 'saycode-server',
            operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe', 'cancel', 'resume', 'listTasks'], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 5 * 60_000,
        }, { kid: prodIdentity.issuerKid, privateKey: readFileSync(prodIdentity.issuerKeyFile, 'utf8') })
        return new RuntimeClient({ baseUrl: ctx.runtimeUrl, token, fetchImpl: harnessFetch })
    }
    const token = mintInteractiveCapability({
        kind: 'interactive', capabilityId: `cap-${ctx.run}-${viewerSessionId}-${issuedAt}`, principalId: PRINCIPAL_A,
        workspaceId: WORKSPACE, machineId: MACHINE, viewerSessionId, profileId: PROFILE_A,
        operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe'], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 10 * 60_000,
    }, ctx.keys, issuedAt)
    return new RuntimeClient({ baseUrl: ctx.runtimeUrl, token, fetchImpl: harnessFetch })
}

function clientEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of ['SAYCODE_AGENT_ENV', 'SAYCODE_AGENT_ROOT', 'HAPPY_HOME_DIR']) delete env[key]
    return env
}

/** Desktop's own CLI session code, run as a separate short-lived client process. */
export async function sessionClient(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('node_modules/.bin/vite-node',
        ['--config', 'vite.cli.config.ts', '.abp-harness/sessionClient.ts', ...args],
        { cwd: clientDir(), env: clientEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    return stdout
}

export async function clientProcessCount(): Promise<number> {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'sessionClient.ts']).catch(() => ({ stdout: '' }))
    return stdout.trim() ? stdout.trim().split('\n').length : 0
}

/** User-role text messages of a session (e.g. a re-invocation delivered by H's daemon), oldest first. */
export async function userTexts(sessionId: string): Promise<string[]> {
    const raw = await sessionClient('read', sessionId, '200')
    const messages = JSON.parse(raw.trim().split('\n').at(-1)!.replace(/[\u0000-\u001f]/g, ' ')) as Array<{ content: { role?: string; content?: { type?: string; text?: string } } }>
    return messages.filter((message) => message.content?.role === 'user' && typeof message.content.content?.text === 'string').map((message) => message.content.content!.text!)
}

export async function transcript(sessionId: string): Promise<TranscriptRow[]> {
    const raw = await sessionClient('read', sessionId, '200')
    const messages = JSON.parse(raw.trim().split('\n').at(-1)!.replace(/[\u0000-\u001f]/g, ' ')) as Array<{
        seq: number
        content: { content?: { time?: number; ev?: Record<string, unknown> } }
    }>
    return messages.flatMap((message) => {
        const ev = message.content.content?.ev
        if (!ev) return []
        return [{
            seq: message.seq,
            time: message.content.content?.time ?? 0,
            t: String(ev.t),
            name: ev.name as string | undefined,
            text: typeof ev.text === 'string' ? ev.text : undefined,
        }]
    })
}

export async function waitForTranscript(sessionId: string, predicate: (rows: TranscriptRow[]) => boolean, timeoutMs: number): Promise<TranscriptRow[]> {
    let rows: TranscriptRow[] = []
    for (const deadline = now() + timeoutMs; now() < deadline;) {
        rows = await transcript(sessionId)
        if (predicate(rows)) return rows
        await sleep(2_000)
    }
    return rows
}

export async function fixtureControl(ctx: RunContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    // Installed H: the fixture sits on the browser bridge, whose egress rules only answer the
    // host itself, so control goes through a root shell on H (token and body on stdin).
    const fixtureOnExec = process.env.ABP_FIXTURE_CONTROL_URL
    if (fixtureOnExec && execMachine) {
        const config = [`url = "${fixtureOnExec}${path}"`, `request = "${method}"`, `header = "x-harness-token: ${ctx.env.harnessToken}"`,
            'header = "content-type: application/json"', ...body ? [`data-binary = ${JSON.stringify(JSON.stringify(body))}`] : [], 'silent', 'max-time = 30'].join('\n')
        // A rare empty reply from the orb exec relay is retried for reads; a real error body still parses.
        for (let attempt = 1; ; attempt++) {
            const out = await onExecMachine('curl -K -', config)
            if (out.trim() || method !== 'GET' || attempt === 3) return JSON.parse(out) as Record<string, unknown>
            await sleep(500)
        }
    }
    const response = await harnessFetch(`http://${execHost()}:${ctx.env.ports.control}${path}`, {
        method,
        headers: { 'x-harness-token': ctx.env.harnessToken, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return response.json() as Promise<Record<string, unknown>>
}

export async function ledger(ctx: RunContext): Promise<Array<Record<string, unknown>>> {
    return (await fixtureControl(ctx, 'GET', `/control/ledger?run=${encodeURIComponent(ctx.run)}`)).entries as Array<Record<string, unknown>>
}
