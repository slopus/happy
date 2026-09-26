/**
 * Shared helpers for the A05/A06/A08/A09/A11 real-stack acceptance suites.
 *
 * Wraps pocStack without changing it:
 * - endpoints are re-read from `docker port` so a killed+started Runtime
 *   container (new ephemeral host ports) keeps working;
 * - interactive capabilities are minted with exactly the operations auth.ts
 *   accepts for that credential kind;
 * - evidence lines never contain tokens or canary values.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { mintAgentGrant, mintInteractiveCapability } from '../auth'
import {
    AGENT_OPERATIONS,
    BrowserRuntimeError,
    type AgentSessionId,
    type GrantId,
    type InputOwner,
    type ActionId,
    type BatchStep,
    type ErrorCode,
    type Operation,
    type PrincipalId,
    type ProfileId,
    type RequestId,
    type StepId,
    type TabId,
    type TaskEvent,
    type TaskId,
    type TaskSpaceId,
    type TaskView,
} from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, type GrantOptions, type LedgerEntry, type PocStack } from './pocStack'

export { decodePng } from '../drivers/pocTestKit'

/** Full acceptance repetition count unless ABP_REPEAT overrides it. */
export function repeat(full: number): number {
    const override = Number(process.env.ABP_REPEAT)
    return Number.isInteger(override) && override > 0 ? override : full
}

export const range = (n: number): number[] => [...Array(n).keys()]
export const rid = (): RequestId => randomUUID() as RequestId
let idCounter = 0
export const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

export function evidence(card: string, data: Record<string, unknown>): void {
    console.log(JSON.stringify({ evidence: { card, ...data } }))
}

// ---------------------------------------------------------------------------
// Endpoints that survive a Runtime container restart
// ---------------------------------------------------------------------------

const endpoints = new Map<string, { runtime: string; admin: string }>()

function dockerPort(container: string, internal: number): number {
    const text = execFileSync('docker', ['port', container, String(internal)], { encoding: 'utf8' })
    const match = /127\.0\.0\.1:(\d+)/.exec(text)
    if (!match) throw new Error(`no loopback port for ${container}:${internal}`)
    return Number(match[1])
}

export function refreshEndpoints(stack: PocStack): { runtime: string; admin: string } {
    const container = `abp-${stack.run}-runtime`
    const value = {
        runtime: `http://127.0.0.1:${dockerPort(container, 8787)}`,
        admin: `http://127.0.0.1:${dockerPort(container, 8788)}`,
    }
    endpoints.set(stack.run, value)
    return value
}

function current(stack: PocStack): { runtime: string; admin: string } {
    return endpoints.get(stack.run) ?? { runtime: stack.runtimeUrl, admin: `http://127.0.0.1:${stack.env.ports.admin}` }
}

/** RuntimeClient whose base URL follows the Runtime container's current port. */
export function client(stack: PocStack, token: string): RuntimeClient {
    return new RuntimeClient({
        baseUrl: 'http://runtime.invalid',
        token,
        fetchImpl: ((url: string, init?: RequestInit) => fetch(String(url).replace('http://runtime.invalid', current(stack).runtime), init)) as typeof fetch,
    })
}

