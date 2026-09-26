/**
 * Shared helpers for the A01/A03/A07/A10 real-stack suites.
 *
 * Wraps pocStack without changing it: clients whose HTTP connections the test
 * can destroy (so "no client connected" is observable), runtime port re-reads
 * after a container restart, connection counting inside the Runtime container,
 * event cursors and best-effort task cleanup.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import {
    BrowserRuntimeError,
    type ActionId, type ApproveResult, type BatchResult, type ElementRef, type RequestId, type StepId, type TabId,
    type TaskEvent, type TaskId, type TaskSpaceId, type TaskView,
} from '../contracts'
import { mintAgentGrant, mintInteractiveCapability } from '../auth'
import {
    AGENT_OPERATIONS, INTERACTIVE_OPERATIONS,
    type AgentSessionId, type GrantId, type Operation, type PrincipalId, type ProfileId,
} from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, startPocStack, type LedgerEntry, type PocStack } from './pocStack'

export const rid = () => randomUUID() as RequestId
export const sid = (value: string) => value as StepId
export const aid = (value: string) => `${value}-${randomBytes(4).toString('hex')}` as ActionId

/** Iteration count: acceptance default unless ABP_REPEAT overrides it. */
export function repeat(defaultCount: number): number[] {
    const override = Number(process.env.ABP_REPEAT)
    const count = Number.isInteger(override) && override > 0 ? override : defaultCount
    return Array.from({ length: count }, (_, index) => index)
}

/** One JSON evidence line per observation. Callers never pass tokens or canary values. */
export function evidence(card: string, data: Record<string, unknown>): void {
    console.log(JSON.stringify({ evidence: { card, atMs: Date.now(), ...data } }))
}

export async function expectCode(promise: Promise<unknown>, code: string, context: string): Promise<BrowserRuntimeError> {
    try {
        await promise
    } catch (error) {
        if (error instanceof BrowserRuntimeError && error.code === code) return error
        throw new Error(`${context}: expected ${code}, got ${error instanceof BrowserRuntimeError ? error.code : String(error)}`)
    }
    throw new Error(`${context}: expected ${code}, but the call succeeded`)
}

// ---------------------------------------------------------------------------
// Closable HTTP client
// ---------------------------------------------------------------------------

/**
 * fetch over node:http with a private keep-alive agent. `destroy()` aborts
 * in-flight requests and closes every socket, so the Runtime sees the client go
 * away (global fetch would keep pooled sockets we cannot close).
 */
export function closableFetch(): { fetchImpl: typeof fetch; destroy(): void } {
    const agent = new http.Agent({ keepAlive: true })
    const pending = new Set<http.ClientRequest>()
    let destroyed = false
    const fetchImpl = ((input: string | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        if (destroyed) return reject(new Error('client destroyed'))
        const request = http.request(new URL(String(input)), {
            method: init?.method ?? 'GET',
            headers: init?.headers as Record<string, string> | undefined,
            agent,
        }, (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => {
                pending.delete(request)
                resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 }))
            })
            response.on('error', (error) => { pending.delete(request); reject(error) })
        })
        pending.add(request)
        request.on('error', (error) => { pending.delete(request); reject(error) })
        request.end(init?.body as string | undefined)
    })) as typeof fetch
    return {
        fetchImpl,
        destroy() {
            destroyed = true
            for (const request of pending) request.destroy()
            pending.clear()
            agent.destroy()
        },
    }
}

export interface ClosableClient {
    client: RuntimeClient
    close(): void
}

// ---------------------------------------------------------------------------
// Suite stack
// ---------------------------------------------------------------------------

export interface SuiteStack {
    stack: PocStack
    run: string
    /** Current task API base URL; re-read after a Runtime container restart. */
    runtimeUrl(): string
    adminUrl(): string
    refreshPorts(): void
    /** New client with its own sockets. Every client is closed by closeAll(). */
    client(token: string): ClosableClient
    closeAll(): void
    admin<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>
    waitForHealth(timeoutMs?: number): Promise<{ pid: number; startedAtMs: number }>
    /**
     * Grants/capabilities issued CLOCK_SKEW_MS in the past. The Runtime rejects
     * issuedAtMs > now with zero tolerance, and the container clock can trail
     * the host by a few ms (observed: pocStack.mintAgent tokens rejected as
     * "outside its lifetime" on the first call).
     */
    mintAgent(options?: { profileId?: ProfileId; agentSessionId?: string; ttlMs?: number; allowedOrigins?: string[]; operations?: Operation[] }): { token: string; grantId: GrantId; agentSessionId: AgentSessionId }
    mintInteractive(options?: { ttlMs?: number; principalId?: PrincipalId; profileId?: ProfileId }): string
    down(): void
}

