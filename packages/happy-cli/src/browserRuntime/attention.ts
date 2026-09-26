/**
 * Attention outbox (D10, Runtime side).
 *
 * Persists the external task transitions after which the owning agent session
 * must be re-invoked (user approval decision, takeover release, user resume,
 * recovery). Transitions are tagged at commit time with `data.attention`; the
 * outbox observes TaskStore commits, so the Runtime core never writes here.
 *
 * Durability: the task journal is the source of truth. A crash between a task
 * commit and the outbox write is repaired by `reconcile()` at start-up, which
 * appends any tagged task event newer than the outbox's per-task cursor.
 * Readers only ever see sequences that are already on disk, so a sequence a
 * daemon acknowledged is never reassigned by that repair; a failed write is
 * retried. The daemon reads the feed over the broker socket and deduplicates
 * delivery by `abp-<taskId>-<eventSeq>`.
 *
 * `unresolved` keeps each task's latest attention entry until an agent batch
 * follows it, independent of the bounded event retention, so the
 * expired-cursor snapshot never loses a task that still needs its agent.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ATTENTION_REASONS, BrowserRuntimeError, TERMINAL_STATUSES, type AttentionEvent, type AttentionFeed, type AttentionReason, type TaskEvent, type TaskId } from './contracts'
import type { StoredTask, TaskStore } from './taskStore'

const FILE = 'attention.json'
const SCHEMA_VERSION = 1
const DEFAULT_MAX_EVENTS = 1_000
const DEFAULT_RETRY_MS = 1_000

interface OutboxFile {
    schemaVersion: number
    lastSeq: number
    events: AttentionEvent[]
    /** Highest task event seq already recorded, per task. */
    taskCursors: Record<string, number>
    /** Latest attention entry per task that no agent batch has followed yet. */
    unresolved?: Record<string, AttentionEvent>
}

function attentionReason(event: TaskEvent): AttentionReason | undefined {
    const reason = event.data.attention
    return (ATTENTION_REASONS as readonly unknown[]).includes(reason) ? reason as AttentionReason : undefined
}

export class AttentionOutbox {
    private store?: TaskStore
    private writeTail: Promise<void> = Promise.resolve()
    private readonly waiters = new Set<() => void>()
    /** Highest sequence on disk; nothing above it is visible to readers. */
    private durableSeq: number
    private dirty = false
    private closed = false
    private retryTimer?: NodeJS.Timeout
    private detach?: () => void

    private constructor(private readonly stateDir: string, private readonly maxEvents: number, private readonly retryMs: number, private state: OutboxFile) {
        this.durableSeq = state.lastSeq
    }

    static async open(stateDir: string, options: { maxEvents?: number; retryMs?: number } = {}): Promise<AttentionOutbox> {
        let state: OutboxFile = { schemaVersion: SCHEMA_VERSION, lastSeq: 0, events: [], taskCursors: {} }
        try {
            const parsed = JSON.parse(await readFile(join(stateDir, FILE), 'utf8')) as OutboxFile
            if (parsed.schemaVersion !== SCHEMA_VERSION) throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Unknown attention outbox schema')
            state = parsed
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof BrowserRuntimeError ? error : new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Attention outbox is unreadable')
        }
        // Files written before `unresolved` existed: the retained events are all that is known.
        state.unresolved ??= Object.fromEntries(state.events.map((event) => [event.taskId, event]))
        return new AttentionOutbox(stateDir, options.maxEvents ?? DEFAULT_MAX_EVENTS, options.retryMs ?? DEFAULT_RETRY_MS, state)
    }

    /** Start recording tagged commits of `store`, and forget tasks it deletes (retention). */
    attach(store: TaskStore): void {
        this.store = store
        const stopCommits = store.onCommitted((task, event) => this.record(task, event))
        const stopPurges = store.onPurged((taskId) => this.forget(taskId))
        this.detach = () => { stopCommits(); stopPurges() }
    }

    /**
     * Append tagged task events that the outbox missed (crash between commit and outbox
     * write), and drop cursors of tasks the store no longer has (crash between a
     * retention deletion and the outbox write).
     */
    async reconcile(): Promise<void> {
        for (const taskId of Object.keys(this.state.taskCursors)) if (this.store && !this.store.knowsTask(taskId)) this.forget(taskId)
        for (const taskId of Object.keys(this.state.unresolved ?? {})) if (this.store && !this.store.knowsTask(taskId)) this.forget(taskId)
        for (const task of this.store?.listTasks() ?? []) {
            for (const event of this.store?.events(task.taskId, this.state.taskCursors[task.taskId] ?? 0) ?? []) this.record(task, event)
        }
        await this.flush()
    }