/** Raw HTTP call to the task API (for malformed / unauthenticated requests). */
export async function rawOp(stack: PocStack, op: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } }> {
    const response = await fetch(`${current(stack).runtime}/v1/ops/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() as never }
}

export async function admin<T = unknown>(stack: PocStack, path: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${current(stack).admin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${stack.keys.adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    const parsed = await response.json() as { ok: boolean; result?: unknown; error?: unknown }
    if (!parsed.ok) throw new Error(`admin ${path} failed: ${JSON.stringify(parsed.error)}`)
    return parsed.result as T
}

export async function waitHealthy(stack: PocStack, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const { runtime } = refreshEndpoints(stack)
            const response = await fetch(`${runtime}/v1/health`, { signal: AbortSignal.timeout(2_000) })
            if (response.ok) {
                const health = await response.json() as { profiles?: Array<{ connected: boolean }> }
                if (health.profiles?.every((profile) => profile.connected)) return
            }
        } catch { /* restarting */ }
        await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('runtime did not become healthy after restart')
}

/** kill -9 the Runtime container and start it again on the same state volume. */
export async function restartRuntime(stack: PocStack): Promise<void> {
    stack.fault('kill-runtime')
    stack.fault('start-runtime')
    await waitHealthy(stack)
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Host (harness) and Runtime container clocks can differ by a few ms; auth.ts
 * rejects issuedAtMs in the future, so credentials are back-dated slightly.
 * pocStack.mintAgent uses issuedAtMs = now and fails intermittently on that.
 */
const CLOCK_SKEW_ALLOWANCE_MS = 5_000

export function mintAgent(stack: PocStack, grant: GrantOptions = {}): { token: string; grantId: GrantId; agentSessionId: AgentSessionId } {
    const now = Date.now()
    const issuedAtMs = now - CLOCK_SKEW_ALLOWANCE_MS
    const grantId = (grant.grantId ?? `grant-${randomUUID()}`) as GrantId
    const agentSessionId = (grant.agentSessionId ?? `agent-${randomUUID()}`) as AgentSessionId
    const token = mintAgentGrant({
        kind: 'agent-grant',
        grantId,
        principalId: grant.principalId ?? PRINCIPAL_A,
        workspaceId: WORKSPACE,
        machineId: MACHINE,
        agentSessionId,
        profileId: grant.profileId ?? PROFILE_A,
        allowedOrigins: grant.allowedOrigins ?? [SITE_A, SITE_B],
        operations: grant.operations ?? [...AGENT_OPERATIONS],
        taskSpaceIds: grant.taskSpaceIds ?? [],
        issuedAtMs,
        expiresAtMs: now + (grant.ttlMs ?? 30 * 60_000),
    }, stack.keys, now)
    return { token, grantId, agentSessionId }
}

/**
 * pocStack.mintInteractive adds cancel/resume, which auth.ts rejects for
 * interactive capabilities, so suites mint their own with only accepted ops.
 */
export function mintInteractive(stack: PocStack, options: { principalId?: PrincipalId; profileId?: ProfileId; ttlMs?: number; viewerSessionId?: string; operations?: Operation[] } = {}): { token: string; viewerSessionId: string; capabilityId: string } {
    const now = Date.now()
    const issuedAtMs = now - CLOCK_SKEW_ALLOWANCE_MS
    const viewerSessionId = options.viewerSessionId ?? `viewer-${randomUUID()}`
    const capabilityId = `cap-${randomUUID()}`
    const token = mintInteractiveCapability({
        kind: 'interactive',
        capabilityId,
        principalId: options.principalId ?? PRINCIPAL_A,
        workspaceId: WORKSPACE,
        machineId: MACHINE,
        viewerSessionId,
        profileId: options.profileId ?? PROFILE_A,
        operations: options.operations ?? ['approve', 'takeOver', 'releaseControl', 'getTask', 'subscribe'],
        issuedAtMs,
        expiresAtMs: now + (options.ttlMs ?? 30 * 60_000),
    }, stack.keys, now)
    return { token, viewerSessionId, capabilityId }
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

/**
 * Fixture URL. `ledgerRun` namespaces the fixture ledger/barriers per
 * iteration (the fixture keys both by the page's `run` query value), so each
 * iteration reads only its own writes; defaults to the stack run.
 */
export function pageUrl(stack: PocStack, site: string, path: string, params: Record<string, string> = {}, ledgerRun = stack.run): string {
    const url = new URL(path, site)
    url.searchParams.set('run', ledgerRun)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return url.toString()
}

export interface OpenedTask {
    taskSpaceId: TaskSpaceId
    taskId: TaskId
    tabId: TabId
    version: number
}

export async function newTaskWithPage(c: RuntimeClient, url: string, options: { profileId?: ProfileId; taskSpaceId?: TaskSpaceId } = {}): Promise<OpenedTask> {
    const taskSpaceId = options.taskSpaceId ?? (await c.createSpace({ profileId: options.profileId ?? PROFILE_A, requestId: rid() })).taskSpaceId
    const task = await c.createTask({ taskSpaceId, requestId: rid() })
    const opened = await c.openPage({ taskId: task.taskId, url, requestId: rid() })
    return { taskSpaceId, taskId: task.taskId, tabId: opened.tabId, version: opened.task.stateVersion }
}

export function step(tabId: TabId, kind: BatchStep['kind'], extra: Partial<BatchStep> = {}): BatchStep {
    return {
        stepId: uid('s') as StepId,
        actionId: uid('a') as ActionId,
        tabId,
        kind,
        timeoutMs: kind === 'waitFor' ? 60_000 : 15_000,
        ...extra,
    }
}

/** Awaits a rejected runtime call and asserts its error code. */
export async function expectCode(promise: Promise<unknown>, code: ErrorCode | ErrorCode[], context = ''): Promise<BrowserRuntimeError> {
    let error: unknown
    try {
        const value = await promise
        error = new Error(`${context} expected ${String(code)} but the call succeeded: ${JSON.stringify(value).slice(0, 300)}`)
    } catch (caught) {
        error = caught
    }
    if (!(error instanceof BrowserRuntimeError)) throw error
    const codes = Array.isArray(code) ? code : [code]
    expect(codes, `${context}: got ${error.code} (${error.message})`).toContain(error.code)
    return error
}

/** All events of a task (subscribe from 0, paging on highWatermark). */
export async function allEvents(c: RuntimeClient, taskId: TaskId): Promise<TaskEvent[]> {
    const events: TaskEvent[] = []
    let after = 0
    for (let i = 0; i < 100; i++) {
        const page = await c.subscribe({ taskId, afterSeq: after })
        if (page.kind !== 'events') throw new Error('unexpected snapshot-required for a fresh task')
        events.push(...page.events)
        if (!page.events.length || after >= page.highWatermarkSeq) break
        after = page.events[page.events.length - 1].seq
        if (after >= page.highWatermarkSeq) break
    }
    return events
}

/**
 * Waits until the task view satisfies `predicate`. Interactive clients block
 * on the subscribe long-poll cursor; agent grants (no subscribe operation)
 * poll getTask every 100 ms.
 */
export async function waitForTask(c: RuntimeClient, taskId: TaskId, predicate: (task: TaskView) => boolean, timeoutMs = 30_000): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs
    let canSubscribe = true
    let task = await c.getTask({ taskId })
    while (!predicate(task)) {
        if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach expected state; last status=${task.status} pause=${task.pauseReason ?? ''} wait=${task.waitReason ?? ''}`)
        if (canSubscribe) {
            try {
                await c.subscribe({ taskId, afterSeq: task.highWatermarkSeq }, { waitMs: Math.min(5_000, Math.max(1, deadline - Date.now())) })
            } catch (error) {
                if ((error as BrowserRuntimeError).code !== 'SCOPE_DENIED') throw error
                canSubscribe = false
            }
        } else {
            await new Promise((r) => setTimeout(r, 100))
        }
        task = await c.getTask({ taskId })
    }
    return task
}

