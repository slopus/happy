/**
 * Helpers for the A02 (lifetime) and A04 (persistent login / handoff) suites.
 *
 * Human input in the viewer is simulated through the X display of the browser
 * container with xdotool — the same path noVNC input takes — never CDP.
 * There is no window manager in the container and every agent tab is its own
 * background window, so the human's target is found by window title (= page
 * <title>) and given X input focus with windowraise + windowfocus.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mintAgentGrant, mintInteractiveCapability } from '../auth'
import {
    AGENT_OPERATIONS, INTERACTIVE_OPERATIONS,
    type ActionId, type AgentSessionId, type GrantId, type RequestId, type StepId, type TabId, type TaskEvent, type TaskId, type TaskSpaceId, type TaskView,
} from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, type GrantOptions, type PocStack } from './pocStack'

export const rid = () => randomUUID() as RequestId
export const range = (n: number) => Array.from({ length: n }, (_, i) => i)
/** Iteration count: ABP_REPEAT overrides the in-repo default. */
export const repeat = (fallback: number) => Number(process.env.ABP_REPEAT ?? fallback)
export const evidence = (data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: data }))
export const tagOf = (prefix: string, i: number) => `${prefix}-${i}-${randomUUID().slice(0, 6)}`
export const STRICT_PASSWORD = 'correct-horse'
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stepCounter = 0
export function step(tabId: TabId, kind: 'navigate' | 'waitFor' | 'observe' | 'click' | 'fill', extra: Record<string, unknown> = {}) {
    stepCounter += 1
    return { stepId: `s${stepCounter}` as StepId, actionId: `a${stepCounter}-${randomUUID().slice(0, 8)}` as ActionId, tabId, kind,
        timeoutMs: 20_000, ...extra } as never
}

export async function allEvents(client: RuntimeClient, taskId: TaskId): Promise<TaskEvent[]> {
    const result = await client.subscribe({ taskId, afterSeq: 0 })
    if (result.kind !== 'events') throw new Error('subscribe returned snapshot-required from seq 0')
    return result.events
}

/** Poll getTask until predicate holds (hang guard only). */
export async function waitForTask(client: RuntimeClient, taskId: TaskId, predicate: (task: TaskView) => boolean,
    timeoutMs = 30_000): Promise<TaskView> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const task = await client.getTask({ taskId })
        if (predicate(task)) return task
        if (Date.now() > deadline) return task
        await sleep(200)
    }
}

/** The client learns the tab's lease epoch only from task events. */
export async function latestLeaseEpoch(client: RuntimeClient, taskId: TaskId): Promise<number> {
    const events = await allEvents(client, taskId)
    return [...events].reverse().find((event) => event.leaseEpoch > 0)?.leaseEpoch ?? 0
}

export class Viewer {
    constructor(private readonly stack: PocStack, private readonly profile: 'a' | 'b') {}
    private get container(): string {
        return this.stack.env.containers[this.profile === 'a' ? 'browserA' : 'browserB']
    }
    xdo(args: string): string {
        return execFileSync('docker', ['exec', this.container, 'sh', '-c', `DISPLAY=:99 xdotool ${args}`], { encoding: 'utf8' }).trim()
    }
    /** Every agent tab is its own top-level window (per-tab background windows); find it by page <title>. */
    windowsNamed(needle: string): string[] {
        try {
            return this.xdo(`search --name ${JSON.stringify(needle).replaceAll('$', '')}`).split('\n').filter(Boolean)
        } catch {
            return [] // xdotool exits 1 when nothing matches
        }
    }
    title(): string {
        try {
            return this.xdo('getwindowfocus getwindowname')
        } catch {
            return ''
        }
    }
    /** Raise and focus the window whose title contains `needle` (no WM in the container: windowraise + windowfocus). */
    async bringToFront(needle: string, timeoutMs = 20_000): Promise<void> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            for (const id of this.windowsNamed(needle)) {
                try {
                    this.xdo(`windowraise ${id} windowfocus --sync ${id}`)
                } catch { /* window went away */ }
                if (this.title().includes(needle)) return
            }
            await sleep(300)
        }
        throw new Error(`viewer: no window titled "${needle}" (focused "${this.title()}")`)
    }
    async waitForTitle(needle: string, timeoutMs = 10_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (this.title().includes(needle)) return true
            await sleep(200)
        }
        return false
    }
    /** Normal browser shutdown: SIGTERM to the Chromium main process only (the entrypoint loop restarts it). */
    gracefulBrowserRestart(): void {
        execFileSync('docker', ['exec', this.container, 'sh', '-c',
            'kill -TERM "$(python3 -c \'import json;print(json.load(open("/run/abp/instance.json"))["chromePid"])\')"'])
    }
    /**
     * Chromium commits cookies to the profile's Cookies DB lazily (~30 s) and neither SIGTERM of the main
     * process nor `fault kill-chrome` flushes a fresh one, so a login is only durable once its row is on disk.
     * Harness-side check of the cookie *name* only (never the value). Returns the observed latency.
     */
    async waitCookieOnDisk(name: string, timeoutMs = 90_000): Promise<number> {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
            const out = execFileSync('docker', ['exec', this.container, 'python3', '-c',
                'import sqlite3,sys;c=sqlite3.connect("file:/home/browser/profile/Default/Cookies?mode=ro",uri=True);'
                + 'print(c.execute("select count(*) from cookies where name=?",(sys.argv[1],)).fetchone()[0])', name], { encoding: 'utf8' })
            if (Number(out.trim()) > 0) return Date.now() - started
            await sleep(1_000)
        }
        throw new Error(`cookie ${name} not committed to the profile within ${timeoutMs} ms`)
    }
    /** Human types credentials into the focused (autofocus) login form. */
    async login(tag: string, password: string): Promise<void> {
        await this.bringToFront(`ABP strict login ${tag}`)
        this.xdo('type --delay 15 human-a')
        this.xdo('key Tab')
        this.xdo(`type --delay 15 ${password}`)
        this.xdo('key Return')
    }
    /** Human ticks the synthetic challenge checkbox and submits. Not a real CAPTCHA. */
    async solveChallenge(tag: string): Promise<void> {
        await this.bringToFront(`ABP challenge ${tag}`)
        this.xdo('key space')
        this.xdo('key Return')
    }
}

