/**
 * E2E harness for the Agent Browser PoC (browser-poc vitest project).
 *
 * Brings up the dockerised execution-machine substitute via
 * scripts/browser-poc/poc.mjs (fixture sites, two browser containers, the
 * Runtime container running the bundled runtimeMain) and plays the auth
 * server: it holds the signing keys, mints agent grants and interactive
 * capabilities, and talks to the fixture control/ledger API. None of these
 * secrets are ever given to an agent.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mintAgentGrant, mintInteractiveCapability, type AuthKeys } from '../auth'
import {
    AGENT_OPERATIONS,
    INTERACTIVE_OPERATIONS,
    type AgentSessionId,
    type GrantId,
    type MachineId,
    type Operation,
    type PrincipalId,
    type ProfileId,
    type TaskSpaceId,
    type WorkspaceId,
} from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { fixtureSitePolicies } from '../testing/fixtureSitePolicy'

const here = dirname(fileURLToPath(import.meta.url))
const ISSUE_BACKDATE_MS = 5_000
const packageDir = resolve(here, '../../..')
const pocDir = join(packageDir, 'scripts/browser-poc')

export const SITE_A = 'http://a.poc-one.test:8080'
export const SITE_B = 'http://b.poc-two.test:8080'
export const SITE_C = 'http://c.poc-three.test:8080'
export const PROFILE_A = 'profile-a' as ProfileId
export const PROFILE_B = 'profile-b' as ProfileId
export const PRINCIPAL_A = 'principal-a' as PrincipalId
export const PRINCIPAL_B = 'principal-b' as PrincipalId
export const WORKSPACE = 'workspace-poc' as WorkspaceId
export const MACHINE = 'machine-poc' as MachineId

export interface LedgerEntry {
    run: string
    kind: string
    atMs: number
    [key: string]: unknown
}

interface PocEnvJson {
    /** noVNC ports exist only in the harness viewer layout (`viewer: 'harness'`). */
    ports: { control: number; runtime: number; admin: number; novncA?: number; novncB?: number }
    harnessToken: string
    containers: Record<string, string>
}

export interface GrantOptions {
    principalId?: PrincipalId
    agentSessionId?: string
    profileId?: ProfileId
    allowedOrigins?: string[]
    operations?: Operation[]
    taskSpaceIds?: TaskSpaceId[]
    ttlMs?: number
    grantId?: string
}

export interface PocStack {
    run: string
    runtimeUrl: string
    env: PocEnvJson
    keys: Required<AuthKeys> & { adminToken: string }
    mintAgent(options?: GrantOptions): { token: string; grantId: GrantId }
    mintInteractive(options?: { principalId?: PrincipalId; profileId?: ProfileId; ttlMs?: number; viewerSessionId?: string }): string
    client(token: string): RuntimeClient
    admin<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>
    ledger(): Promise<LedgerEntry[]>
    /** Poll until `predicate(entries)` holds, then keep watching `settleMs` more to catch late duplicates. */
    waitForLedger(predicate: (entries: LedgerEntry[]) => boolean, options?: { timeoutMs?: number; settleMs?: number }): Promise<LedgerEntry[]>
    releaseBarrier(key: string, nonce: string): Promise<void>
    fixtureFault(kind: string, mode: string): Promise<void>
    fault(kind: string, profile?: 'a' | 'b'): void
    waitForRuntime(timeoutMs?: number): Promise<void>
    down(options?: { purge?: boolean }): void
}

