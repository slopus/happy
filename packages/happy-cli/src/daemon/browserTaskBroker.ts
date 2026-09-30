/**
 * Daemon side of the Agent Browser broker (D4) on the execution machine.
 *
 * When the machine is configured for the browser Runtime
 * (HAPPY_BROWSER_TASK_BROKER_SOCKET + a readable daemon token file), the
 * daemon registers each spawned session with the Runtime broker, hands the
 * session process its per-session secret through the spawn environment,
 * binds the registration once the session reports its Happy session id, and
 * revokes its grants when the process exits (logical tasks survive for the broker orphan TTL). Startup and periodic reconciliation also
 * revoke registrations whose Linux owner process is provably dead. A failed
 * registration only means the session has no browser grant; it never blocks the spawn.
 *
 * A revocation the Runtime has not confirmed is kept in a file and retried
 * with exponential backoff (at most 5 minutes apart), across daemon restarts,
 * so an ended session's registration cannot stay renewable. The file is
 * replaced durably (exclusive temp file, fsync, rename, directory fsync); a
 * failed write is retried, and a revocation that is neither confirmed nor
 * saved is reported to the caller. An unreadable or malformed queue file is
 * never read as empty: the broker refuses to start (no new browser grants)
 * and the file is left for repair.
 *
 * Lineage (profile reassignment): a fork or recovery spawn continues an existing
 * conversation under a new Happy session id; the registration carries the parent
 * session id and the provider conversation id so the Runtime can refuse a
 * conversation of an earlier assignment (the daemon token is the trust boundary).
 * A resume names its own session id as the parent, so a conversation the Runtime cannot
 * show to be of the current assignment gets no browser grant.
 * A registration or bind the Runtime answers with a retryable RUNTIME_UNAVAILABLE
 * (admission held at start-up or while a reassignment is verified) is retried for a
 * bounded time: registration in the foreground before the spawn (default 60 s), a bind
 * in the background (default 10 minutes; a denial or the deadline revokes it).
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { brokerRequest } from '@/browserRuntime/brokerGrantSource'
import { logger } from '@/ui/logger'
import { sessionRegistrationsSchema, type SessionOwner } from '@/browserRuntime/sessionRegistration'
import { readBrowserTaskBootId, readBrowserTaskPidStartTime, readBrowserTaskSessionOwner } from './browserTaskSessionOwner'

const DEFAULT_DAEMON_TOKEN_FILE = '/var/lib/abp/daemon-token'
const MAX_RETRY_DELAY_MS = 5 * 60_000
const DEFAULT_BIND_RETRY_DEADLINE_MS = 10 * 60_000
const DEFAULT_REGISTER_RETRY_DEADLINE_MS = 60_000
const MAX_REGISTER_RETRY_DELAY_MS = 5_000
const MAX_BIND_RETRY_DELAY_MS = 15_000

type RevokeTarget = { registrationId: string } | { agentSessionId: string }

/** What a new session continues: its parent Happy session and the provider conversation it resumes. */
export interface BrowserTaskLineage { parentSessionIds?: string[]; conversationIds?: string[] }

/**
 * Lineage of a spawn from its options: a fork or recovery names the parent session and resumes a Claude
 * session or Codex thread (namespaced by provider). Undefined for a fresh conversation.
 */
export function browserTaskLineage(options: { parentSessionId?: string; resumeClaudeSessionId?: string; resumeCodexThreadId?: string }): BrowserTaskLineage | undefined {
    const parentSessionIds = options.parentSessionId ? [options.parentSessionId] : []
    const conversationIds = [
        ...options.resumeClaudeSessionId ? [`claude:${options.resumeClaudeSessionId}`] : [],
        ...options.resumeCodexThreadId ? [`codex:${options.resumeCodexThreadId}`] : [],
    ]
    return parentSessionIds.length || conversationIds.length
        ? { ...parentSessionIds.length ? { parentSessionIds } : {}, ...conversationIds.length ? { conversationIds } : {} }
        : undefined
}