export const ofKind = (entries: LedgerEntry[], kind: string): LedgerEntry[] => entries.filter((entry) => entry.kind === kind)

/** Ledger entries of a kind whose field matches (e.g. click target). */
export function count(entries: LedgerEntry[], kind: string, match: Record<string, unknown> = {}): number {
    return entries.filter((entry) => entry.kind === kind && Object.entries(match).every(([k, v]) => entry[k] === v)).length
}

async function control(stack: PocStack, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${stack.env.ports.control}${path}`, {
        method,
        headers: { 'x-harness-token': stack.env.harnessToken, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`fixture control ${path} -> ${response.status}`)
    return response.json() as Promise<Record<string, unknown>>
}

/** Per-iteration ledger namespace (see pageUrl). */
export function ledgerRun(stack: PocStack, label: string): string {
    return `${stack.run}-${label}`
}

export async function ledgerOf(stack: PocStack, run: string): Promise<LedgerEntry[]> {
    return (await control(stack, 'GET', `/control/ledger?run=${encodeURIComponent(run)}`)).entries as LedgerEntry[]
}

/** Poll the fixture ledger until `predicate` holds, then watch `settleMs` more for late/duplicate writes. */
export async function waitLedger(stack: PocStack, run: string, predicate: (entries: LedgerEntry[]) => boolean, options: { timeoutMs?: number; settleMs?: number } = {}): Promise<LedgerEntry[]> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    for (;;) {
        const entries = await ledgerOf(stack, run)
        if (predicate(entries)) {
            await new Promise((r) => setTimeout(r, options.settleMs ?? 500))
            return ledgerOf(stack, run)
        }
        if (Date.now() > deadline) return entries
        await new Promise((r) => setTimeout(r, 100))
    }
}

/** Absence proof: wait a settle window and return the ledger (hang guard, not a sync point). */
export async function settledLedger(stack: PocStack, run: string, settleMs = 1_000): Promise<LedgerEntry[]> {
    await new Promise((r) => setTimeout(r, settleMs))
    return ledgerOf(stack, run)
}

export async function releaseBarrier(stack: PocStack, run: string, key: string, nonce: string): Promise<void> {
    await control(stack, 'POST', '/control/barrier/release', { run, key, nonce })
}

export async function fixtureFault(stack: PocStack, run: string, kind: 'risky' | 'answer', mode: string): Promise<void> {
    await control(stack, 'POST', '/control/fault', { run, kind, mode })
}

export function docker(args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Brings every task of a space to a terminal state (agent cancel, then trusted
 * reconciliation of uncertain actions as confirmed) and closes the space, so
 * the 2-spaces-per-profile / 6-tab quotas never leak between iterations.
 * Returns an error string instead of throwing so tests assert it explicitly.
 */
export async function cleanupSpace(stack: PocStack, c: RuntimeClient, taskSpaceId: TaskSpaceId, taskIds: TaskId[]): Promise<string | undefined> {
    const reconcileErrors: string[] = []
    const reconciled = new Set<string>()
    // Stop every task, then (trusted harness path) settle each uncertain action. A cancelled
    // in-flight driver call can turn uncertain only after it unwinds, so this runs again on
    // every retry instead of once up front.
    const settle = async () => {
        for (const taskId of taskIds) {
            try {
                let task = await c.getTask({ taskId })
                if (!['succeeded', 'failed', 'cancelled'].includes(task.status) && !task.cancelRequested) task = (await c.cancel({ taskId, requestId: rid() })).task
                for (const actionId of task.uncertainActions) {
                    if (reconciled.has(`${taskId}/${actionId}`)) continue
                    reconciled.add(`${taskId}/${actionId}`)
                    await admin(stack, '/admin/reconcile-action', { taskId, actionId, confirmed: true }).catch((error: Error) => reconcileErrors.push(error.message.slice(0, 160)))
                }
            } catch { /* reported by closeSpace below */ }
        }
    }
    let last = ''
    for (let attempt = 0; attempt < 40; attempt++) {
        await settle()
        try {
            await c.closeSpace({ taskSpaceId, requestId: rid() })
            return undefined
        } catch (error) {
            const e = error as BrowserRuntimeError
            last = `${e.code}: ${e.message}`
            if (e.code !== 'CONFLICT') return last
            await new Promise((r) => setTimeout(r, 250))
        }
    }
    const states = await Promise.all(taskIds.map((taskId) => c.getTask({ taskId }).then((t) => `${t.status}/${t.pauseReason ?? ''}/uncertain=${t.uncertainActions.length}`).catch(() => '?')))
    return `${last} [tasks: ${states.join(', ')}]${reconcileErrors.length ? ` [reconcile: ${reconcileErrors.join('; ')}]` : ''}`
}

/**
 * Harness-only: bring a target to the front of the browser window, i.e. make
 * it the tab the user sees in the viewer. Uses the browser container's
 * internal DevTools HTTP endpoint via docker exec (never exposed to the host
 * or to the agent).
 */
export function activateTargetAsUser(stack: PocStack, profile: 'a' | 'b', targetId: string): void {
    if (!/^[A-F0-9]{16,64}$/i.test(targetId)) throw new Error('unexpected target id')
    const out = docker(['exec', `abp-${stack.run}-browser-${profile}`, 'curl', '-fsS', `http://127.0.0.1:9222/json/activate/${targetId}`])
    if (!/activated/i.test(out)) throw new Error(`activate failed: ${out}`)
}