function poc(args: string[]): string {
    return execFileSync('node', [join(pocDir, 'poc.mjs'), ...args], { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function buildRuntimeBundle(): string {
    const out = join(pocDir, '.abp', 'runtime.mjs')
    execFileSync('node', [join(pocDir, 'build-runtime.mjs'), out], { cwd: packageDir, stdio: 'pipe' })
    return out
}

/**
 * `viewer: 'runtime'` is the production viewer layout (D2): no noVNC is started or published and
 * the display is reachable only through the Runtime's viewer proxy. The default keeps the harness
 * noVNC for the PoC suites that probe it directly (A11).
 */
export async function startPocStack(options: { run?: string; bundle?: string; viewer?: 'harness' | 'runtime' } = {}): Promise<PocStack> {
    const run = options.run ?? `t${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
    const runDir = join(pocDir, '.abp', run)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    const keys = {
        agentKey: randomBytes(32).toString('hex'),
        interactiveKey: randomBytes(32).toString('hex'),
        adminToken: randomBytes(24).toString('hex'),
    }
    const keysFile = join(runDir, 'keys.json')
    // Readable by the runtime container user; the directory is private to the harness.
    writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o644 })
    const runtimeEnvFile = join(runDir, 'runtime-env.json')
    writeFileSync(runtimeEnvFile, JSON.stringify({
        ABP_STATE_DIR: '/var/lib/abp',
        ABP_KEYS_FILE: '/app/keys.json',
        ABP_PROFILES: JSON.stringify([
            { profileId: PROFILE_A, cdpHttpUrl: 'http://browser-a:9223', instanceUrl: 'http://browser-a:9224/instance', vncAddress: 'browser-a:5900' },
            { profileId: PROFILE_B, cdpHttpUrl: 'http://browser-b:9223', instanceUrl: 'http://browser-b:9224/instance', vncAddress: 'browser-b:5900' },
        ]),
        // Harness mode: the synthetic fixture's explicit site policy (PoC classifier parity).
        ABP_SITE_POLICY: JSON.stringify(fixtureSitePolicies([SITE_A, SITE_B, SITE_C])),
    }), { mode: 0o600 })
    const bundle = options.bundle ?? buildRuntimeBundle()
    poc(['up', '--run', run, '--runtime-bundle', bundle, '--runtime-env', runtimeEnvFile, '--runtime-keys', keysFile, '--viewer', options.viewer ?? 'harness'])
    const env = JSON.parse(readFileSync(join(runDir, 'env.json'), 'utf8')) as PocEnvJson
    const runtimeUrl = `http://127.0.0.1:${env.ports.runtime}`
    const controlUrl = `http://127.0.0.1:${env.ports.control}`

    const control = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${controlUrl}${path}`, {
            method,
            headers: { 'x-harness-token': env.harnessToken, 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!response.ok) throw new Error(`fixture control ${path} → ${response.status}`)
        return response.json() as Promise<Record<string, unknown>>
    }

    const refreshRuntimePorts = () => {
        for (const [name, containerPort] of [['runtime', 8787], ['admin', 8788]] as const) {
            try {
                const mapping = execFileSync('docker', ['port', env.containers.runtime, String(containerPort)], { encoding: 'utf8' }).trim().split('\n')[0]
                env.ports[name] = Number(mapping.split(':').at(-1))
            } catch { /* not running (e.g. after kill-runtime) */ }
        }
        stack.runtimeUrl = `http://127.0.0.1:${env.ports.runtime}`
    }

    const stack: PocStack = {
        run,
        runtimeUrl,
        env,
        keys,
        mintAgent(grant = {}) {
            // Containers can run a few ms behind the host; never mint a token from the future.
            const now = Date.now() - ISSUE_BACKDATE_MS
            const grantId = (grant.grantId ?? `grant-${randomUUID()}`) as GrantId
            const token = mintAgentGrant({
                kind: 'agent-grant',
                grantId,
                principalId: grant.principalId ?? PRINCIPAL_A,
                workspaceId: WORKSPACE,
                machineId: MACHINE,
                agentSessionId: (grant.agentSessionId ?? `agent-${randomUUID()}`) as AgentSessionId,
                profileId: grant.profileId ?? PROFILE_A,
                allowedOrigins: grant.allowedOrigins ?? [SITE_A, SITE_B],
                operations: grant.operations ?? [...AGENT_OPERATIONS],
                taskSpaceIds: grant.taskSpaceIds ?? [],
                issuedAtMs: now,
                expiresAtMs: now + (grant.ttlMs ?? 30 * 60_000),
            }, keys, now)
            return { token, grantId }
        },
        mintInteractive(capability = {}) {
            // Containers can run a few ms behind the host; never mint a token from the future.
            const now = Date.now() - ISSUE_BACKDATE_MS
            return mintInteractiveCapability({
                kind: 'interactive',
                capabilityId: `cap-${randomUUID()}`,
                principalId: capability.principalId ?? PRINCIPAL_A,
                workspaceId: WORKSPACE,
                machineId: MACHINE,
                viewerSessionId: capability.viewerSessionId ?? `viewer-${randomUUID()}`,
                profileId: capability.profileId ?? PROFILE_A,
                operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe', 'cancel', 'resume'],
                issuedAtMs: now,
                expiresAtMs: now + (capability.ttlMs ?? 30 * 60_000),
            }, keys, now)
        },
        client(token) {
            return new RuntimeClient({ baseUrl: stack.runtimeUrl, token })
        },
        async admin(path, body = {}) {
            const response = await fetch(`http://127.0.0.1:${env.ports.admin}${path}`, {
                method: path === '/admin/debug' ? 'GET' : 'POST',
                // Harness plumbing, not a client under test: no pooled socket left behind (the Runtime keeps idle
                // connections 65 s, and A01 waits until no client connection remains).
                headers: { authorization: `Bearer ${keys.adminToken}`, 'content-type': 'application/json', connection: 'close' },
                ...(path === '/admin/debug' ? {} : { body: JSON.stringify(body) }),
            })
            const parsed = await response.json() as { ok: boolean; result?: unknown; error?: unknown }
            if (!parsed.ok) throw new Error(`admin ${path} failed: ${JSON.stringify(parsed.error)}`)
            return parsed.result as never
        },
        async ledger() {
            const body = await control('GET', `/control/ledger?run=${encodeURIComponent(run)}`)
            return body.entries as LedgerEntry[]
        },
        async waitForLedger(predicate, waitOptions = {}) {
            const deadline = Date.now() + (waitOptions.timeoutMs ?? 10_000)
            for (;;) {
                const entries = await stack.ledger()
                if (predicate(entries)) {
                    await new Promise((r) => setTimeout(r, waitOptions.settleMs ?? 500))
                    return stack.ledger()
                }
                if (Date.now() > deadline) return entries
                await new Promise((r) => setTimeout(r, 100))
            }
        },
        async releaseBarrier(key, nonce) {
            await control('POST', '/control/barrier/release', { run, key, nonce })
        },
        async fixtureFault(kind, mode) {
            await control('POST', '/control/fault', { run, kind, mode })
        },
        fault(kind, profile = 'a') {
            poc(['fault', kind, '--run', run, '--profile', profile])
            // A restarted Runtime container may publish on new host ports; clients created afterwards use them.
            if (kind.includes('runtime')) refreshRuntimePorts()
        },
        async waitForRuntime(timeoutMs = 60_000) {
            const deadline = Date.now() + timeoutMs
            while (Date.now() < deadline) {
                try {
                    const response = await fetch(`${stack.runtimeUrl}/v1/health`, { headers: { connection: 'close' } })
                    if (response.ok) {
                        const health = await response.json() as { profiles?: Array<{ connected: boolean }> }
                        if (health.profiles?.every((profile) => profile.connected)) return
                    }
                } catch { /* not up yet */ }
                await new Promise((r) => setTimeout(r, 250))
            }
            throw new Error('runtime did not become healthy')
        },
        down(downOptions = {}) {
            // Debugging aid: leave the run's containers up for inspection.
            if (process.env.ABP_KEEP_STACK === '1') return
            poc(['down', '--run', run, ...(downOptions.purge ? ['--purge'] : [])])
        },
    }
    await stack.waitForRuntime()
    return stack
}