export interface BrowserTaskSessionBroker {
    /**
     * `lineage`: a fork or recovery (the Runtime refuses a conversation of an earlier profile assignment).
     * `attestation`: Studio's session-user attestation of a new chat (shared machines).
     */
    register(lineage?: BrowserTaskLineage, attestation?: string): Promise<{ registrationId: string; sessionSecret: string } | undefined>
    /**
     * True once bound, or while a transient refusal (admission held) is retried in the background, which
     * revokes the registration itself if the Runtime then denies it or the deadline passes. False: denied
     * (or unreachable), and the caller revokes it.
     */
    bind(registrationId: string, agentSessionId: string, pid?: number): Promise<boolean>
    /** Revoke only registrations with a provably dead Linux host process owner. */
    reconcile(): Promise<void>
    /** Tries once now; an unconfirmed revocation stays pending and is retried. */
    revoke(target: RevokeTarget): Promise<void>
    /** Retries every pending revocation once; resolves to how many remain. */
    retryPendingRevocations(): Promise<number>
    /** Whether a revocation of this target is still unconfirmed (queued for retry). */
    isRevocationPending(target: RevokeTarget): boolean
    /** Whether a task of the session waits for the user; throws when the Runtime gives no answer. */
    waiting(agentSessionId: string): Promise<boolean>
}

export interface BrowserTaskSessionBrokerOptions {
    /** Linux procfs on the execution host; overridable for filesystem fixtures. */
    procRoot?: string
    /** Pending revocations survive daemon restarts here (the daemon's home dir). */
    pendingRevocationsFile?: string
    /** First retry delay; doubles per failed round up to 5 minutes. */
    retryBaseMs?: number
    /** Replaces the queue file durably; tests inject write failures. */
    writeQueueFile?: (file: string, data: string) => void
    /** How long a bind refused as temporarily unavailable is retried (default 10 minutes). */
    bindRetryDeadlineMs?: number
    /** How long a registration refused as temporarily unavailable is retried before the spawn goes on without a grant (default 60 s). */
    registerRetryDeadlineMs?: number
    /** First delay between those retries; doubles up to 15 seconds. */
    bindRetryBaseMs?: number
}

export class PendingRevocationQueueError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PendingRevocationQueueError'
    }
}

function isRevokeTarget(target: unknown): target is RevokeTarget {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false
    const keys = Object.keys(target)
    const value = Object.values(target)[0]
    return keys.length === 1 && ['registrationId', 'agentSessionId'].includes(keys[0]) && typeof value === 'string' && value.length > 0
}

/** A missing file is an empty queue; anything else that is not a valid queue is an error. */
function loadPending(file: string | undefined): RevokeTarget[] {
    if (!file) return []
    let raw: string
    try {
        raw = readFileSync(file, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new PendingRevocationQueueError(`Browser task revocation queue ${file} is unreadable`)
    }
    let parsed: { schemaVersion?: unknown; pending?: unknown }
    try {
        parsed = JSON.parse(raw) as typeof parsed
    } catch {
        throw new PendingRevocationQueueError(`Browser task revocation queue ${file} is not valid JSON`)
    }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.pending) || !parsed.pending.every(isRevokeTarget))
        throw new PendingRevocationQueueError(`Browser task revocation queue ${file} has an unsupported format`)
    return parsed.pending
}