    read(afterSeq: number): AttentionFeed {
        const visible = this.state.events.filter((event) => event.seq <= this.durableSeq)
        const oldestSeq = visible[0]?.seq ?? this.durableSeq + 1
        // Expired only when events between the cursor and the oldest retained one were
        // dropped: afterSeq = oldestSeq - 1 (e.g. 0 with oldestSeq 1) has no gap.
        if (afterSeq + 1 < oldestSeq || afterSeq > this.durableSeq) {
            return { code: 'CURSOR_EXPIRED', events: [], snapshot: this.snapshot(), nextSeq: this.durableSeq, oldestSeq }
        }
        const events = visible.filter((event) => event.seq > afterSeq)
        return { events: structuredClone(events), nextSeq: events.at(-1)?.seq ?? afterSeq, oldestSeq }
    }

    /** Long poll: resolves as soon as a durable event after `afterSeq` exists, or after waitMs. */
    async wait(afterSeq: number, waitMs: number): Promise<AttentionFeed> {
        const first = this.read(afterSeq)
        if ('code' in first || first.events.length > 0 || waitMs <= 0) return first
        await new Promise<void>((resolve) => {
            const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve() }
            const timer = setTimeout(wake, waitMs)
            this.waiters.add(wake)
        })
        return this.read(afterSeq)
    }

    /** Resolves once every recorded event is durable; rejects if the write fails (it is retried). */
    flush(): Promise<void> { return this.write() }

    /** Stop recording and writing (shutdown, or a simulated crash in tests). */
    close(): void {
        this.closed = true
        this.detach?.()
        clearTimeout(this.retryTimer)
        for (const wake of [...this.waiters]) wake()
    }

    private record(task: StoredTask, event: TaskEvent): void {
        if (this.closed) return
        const reason = attentionReason(event)
        if (event.seq <= (this.state.taskCursors[task.taskId] ?? 0)) return
        this.state.taskCursors[task.taskId] = event.seq
        const unresolved = this.state.unresolved ??= {}
        if (event.type === 'batch-accepted' && unresolved[task.taskId]) {
            delete unresolved[task.taskId]
            this.dirty = true
        }
        if (reason) {
            const seq = this.state.lastSeq + 1
            const entry: AttentionEvent = { seq, taskId: task.taskId as TaskId, agentSessionId: task.agentSessionId, status: task.status, eventSeq: event.seq, reason }
            this.state.lastSeq = seq
            this.state.events = [...this.state.events, entry].slice(-this.maxEvents)
            unresolved[task.taskId] = entry
            this.dirty = true
        }
        if (this.dirty) void this.write().catch(() => undefined)
    }

    /** A deleted task keeps no cursor or unresolved entry; its old feed events age out with retention. */
    private forget(taskId: string): void {
        if (this.closed || (!(taskId in this.state.taskCursors) && !(taskId in (this.state.unresolved ?? {})))) return
        delete this.state.taskCursors[taskId]
        delete this.state.unresolved?.[taskId]
        this.dirty = true
        void this.write().catch(() => undefined)
    }

    /** Persist the current state if it changed; readers are woken only once it is on disk. */
    private write(): Promise<void> {
        const run = this.writeTail.catch(() => undefined).then(async () => {
            if (!this.dirty || this.closed) return
            const snapshot = structuredClone(this.state)
            this.dirty = false
            try {
                await this.persist(snapshot)
            } catch (error) {
                this.dirty = true
                this.scheduleRetry()
                throw error
            }
            this.durableSeq = Math.max(this.durableSeq, snapshot.lastSeq)
            for (const wake of [...this.waiters]) wake()
        })
        this.writeTail = run
        return run
    }

    private scheduleRetry(): void {
        if (this.retryTimer || this.closed) return
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.write().catch(() => undefined) }, this.retryMs)
        this.retryTimer.unref()
    }

    /** Durable unresolved entries whose task still needs its agent. */
    private snapshot(): AttentionEvent[] {
        return Object.values(this.state.unresolved ?? {}).filter((entry) => {
            if (entry.seq > this.durableSeq) return false
            const task = this.store?.getTask(entry.taskId)
            if (!task) return false
            const handled = (this.store?.events(entry.taskId, entry.eventSeq) ?? []).some((event) => event.type === 'batch-accepted')
            return !handled && (!(TERMINAL_STATUSES as readonly string[]).includes(task.status) || entry.reason === 'approval-rejected')
        }).sort((left, right) => left.seq - right.seq).map((entry) => structuredClone(entry))
    }

    private async persist(state: OutboxFile): Promise<void> {
        await mkdir(this.stateDir, { recursive: true })
        const file = join(this.stateDir, FILE)
        const temporary = join(this.stateDir, `.${randomUUID()}.attention.tmp`)
        try {
            const handle = await open(temporary, 'wx', 0o600)
            try {
                await handle.writeFile(JSON.stringify(state))
                await handle.sync()
            } finally {
                await handle.close()
            }
            await rename(temporary, file)
            const dir = await open(this.stateDir, 'r')
            try { await dir.sync() } finally { await dir.close() }
        } catch (error) {
            await rm(temporary, { force: true })
            throw error
        }
    }
}