/** Latest lease epoch in the task's events (what a viewer UI would show). Needs an interactive client (subscribe). */
export async function latestEpoch(c: RuntimeClient, taskId: TaskId): Promise<number> {
    const events = await allEvents(c, taskId)
    return events.reduce((max, event) => Math.max(max, event.leaseEpoch), 0)
}

/** Polls observe until the page text contains `text` (condition-based, not a sleep). */
export async function observeUntil(c: RuntimeClient, taskId: TaskId, tabId: TabId, predicate: (o: Awaited<ReturnType<RuntimeClient['observe']>>) => boolean, timeoutMs = 15_000): Promise<Awaited<ReturnType<RuntimeClient['observe']>>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const observation = await c.observe({ taskId, tabId })
        if (predicate(observation)) return observation
        if (Date.now() > deadline) throw new Error(`observe condition not met; text=${observation.text.slice(0, 120)}`)
        await new Promise((r) => setTimeout(r, 100))
    }
}

/** Container logs (stdout + stderr; the Runtime logs to stderr). */
export function containerLogs(stack: PocStack, name: string): string {
    return execFileSync('docker', ['logs', `abp-${stack.run}-${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) +
        execFileSync('sh', ['-c', 'docker logs "$0" 2>&1 >/dev/null', `abp-${stack.run}-${name}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** The tab's current lease as exposed by TaskView.tabLeases. */
export async function tabLease(c: RuntimeClient, taskId: TaskId, tabId: TabId): Promise<{ leaseEpoch: number; owner: InputOwner }> {
    const lease = (await c.getTask({ taskId })).tabLeases?.find((l) => l.tabId === tabId)
    if (!lease) throw new Error('TaskView.tabLeases has no entry for the tab')
    return lease
}

/** After a settling takeOver ACK: wait until the user actually owns the tab (in-flight driver call settled). */
export async function waitUserOwner(c: RuntimeClient, taskId: TaskId, tabId: TabId, timeoutMs = 35_000): Promise<{ leaseEpoch: number; waitedMs: number }> {
    const started = Date.now()
    await waitForTask(c, taskId, (t) => t.tabLeases?.find((l) => l.tabId === tabId)?.owner.kind === 'user', timeoutMs)
    return { leaseEpoch: (await tabLease(c, taskId, tabId)).leaseEpoch, waitedMs: Date.now() - started }
}