/**
 * pocStack.mintAgent/mintInteractive stamp issuedAtMs = host Date.now(); the
 * Runtime rejects issuedAtMs > its own clock with no skew leeway, and the
 * container clock trails the host by a few ms, so fresh tokens are randomly
 * UNAUTHORIZED. These mint the same claims with issuedAtMs backdated by
 * SKEW_MS (expiry stays relative to the real now). The interactive capability carries
 * INTERACTIVE_OPERATIONS + getTask/subscribe: pocStack.mintInteractive also adds
 * cancel/resume, which the Runtime's verifyToken rejects.
 */
const SKEW_MS = 5_000
export function mintAgent(stack: PocStack, grant: GrantOptions = {}): { token: string; grantId: GrantId } {
    const now = Date.now()
    const grantId = (grant.grantId ?? `grant-${randomUUID()}`) as GrantId
    const token = mintAgentGrant({
        kind: 'agent-grant', grantId, principalId: grant.principalId ?? PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: (grant.agentSessionId ?? `agent-${randomUUID()}`) as AgentSessionId, profileId: grant.profileId ?? PROFILE_A,
        allowedOrigins: grant.allowedOrigins ?? [SITE_A, SITE_B], operations: grant.operations ?? [...AGENT_OPERATIONS],
        taskSpaceIds: grant.taskSpaceIds ?? [], issuedAtMs: now - SKEW_MS, expiresAtMs: now + (grant.ttlMs ?? 30 * 60_000),
    }, stack.keys, now)
    return { token, grantId }
}
export function mintInteractive(stack: PocStack, capability: { profileId?: GrantOptions['profileId']; ttlMs?: number } = {}): string {
    const now = Date.now()
    return mintInteractiveCapability({
        kind: 'interactive', capabilityId: `cap-${randomUUID()}`, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        viewerSessionId: `viewer-${randomUUID()}`, profileId: capability.profileId ?? PROFILE_A,
        operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe'],
        issuedAtMs: now - SKEW_MS, expiresAtMs: now + (capability.ttlMs ?? 30 * 60_000),
    }, stack.keys, now)
}

/** Cancel (if needed) and close the task's space so the per-profile space limit (2) is not exhausted. */
export async function cleanupTask(client: RuntimeClient, taskId: TaskId, taskSpaceId: TaskSpaceId,
    reconcile?: (taskId: TaskId, actionId: ActionId) => Promise<unknown>): Promise<void> {
    let task: TaskView | undefined
    try {
        task = await client.getTask({ taskId })
        if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) {
            await client.cancel({ taskId, requestId: rid() })
            task = await waitForTask(client, taskId, (t) => ['succeeded', 'failed', 'cancelled'].includes(t.status)
                || t.uncertainActions.length > 0, 15_000)
            // An aborted in-flight action stays uncertain; the trusted harness resolves it from the fixture ledger.
            if (reconcile && task.uncertainActions.length) {
                for (const actionId of task.uncertainActions) await reconcile(taskId, actionId)
                task = await waitForTask(client, taskId, (t) => ['succeeded', 'failed', 'cancelled'].includes(t.status), 15_000)
            }
        }
        await client.closeSpace({ taskSpaceId, requestId: rid() })
    } catch (error) {
        console.log(JSON.stringify({ cleanupFailed: taskId, code: (error as { code?: string }).code, status: task?.status,
            pauseReason: task?.pauseReason, uncertain: task?.uncertainActions.length }))
    }
}

/**
 * `docker restart` of the Runtime container re-assigns its ephemeral loopback
 * ports (published as 127.0.0.1::8787), but pocStack captured runtimeUrl once
 * at `up`. Resolve the live port on every client creation instead.
 */
export function runtimePort(stack: PocStack, internal = 8787): number {
    const out = execFileSync('docker', ['port', stack.env.containers.runtime, `${internal}/tcp`], { encoding: 'utf8' })
    const match = /127\.0\.0\.1:(\d+)/.exec(out)
    if (!match) throw new Error(`runtime port ${internal} not published`)
    return Number(match[1])
}
export function clientFor(stack: PocStack, token: string): RuntimeClient {
    return new RuntimeClient({ baseUrl: `http://127.0.0.1:${runtimePort(stack)}`, token })
}
export async function admin<T>(stack: PocStack, path: string, body: Record<string, unknown> = {}): Promise<T> {
    const get = path === '/admin/debug'
    const response = await fetch(`http://127.0.0.1:${runtimePort(stack, 8788)}${path}`, {
        method: get ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${stack.keys.adminToken}`, 'content-type': 'application/json' },
        ...(get ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = await response.json() as { ok: boolean; result?: T; error?: unknown }
    if (!parsed.ok) throw new Error(`admin ${path} failed: ${JSON.stringify(parsed.error)}`)
    return parsed.result as T
}
export async function waitHealthy(stack: PocStack, timeoutMs = 120_000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${runtimePort(stack)}/v1/health`)
            const health = await response.json() as { profiles?: Array<{ connected: boolean }> }
            if (response.ok && health.profiles?.every((p) => p.connected)) return runtimePort(stack)
        } catch { /* restarting */ }
        await sleep(250)
    }
    throw new Error('runtime did not become healthy')
}