export const CLOCK_SKEW_MS = 5_000

const runtimeContainer = (run: string) => `abp-${run}-runtime`

function dockerPort(container: string, internal: number): number {
    const text = execFileSync('docker', ['port', container, String(internal)], { encoding: 'utf8' })
    const match = text.match(/127\.0\.0\.1:(\d+)/)
    if (!match) throw new Error(`no loopback port for ${container}:${internal}`)
    return Number(match[1])
}

export async function startSuiteStack(prefix: string): Promise<SuiteStack> {
    const run = `e2ea-${prefix}-${Date.now().toString(36)}`
    const stack = await startPocStack({ run })
    let ports = { runtime: stack.env.ports.runtime, admin: stack.env.ports.admin }
    const clients = new Set<ClosableClient>()
    const suite: SuiteStack = {
        stack,
        run,
        runtimeUrl: () => `http://127.0.0.1:${ports.runtime}`,
        adminUrl: () => `http://127.0.0.1:${ports.admin}`,
        refreshPorts() {
            ports = { runtime: dockerPort(runtimeContainer(run), 8787), admin: dockerPort(runtimeContainer(run), 8788) }
        },
        client(token) {
            const transport = closableFetch()
            const entry: ClosableClient = {
                client: new RuntimeClient({ baseUrl: suite.runtimeUrl(), token, fetchImpl: transport.fetchImpl, retryDelayMs: 200 }),
                close() { transport.destroy(); clients.delete(entry) },
            }
            clients.add(entry)
            return entry
        },
        closeAll() {
            for (const entry of [...clients]) entry.close()
        },
        async admin(path, body = {}) {
            const transport = closableFetch()
            try {
                const response = await transport.fetchImpl(`${suite.adminUrl()}${path}`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${stack.keys.adminToken}`, 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                })
                const parsed = await response.json() as { ok: boolean; result?: unknown; error?: { code?: string } }
                if (!parsed.ok) throw new BrowserRuntimeError((parsed.error?.code ?? 'RUNTIME_UNAVAILABLE') as never, `admin ${path} failed`)
                return parsed.result as never
            } finally {
                transport.destroy()
            }
        },
        async waitForHealth(timeoutMs = 60_000) {
            const deadline = Date.now() + timeoutMs
            let lastError = ''
            while (Date.now() < deadline) {
                const transport = closableFetch()
                try {
                    suite.refreshPorts()
                    const response = await transport.fetchImpl(`${suite.runtimeUrl()}/v1/health`)
                    if (response.ok) {
                        const health = await response.json() as { pid: number; startedAtMs: number; profiles?: Array<{ connected: boolean }> }
                        if (health.profiles?.every((profile) => profile.connected)) return health
                        lastError = 'profiles not connected'
                    }
                } catch (error) {
                    lastError = error instanceof Error ? error.message : String(error)
                } finally {
                    transport.destroy()
                }
                // A Runtime that exited (e.g. refused the writer lock) will not come back by itself.
                if (Date.now() > deadline - timeoutMs + 5_000 && containerState(run).startsWith('exited')) {
                    throw new Error(`runtime container exited instead of becoming healthy (${containerState(run)})`)
                }
                await new Promise((resolve) => setTimeout(resolve, 250))
            }
            throw new Error(`runtime did not become healthy within ${timeoutMs} ms (${lastError}); container state: ${containerState(run)}`)
        },
        mintAgent(options = {}) {
            const issuedAtMs = Date.now() - CLOCK_SKEW_MS
            const grantId = `grant-${randomUUID()}` as GrantId
            const agentSessionId = (options.agentSessionId ?? `agent-${randomUUID()}`) as AgentSessionId
            const token = mintAgentGrant({
                kind: 'agent-grant', grantId, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE, agentSessionId,
                profileId: options.profileId ?? PROFILE_A, allowedOrigins: options.allowedOrigins ?? [SITE_A, SITE_B],
                operations: options.operations ?? [...AGENT_OPERATIONS], taskSpaceIds: [],
                issuedAtMs, expiresAtMs: issuedAtMs + CLOCK_SKEW_MS + (options.ttlMs ?? 30 * 60_000),
            }, stack.keys, issuedAtMs)
            return { token, grantId, agentSessionId }
        },
        mintInteractive(options = {}) {
            const issuedAtMs = Date.now() - CLOCK_SKEW_MS
            return mintInteractiveCapability({
                kind: 'interactive', capabilityId: `cap-${randomUUID()}`, principalId: options.principalId ?? PRINCIPAL_A,
                workspaceId: WORKSPACE, machineId: MACHINE, viewerSessionId: `viewer-${randomUUID()}`, profileId: options.profileId ?? PROFILE_A,
                operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe'],
                issuedAtMs, expiresAtMs: issuedAtMs + CLOCK_SKEW_MS + (options.ttlMs ?? 30 * 60_000),
            }, stack.keys, issuedAtMs)
        },
        down() {
            suite.closeAll()
            stack.down({ purge: true })
        },
    }
    return suite
}

export function containerState(run: string): string {
    try {
        return execFileSync('docker', ['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}', runtimeContainer(run)], { encoding: 'utf8' }).trim()
    } catch {
        return 'unknown'
    }
}

/** Last lines of the Runtime container log (Runtime logs carry no tokens). */
export function runtimeLogTail(run: string, lines = 20): string {
    const result = spawnSync('docker', ['logs', '--tail', String(lines), runtimeContainer(run)], { encoding: 'utf8' })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

/** Container identity used as the runtime fingerprint stand-in: id + StartedAt. */
export function containerFingerprint(container: string): string {
    return execFileSync('docker', ['inspect', '-f', '{{.Id}}/{{.State.StartedAt}}', container], { encoding: 'utf8' }).trim()
}

/**
 * Established TCP connections to the Runtime task API (8787) and admin API
 * (8788), read from the Runtime container's own network namespace.
 */
export function runtimeConnections(run: string): number {
    const text = execFileSync('docker', ['exec', runtimeContainer(run), 'cat', '/proc/net/tcp', '/proc/net/tcp6'], { encoding: 'utf8' })
    let count = 0
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4 || fields[0] === 'sl') continue
        const localPort = fields[1].split(':').at(-1)
        if ((localPort === '2253' || localPort === '2254') && fields[3] === '01') count += 1
    }
    return count
}

export async function waitForNoRuntimeConnections(run: string, timeoutMs = 15_000): Promise<{ atMs: number; polls: number }> {
    const deadline = Date.now() + timeoutMs
    for (let polls = 1; ; polls++) {
        const count = runtimeConnections(run)
        if (count === 0) return { atMs: Date.now(), polls }
        if (Date.now() > deadline) throw new Error(`runtime still has ${count} established client connection(s) after ${timeoutMs} ms`)
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}

// ---------------------------------------------------------------------------
// Tasks, events, approvals
// ---------------------------------------------------------------------------

export async function eventsUntil(
    client: RuntimeClient,
    taskId: TaskId,
    afterSeq: number,
    done: (events: TaskEvent[]) => boolean,
    timeoutMs = 30_000,
): Promise<TaskEvent[]> {
    const deadline = Date.now() + timeoutMs
    const events: TaskEvent[] = []
    let cursor = afterSeq
    for (;;) {
        const page = await client.subscribe({ taskId, afterSeq: cursor }, { waitMs: Math.max(0, Math.min(5_000, deadline - Date.now())) })
        if (page.kind !== 'events') throw new Error(`unexpected snapshot-required at cursor ${cursor}`)
        for (const event of page.events) {
            if (event.seq > cursor) {
                events.push(event)
                cursor = event.seq
            }
        }
        if (done(events)) return events
        if (Date.now() > deadline) throw new Error(`events did not reach the expected state after seq ${afterSeq}: ${events.map((e) => `${e.seq}:${e.type}`).join(',')}`)
    }
}

export async function waitForTask(
    client: RuntimeClient,
    taskId: TaskId,
    done: (task: TaskView) => boolean,
    timeoutMs = 30_000,
): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs
    let last: TaskView | undefined
    for (;;) {
        try {
            last = await client.getTask({ taskId })
            if (done(last)) return last
        } catch (error) {
            if (!(error instanceof BrowserRuntimeError && error.code === 'RUNTIME_UNAVAILABLE')) throw error
        }
        if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach the expected state; last=${last?.status}/${last?.pauseReason ?? '-'}`)
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
}

/** Approve every pending approval of a batch in turn (interactive capability). */
export async function approveAll(viewer: RuntimeClient, taskId: TaskId, result: BatchResult | undefined): Promise<{ result: BatchResult | undefined; approvals: number }> {
    let current = result
    let approvals = 0
    while (current?.outcome === 'awaiting-user' && current.pendingApproval) {
        const pending = current.pendingApproval
        const approved: ApproveResult = await viewer.approve({ taskId, approvalId: pending.approvalId, bindingHash: pending.bindingHash, requestId: rid(), decision: 'approve' })
        approvals += 1
        current = approved.batch
    }
    return { result: current, approvals }
}

export function barrierUrl(site: string, run: string, key: string): string {
    return `${site}/barrier?run=${encodeURIComponent(run)}&key=${encodeURIComponent(key)}`
}

/** Refs of the answer textbox and submit button on a released /barrier page. */
export interface BarrierRefs { input: ElementRef; submit: ElementRef }

export async function observeBarrierRefs(client: RuntimeClient, taskId: TaskId, tabId: TabId, timeoutMs = 10_000): Promise<BarrierRefs> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const observation = await client.observe({ taskId, tabId })
        const input = observation.elements.find((element) => element.role === 'textbox')
        const submit = observation.elements.find((element) => element.role === 'button' && element.name === 'Submit answer')
        if (input && submit) return { input: input.ref, submit: submit.ref }
        if (Date.now() > deadline) throw new Error('released barrier page never showed its answer form')
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
}

export function answerEntries(entries: LedgerEntry[], key: string): LedgerEntry[] {
    return entries.filter((entry) => entry.kind === 'answer' && entry.key === key)
}

/**
 * Best effort: bring a task to a terminal state and close its tabs so the
 * profile tab quota (6) never leaks across iterations. Uncertain actions are
 * reconciled through the trusted admin path only after the test has recorded
 * its assertions.
 */
export async function cleanupTask(suite: SuiteStack, agent: RuntimeClient, taskId: TaskId, taskSpaceId: TaskSpaceId, tabs: TabId[]): Promise<void> {
    try {
        let task = await agent.getTask({ taskId })
        if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) {
            task = (await agent.cancel({ taskId, requestId: rid() })).task
            for (const actionId of task.uncertainActions) {
                task = await suite.admin<TaskView>('/admin/reconcile-action', { taskId, actionId, confirmed: true })
            }
        }
        for (const tabId of new Set([...tabs, ...task.tabs])) {
            await agent.closePage({ taskSpaceId, tabId, requestId: rid() }).catch(() => undefined)
        }
    } catch (error) {
        evidence('cleanup', { taskId, cleanupError: error instanceof BrowserRuntimeError ? error.code : String(error) })
    }
}

export { PROFILE_A }

/** A task with one tab on an already released /barrier page, answer form visible. */
export async function openReleasedBarrier(suite: SuiteStack, agent: RuntimeClient, taskSpaceId: TaskSpaceId, key: string, nonce: string) {
    await suite.stack.releaseBarrier(key, nonce)
    const task = await agent.createTask({ taskSpaceId, requestId: rid() })
    const opened = await agent.openPage({ taskId: task.taskId, url: barrierUrl(SITE_A, suite.run, key), requestId: rid() })
    const refs = await observeBarrierRefs(agent, task.taskId, opened.tabId)
    return { task, opened, tabId: opened.tabId, refs }
}

/** waitFor nonce → fill answer → click submit; one ledgered answer per run of this batch. */
export function answerSteps(tabId: TabId, refs: BarrierRefs, nonce: string, tag = randomBytes(3).toString('hex')) {
    return [
        { stepId: sid('wait'), actionId: `wait-${tag}` as ActionId, tabId, kind: 'waitFor' as const, until: { kind: 'text' as const, text: 'NONCE:' }, timeoutMs: 20_000 },
        { stepId: sid('fill'), actionId: `fill-${tag}` as ActionId, tabId, kind: 'fill' as const, ref: refs.input, value: nonce, timeoutMs: 10_000 },
        { stepId: sid('click'), actionId: `click-${tag}` as ActionId, tabId, kind: 'click' as const, ref: refs.submit, timeoutMs: 10_000 },
    ]
}