/** Exclusive temp file, fsync, rename over `file`, then fsync the directory. */
function writeQueueFileDurably(file: string, data: string): void {
    const dir = dirname(file)
    const temporary = join(dir, `.${basename(file)}.${randomUUID()}.tmp`)
    try {
        const fd = openSync(temporary, 'wx', 0o600)
        try {
            writeFileSync(fd, data)
            fsyncSync(fd)
        } finally {
            closeSync(fd)
        }
        renameSync(temporary, file)
    } catch (error) {
        rmSync(temporary, { force: true })
        throw error
    }
    const dirFd = openSync(dir, 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
}

export interface BrowserTaskBrokerConfig { socketPath: string; daemonToken: string }

export function readBrowserTaskBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrowserTaskBrokerConfig | undefined {
    const socketPath = env.HAPPY_BROWSER_TASK_BROKER_SOCKET
    if (!socketPath) return undefined
    let daemonToken: string
    try {
        daemonToken = readFileSync(env.HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE || DEFAULT_DAEMON_TOKEN_FILE, 'utf8').trim()
    } catch {
        logger.debug('[DAEMON RUN] Browser task broker configured but the daemon token is unreadable; browser grants disabled')
        return undefined
    }
    if (!daemonToken) return undefined
    return { socketPath, daemonToken }
}

export function createBrowserTaskSessionBroker(
    env: NodeJS.ProcessEnv = process.env,
    request: typeof brokerRequest = brokerRequest,
    options: BrowserTaskSessionBrokerOptions = {},
): BrowserTaskSessionBroker | undefined {
    const config = readBrowserTaskBrokerConfig(env)
    if (!config) return undefined
    const { socketPath, daemonToken } = config
    const headers = { 'x-abp-daemon-token': daemonToken }
    /** The reply status, or 0 when the socket was unreachable. */
    const send = async (path: string, body: Record<string, unknown>): Promise<{ status: number; result?: Record<string, unknown>; transient?: boolean }> => {
        try {
            const reply = await request(socketPath, 'POST', path, headers, { schemaVersion: 1, ...body })
            if (reply.status === 200 && reply.body.ok) return { status: 200, result: reply.body.result as Record<string, unknown> }
            // Error codes only: bodies never carry secrets, but keep logs minimal anyway.
            logger.debug(`[DAEMON RUN] Browser task broker ${path} failed status=${reply.status} code=${reply.body.error?.code ?? '-'}`)
            // The Runtime admits nothing for now (start-up cleanup, a reassignment being verified): worth retrying.
            return { status: reply.status, transient: reply.status === 503 && reply.body.error?.code === 'RUNTIME_UNAVAILABLE' && reply.body.error?.retryable === true }
        } catch (error) {
            logger.debug(`[DAEMON RUN] Browser task broker ${path} unreachable: ${error instanceof Error ? error.message : 'unknown'}`)
            return { status: 0 }
        }
    }

    const pendingFile = options.pendingRevocationsFile
    const retryBaseMs = options.retryBaseMs ?? 1_000
    let pending = loadPending(pendingFile)
    const key = (target: RevokeTarget) => JSON.stringify(target)
    const writeQueueFile = options.writeQueueFile ?? writeQueueFileDurably
    /** True while the file lags the in-memory queue (a write failed); retried with the revocations. */
    let queueDirty = false
    const savePending = (): boolean => {
        if (!pendingFile) return true
        try {
            writeQueueFile(pendingFile, JSON.stringify({ schemaVersion: 1, pending }))
            queueDirty = false
            return true
        } catch (error) {
            queueDirty = true
            logger.warn(`[DAEMON RUN] Browser task revocation queue not saved (${(error as NodeJS.ErrnoException).code ?? 'error'}); retrying`)
            return false
        }
    }
    /** Confirmed (200) and invalid requests (400, never retryable) leave the queue. */
    const attempt = async (target: RevokeTarget): Promise<void> => {
        // Explicitly preserve logical tasks on exits, reconciliation, and replacement registration.
        const { status } = await send('/v1/sessions/revoke', { ...target, endSession: false })
        if (status !== 200 && status !== 400) return
        pending = pending.filter((entry) => key(entry) !== key(target))
        savePending()
    }
    let retryTimer: NodeJS.Timeout | undefined
    let failedRounds = 0
    const retryPendingRevocations = async (): Promise<number> => {
        if (queueDirty) savePending()
        for (const target of [...pending]) await attempt(target)
        failedRounds = pending.length || queueDirty ? failedRounds + 1 : 0
        scheduleRetry()
        return pending.length
    }
    const scheduleRetry = (): void => {
        if (retryTimer || (!pending.length && !queueDirty)) return
        retryTimer = setTimeout(() => { retryTimer = undefined; void retryPendingRevocations() },
            Math.min(retryBaseMs * 2 ** Math.max(0, failedRounds - 1), MAX_RETRY_DELAY_MS))
        retryTimer.unref()
    }
    scheduleRetry()

    const bindRetryDeadlineMs = options.bindRetryDeadlineMs ?? DEFAULT_BIND_RETRY_DEADLINE_MS
    const bindRetryBaseMs = options.bindRetryBaseMs ?? 1_000
    /** Binds retried in the background, by agent session id; a revoke of the session or registration stops one. */
    const retryingBinds = new Map<string, { registrationId: string; stop(): void }>()
    const retryBind = (registrationId: string, agentSessionId: string, body: Record<string, unknown>): void => {
        retryingBinds.get(agentSessionId)?.stop()
        const deadline = Date.now() + bindRetryDeadlineMs
        let delayMs = bindRetryBaseMs
        let timer: NodeJS.Timeout | undefined
        let stopped = false
        const stop = () => { stopped = true; clearTimeout(timer); if (retryingBinds.get(agentSessionId)?.registrationId === registrationId) retryingBinds.delete(agentSessionId) }
        const giveUp = (why: string) => {
            stop()
            logger.debug(`[DAEMON RUN] Browser task bind ${why}; revoking the registration`)
            void broker.revoke({ registrationId }).catch((error) => logger.debug(`[DAEMON RUN] Browser task revoke after bind failed: ${error instanceof Error ? error.message : 'unknown'}`))
        }
        const tick = async (): Promise<void> => {
            if (stopped) return
            const reply = await send('/v1/sessions/bind', body)
            if (stopped) return
            if (reply.status === 200) { stop(); logger.debug('[DAEMON RUN] Browser task bind succeeded after a retry'); return }
            if (!reply.transient) return giveUp('denied')
            if (Date.now() + delayMs > deadline) return giveUp('still unavailable at the deadline')
            timer = setTimeout(() => void tick(), delayMs)
            timer.unref()
            delayMs = Math.min(delayMs * 2, MAX_BIND_RETRY_DELAY_MS)
        }
        retryingBinds.set(agentSessionId, { registrationId, stop })
        timer = setTimeout(() => void tick(), delayMs)
        timer.unref()
        delayMs = Math.min(delayMs * 2, MAX_BIND_RETRY_DELAY_MS)
    }

    const broker: BrowserTaskSessionBroker = {
        async register(lineage, attestation) {
            // The host boot id lets reconciliation drop this registration after a reboot even if no owner is ever bound.
            const bootId = await readBrowserTaskBootId(options.procRoot).catch(() => undefined)
            const body = { ...bootId ? { bootId } : {}, ...lineage ? { lineage } : {}, ...attestation ? { attestation } : {} }
            // Admission held (start-up cleanup, a reassignment being verified): wait a bounded time, so an
            // ordinary restart's hold does not leave the session without a browser for its whole life.
            const deadline = Date.now() + (options.registerRetryDeadlineMs ?? DEFAULT_REGISTER_RETRY_DEADLINE_MS)
            let delayMs = options.bindRetryBaseMs ?? 1_000
            let reply = await send('/v1/sessions/register', body)
            while (reply.transient && Date.now() + delayMs <= deadline) {
                await new Promise((resolve) => setTimeout(resolve, delayMs))
                delayMs = Math.min(delayMs * 2, MAX_REGISTER_RETRY_DELAY_MS)
                reply = await send('/v1/sessions/register', body)
            }
            const result = reply.result
            return typeof result?.registrationId === 'string' && typeof result.sessionSecret === 'string'
                ? { registrationId: result.registrationId, sessionSecret: result.sessionSecret }
                : undefined
        },
        async bind(registrationId, agentSessionId, pid) {
            let owner: SessionOwner | undefined
            if (pid !== undefined) {
                try {
                    owner = await readBrowserTaskSessionOwner(pid, options.procRoot)
                } catch (error) {
                    logger.debug(`[DAEMON RUN] Browser task session owner unavailable: ${error instanceof Error ? error.message : 'unknown'}`)
                }
            }
            const body = { registrationId, agentSessionId, ...(owner ? { owner } : {}) }
            const first = await send('/v1/sessions/bind', body)
            if (first.status === 200) return true
            if (!first.transient) return false
            retryBind(registrationId, agentSessionId, body)
            return true
        },
        async reconcile() {
            try {
                const reply = await request(socketPath, 'GET', '/v1/sessions', headers)
                if (reply.status !== 200 || !reply.body.ok) {
                    logger.debug(`[DAEMON RUN] Browser task reconciliation list failed status=${reply.status}; retrying next tick`)
                    return
                }
                const registrations = sessionRegistrationsSchema.parse(reply.body.result)
                if (!registrations.some((registration) => registration.owner || registration.bootId)) return
                const bootId = await readBrowserTaskBootId(options.procRoot)
                for (const registration of registrations) {
                    const { owner } = registration
                    try {
                        // Boot ids only, never wall-clock times (a clock step moves /proc btime). A registration with
                        // neither an owner nor a boot id (made before these were recorded) is kept.
                        const dead = owner
                            ? owner.bootId !== bootId || await readBrowserTaskPidStartTime(owner.pid, options.procRoot) !== owner.pidStartTime
                            : registration.bootId !== undefined && registration.bootId !== bootId
                        if (dead) {
                            await broker.revoke({ registrationId: registration.registrationId })
                        }
                    } catch (error) {
                        logger.debug(`[DAEMON RUN] Browser task reconciliation failed registration=${registration.registrationId}: ${error instanceof Error ? error.message : 'unknown'}; retrying next tick`)
                    }
                }
            } catch (error) {
                logger.debug(`[DAEMON RUN] Browser task reconciliation unavailable: ${error instanceof Error ? error.message : 'unknown'}; retrying next tick`)
            }
        },
        async waiting(agentSessionId) {
            const reply = await request(socketPath, 'GET', `/v1/sessions/waiting?agentSessionId=${encodeURIComponent(agentSessionId)}`, headers)
            const waiting = reply.status === 200 && reply.body.ok ? (reply.body.result as { waiting?: unknown } | undefined)?.waiting : undefined
            if (typeof waiting !== 'boolean') throw new Error(`Browser task session waiting query failed status=${reply.status}`)
            return waiting
        },
        async revoke(target) {
            // An ended session (or a released registration) must not be bound by a retry still pending.
            for (const [agentSessionId, retrying] of [...retryingBinds]) {
                if ('agentSessionId' in target ? target.agentSessionId === agentSessionId : target.registrationId === retrying.registrationId) {
                    retrying.stop()
                    if ('agentSessionId' in target) await broker.revoke({ registrationId: retrying.registrationId })
                }
            }
            let saved = !queueDirty
            if (!pending.some((entry) => key(entry) === key(target))) {
                pending = [...pending, target]
                saved = savePending()
            }
            await attempt(target)
            const outstanding = pending.some((entry) => key(entry) === key(target))
            if (pending.length || queueDirty) failedRounds = Math.max(failedRounds, 1)
            scheduleRetry()
            if (outstanding && !saved) throw new PendingRevocationQueueError('Browser task revocation was neither confirmed nor saved; retrying in memory')
        },
        retryPendingRevocations,
        isRevocationPending: (target) => pending.some((entry) => key(entry) === key(target)),
    }
    return broker
}

/**
 * Registration for a resumed session, whose Happy session id is already known. The previous process is
 * gone, so any registration still bound to that id is revoked first (as its exit or reconciliation would
 * have); while that revocation is unconfirmed nothing is registered, because the queued retry revokes by
 * session id and would take the new binding with it. The caller binds the result once the child runs.
 */
export async function registerResumedBrowserSession(broker: BrowserTaskSessionBroker | undefined, agentSessionId: string): Promise<{ registrationId: string; sessionSecret: string } | undefined> {
    if (!broker) return undefined
    await broker.revoke({ agentSessionId }).catch(() => undefined)
    if (broker.isRevocationPending({ agentSessionId })) return undefined
    // The session itself is the lineage: only a session bound in the current assignment gets a grant again.
    return broker.register({ parentSessionIds: [agentSessionId] })
}

/**
 * Resumed session processes need their own registration: the previous process's one was revoked at its exit.
 * Registers (registerResumedBrowserSession), hands the secret to the spawn, binds the known session id, and
 * revokes it if the spawn does not succeed.
 */
export async function spawnResumedWithBrowserTaskRegistration<R extends { type: string }>(input: {
    broker: BrowserTaskSessionBroker | undefined
    agentSessionId: string
    env: Record<string, string>
    spawn: (env: Record<string, string>) => Promise<R>
    ownerPid: () => number | undefined
    onRevokeFailure: (error: unknown) => void
}): Promise<R> {
    const { broker, agentSessionId } = input
    const registration = await registerResumedBrowserSession(broker, agentSessionId)
    if (!broker || !registration) return input.spawn(input.env)
    const release = () => broker.revoke({ registrationId: registration.registrationId }).catch(input.onRevokeFailure)
    let result: R
    try {
        result = await input.spawn({ ...input.env, HAPPY_BROWSER_TASK_SESSION_SECRET: registration.sessionSecret })
    } catch (error) {
        await release()
        throw error
    }
    if (!(result.type === 'success' && await broker.bind(registration.registrationId, agentSessionId, input.ownerPid()))) {
        await release()
    }
    return result
}

/** Start immediately and avoid overlapping sweeps; stopping never revokes surviving sessions. */
export function startBrowserTaskReconciliation(broker: BrowserTaskSessionBroker | undefined, intervalMs = 60_000): () => void {
    if (!broker) return () => {}
    let running = false
    const tick = async (): Promise<void> => {
        if (running) return
        running = true
        try {
            await broker.reconcile()
        } catch (error) {
            logger.debug(`[DAEMON RUN] Browser task reconciliation failed: ${error instanceof Error ? error.message : 'unknown'}`)
        } finally {
            running = false
        }
    }
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    timer.unref()
    return () => clearInterval(timer)
}
