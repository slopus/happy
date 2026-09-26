import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    BrowserRuntimeError,
    POC_LIMITS,
    SCHEMA_VERSION,
    TERMINAL_STATUSES,
    type ActionId,
    type ActionState,
    type AgentGrant,
    type ApprovalId,
    type BatchId,
    type BatchResult,
    type BatchStep,
    type BrowserInstanceId,
    type ProfileId,
    type TabId,
    type TaskEvent,
    type TaskId,
    type TaskSpaceId,
    type TaskView,
    type InputOwner,
    type SnapshotId,
} from './contracts'
export interface ActionRecord {
    state: ActionState
    kind?: BatchStep['kind']
    batchId?: BatchId
    grantId?: string
    payloadHash?: string
    leaseEpoch?: number
    browserInstanceId?: BrowserInstanceId
}
export interface ApprovalRecord {
    approvalId?: ApprovalId
    actionId?: ActionId
    grantId?: string
    origin?: string
    description?: string
    bindingHash?: string
    expiresAtMs?: number
    state: 'pending' | 'consumed' | 'rejected' | 'expired'
    batchId?: BatchId
    nextStep?: number
    payloadHash?: string
    documentGeneration?: number
    leaseEpoch?: number
    browserInstanceId?: BrowserInstanceId
    snapshotId?: SnapshotId
    frameOrigin?: string
    elementIdentity?: string
    formValues?: Record<string, string>
    result?: BatchResult
}
export interface BatchRecord {
    steps: BatchStep[]
    nextStep: number
    grant?: AgentGrant
    result?: BatchResult
}
export interface StoredTask extends TaskView {
    owner: {
        principalId: string
        workspaceId: string
        machineId: string
    }
    actions: Record<string, ActionRecord>
    approvals: Record<string, ApprovalRecord>
    batches: Record<string, BatchRecord>
    dedupe: Record<string, {
        hash: string
        result: unknown
    }>
    nextSafeStep?: number
    runtimeFingerprint?: string
    documentGenerations?: Record<string, number>
    tabTargets?: Record<string, string>
    tabLeaseEpochs?: Record<string, number>
    [key: string]: unknown
}
export interface StoreEventInput extends Omit<TaskEvent, 'seq' | 'schemaVersion' | 'taskId' | 'stateVersion'> {
    stateVersion?: number
}
export type FaultInjector = (operation: 'lock' | 'event-append' | 'task-replace' | 'metadata' | 'purge-move' | 'purge-delete') => void | Promise<void>
export interface SpaceRecord {
    taskSpaceId: TaskSpaceId
    profileId: ProfileId
    createdAtMs: number
    tabs: TabId[]
    goneTabs?: TabId[]
    tabTargets?: Record<string, string>
    tabLeaseEpochs?: Record<string, number>
    profileUserOwner?: { tabId: TabId; owner: Extract<InputOwner, { kind: 'user' }> } | null
    closed?: boolean
    owner?: {
        principalId: string
        workspaceId: string
        machineId: string
    }
    requestKey?: string
    requestHash?: string
    dedupe?: Record<string, {
        hash: string
        result: unknown
    }>
    /** Agent session that created the space; its end reclaims the space. */
    agentSessionId?: string
    /** Reclamation started (owning session ended, idle, operator): no new work, closed once its tasks allow. */
    reclaimingSinceMs?: number
    reclaimReason?: 'session-ended' | 'idle' | 'operator'
    /** Tabs a reclamation could not close (beforeunload); reported, retried. */
    reclaimBlockedTabs?: TabId[]
}
/**
 * Spaces being reclaimed do not count against maxSpacesPerProfile, except those beyond
 * this reserve per profile: retained spaces (a task with an unknown write outcome left for
 * the user) cannot pile up unnoticed.
 */
export const RECLAIMING_SPACE_RESERVE = 2
export interface TaskMutation {
    patch: Partial<StoredTask>
    event: StoreEventInput
    business?: boolean
}
const stable = (value: unknown): string => JSON.stringify(value)
const checksum = (body: string): string => createHash('sha256').update(body).digest('hex')
const processInstanceId = randomUUID()
const journalError = (message = 'Task journal is unavailable'): BrowserRuntimeError => new BrowserRuntimeError('JOURNAL_UNAVAILABLE',
    message, true)
/** Task directories being deleted by retention; never loaded, finished on the next open. */
const PURGED_DIR = 'tasks-purged'
/** Single-writer, fsync-backed JSONL journal plus atomically replaced task checkpoints. */
export class TaskStore {
    private fencingToken = 0
    private lockHandle?: Awaited<ReturnType<typeof open>>
    private readonly tasks = new Map<TaskId, StoredTask>()
    private readonly spaces = new Map<TaskSpaceId, SpaceRecord>()
    private readonly revocations = new Set<string>()
    private readonly taskTails = new Map<TaskId, Promise<void>>()
    private metadataTail: Promise<void> = Promise.resolve()
    private readonly unreadableTasks = new Set<TaskId>()
    private readonly commitListeners = new Set<(task: StoredTask, event: TaskEvent) => void>()
    private readonly purgeListeners = new Set<(taskId: TaskId) => void>()
    private closed = false
    private constructor(readonly stateDir: string, private readonly faultInjector?: FaultInjector,
        private readonly now: () => number = Date.now) { }
    static async open(stateDir: string, faultInjector?: FaultInjector, now: () => number = Date.now): Promise<TaskStore> {
        const store = new TaskStore(stateDir, faultInjector, now)
        try {
            await store.acquire()
            await store.loadMetadata()
            await store.loadRevocations()
            await store.loadTasks()
            // A deletion a crash interrupted is finished now, or on the next retention run.
            await store.resumePurges().catch(() => undefined)
            return store
        }
        catch (error) {
            await store.close()
            throw error
        }
    }
    async close(): Promise<void> {
        if (this.closed)
            return
        this.closed = true
        await this.lockHandle?.close().catch(() => undefined)
        try {
            const lock = JSON.parse(await readFile(join(this.stateDir, 'writer.lock'), 'utf8')) as {
                fencingToken?: number
            }
            if (lock.fencingToken === this.fencingToken)
                await rm(join(this.stateDir, 'writer.lock'), { force: true })
        }
        catch { /* already removed */ }
    }
    async heartbeat(): Promise<void> {
        await this.assertWriter()
        await this.atomicWrite(join(this.stateDir, 'writer.lock'), {
            pid: process.pid,
            processInstanceId,
            fencingToken: this.fencingToken,
            heartbeatAtMs: this.now(),
        }, 'metadata')
    }
    async createSpace(record: SpaceRecord, maxSpacesPerProfile: number = POC_LIMITS.maxSpacesPerProfile): Promise<void> {
        await this.withMetadataQueue(async () => {
            await this.assertWriter()
            const open = [...this.spaces.values()].filter((space) => space.profileId === record.profileId && !space.closed)
            const reclaiming = open.filter((space) => space.reclaimingSinceMs !== undefined).length
            if (open.length - reclaiming + Math.max(0, reclaiming - RECLAIMING_SPACE_RESERVE) >= maxSpacesPerProfile)
                throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Profile has reached its space limit')
            this.spaces.set(record.taskSpaceId, structuredClone(record))
            try {
                await this.writeMetadata()
            } catch (error) {
                this.spaces.delete(record.taskSpaceId)
                throw error
            }
        })
    }
    getSpace(id: TaskSpaceId): SpaceRecord | undefined { const value = this.spaces.get(id); return value && structuredClone(value); }
    listSpaces(profileId?: ProfileId): SpaceRecord[] {
        return [...this.spaces.values()]
            .filter((space) => !profileId || space.profileId === profileId)
            .map((space) => structuredClone(space))
    }
    async updateSpace(id: TaskSpaceId, patch: Partial<SpaceRecord>): Promise<SpaceRecord> {
        const updated = await this.mutateSpace(id, () => patch)
        if (!updated) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space does not exist')
        return updated
    }
    async mutateSpace(id: TaskSpaceId, callback: (current: SpaceRecord) => Partial<SpaceRecord> | null): Promise<SpaceRecord | null> {
        return this.withMetadataQueue(async () => {
            await this.assertWriter()
            const space = this.spaces.get(id)
            if (!space) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space does not exist')
            const patch = callback(structuredClone(space))
            if (!patch) return null
            const previous = structuredClone(space)
            const nextPatch = structuredClone(patch)
            if (nextPatch.dedupe)
                nextPatch.dedupe = { ...space.dedupe, ...nextPatch.dedupe }
            Object.assign(space, nextPatch)
            try {
                await this.writeMetadata()
                return structuredClone(space)
            } catch (error) {
                this.spaces.set(id, previous)
                throw error
            }
        })
    }
    private async withMetadataQueue<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.metadataTail
        let release!: () => void
        this.metadataTail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try {
            return await operation()
        } finally {
            release()
        }
    }
    isRevoked(id: string): boolean { return this.revocations.has(id); }
    async revoke(id: string): Promise<void> {
        this.revocations.add(id)
        await this.writeRevocations()
    }
    getRevocations(): ReadonlySet<string> { return new Set(this.revocations); }
    /** Called after each task commit is durable. Listeners must not block; errors are ignored. */
    onCommitted(listener: (task: StoredTask, event: TaskEvent) => void): () => void {
        this.commitListeners.add(listener)
        return () => { this.commitListeners.delete(listener) }
    }
    /** Called once a task was deleted by retention. Listeners must not block; errors are ignored. */
    onPurged(listener: (taskId: TaskId) => void): () => void {
        this.purgeListeners.add(listener)
        return () => { this.purgeListeners.delete(listener) }
    }
    /** True for every task the store has, including ones whose journal is unreadable. */
    knowsTask(id: string): boolean { return this.tasks.has(id as TaskId) || this.unreadableTasks.has(id as TaskId) }
    /**
     * Retention (retentionDays): deletes terminal tasks without uncertain actions whose
     * last change is older than `retentionMs`, with their journal, checkpoint (approvals,
     * batches, request records) and the space records that refer to them. The task
     * directory is first renamed into tasks-purged/ (from then on the task is gone,
     * also after a crash); the references are dropped and the directory deleted after
     * that, and resumed on the next open or run if interrupted.
     */
    async purgeExpiredTasks(nowMs: number, retentionMs: number): Promise<TaskId[]> {
        await this.resumePurges()
        const purged: TaskId[] = []
        for (const task of this.expiredTasks(nowMs, retentionMs)) {
            if (await this.purgeTask(task.taskId))
                purged.push(task.taskId)
        }
        return purged
    }
    /** Terminal tasks without uncertain actions whose last change is older than `retentionMs`. */
    expiredTasks(nowMs: number, retentionMs: number): StoredTask[] {
        return [...this.tasks.values()].filter((task) => (TERMINAL_STATUSES as readonly string[]).includes(task.status)
            && !task.uncertainActions.length && nowMs - Number(task.updatedAtMs) > retentionMs).map((task) => structuredClone(task))
    }
    /**
     * Tabs of `task` still open in its space that no other task uses. Retention must close
     * them in the browser first: deleting their references would orphan the windows.
     */
    openTabsOf(task: Pick<StoredTask, 'taskId' | 'taskSpaceId' | 'tabs'>): TabId[] {
        const usedElsewhere = new Set([...this.tasks.values()].filter((other) => other.taskId !== task.taskId).flatMap((other) => other.tabs.map(String)))
        const open = new Set((this.spaces.get(task.taskSpaceId)?.tabs ?? []).map(String))
        return task.tabs.filter((tabId) => open.has(String(tabId)) && !usedElsewhere.has(String(tabId)))
    }
    /** Deletes one task as described for purgeExpiredTasks; false when it no longer exists or a tab of it is still open. */
    async purgeTask(id: TaskId): Promise<boolean> {
        return this.withTaskQueue(id, async () => {
            await this.assertWriter()
            const task = this.tasks.get(id)
            if (!task || this.openTabsOf(task).length)
                return false
            await this.faultInjector?.('purge-move')
            const purgedRoot = join(this.stateDir, PURGED_DIR)
            await mkdir(purgedRoot, { recursive: true })
            await rename(join(this.stateDir, 'tasks', id), join(purgedRoot, id))
            await this.syncDirectory(join(this.stateDir, 'tasks'))
            await this.syncDirectory(purgedRoot)
            this.tasks.delete(id)
            for (const listener of this.purgeListeners) {
                try { listener(id) } catch { /* observers never fail a purge */ }
            }
            await this.finishPurge(id, task)
            return true
        })
    }
    /** Finishes deletions a crash interrupted (tasks-purged/). */
    async resumePurges(): Promise<void> {
        const purgedRoot = join(this.stateDir, PURGED_DIR)
        let ids: string[]
        try {
            ids = await readdir(purgedRoot)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return
            throw error
        }
        for (const id of ids) {
            const task = await readFile(join(purgedRoot, id, 'task.json'), 'utf8').then((raw) => JSON.parse(raw) as StoredTask, () => undefined)
            await this.finishPurge(id as TaskId, task)
        }
    }
    /** Drop space references (tabs, request records), then delete the moved directory. Idempotent. */
    private async finishPurge(id: TaskId, task: StoredTask | undefined): Promise<void> {
        await this.withMetadataQueue(async () => {
            await this.assertWriter()
            const stillUsed = new Set([...this.tasks.values()].flatMap((other) => other.tabs.map(String)))
            const tabs = new Set((task?.tabs ?? []).map(String).filter((tabId) => !stillUsed.has(tabId)))
            const mentions = (value: unknown) => JSON.stringify(value ?? null).includes(`"${id}"`)
            let changed = false
            for (const space of this.spaces.values()) {
                const next: SpaceRecord = {
                    ...space,
                    tabs: space.tabs.filter((tabId) => !tabs.has(tabId)),
                    ...(space.goneTabs ? { goneTabs: space.goneTabs.filter((tabId) => !tabs.has(tabId)) } : {}),
                    ...(space.tabTargets ? { tabTargets: Object.fromEntries(Object.entries(space.tabTargets).filter(([tabId]) => !tabs.has(tabId))) } : {}),
                    ...(space.tabLeaseEpochs ? { tabLeaseEpochs: Object.fromEntries(Object.entries(space.tabLeaseEpochs).filter(([tabId]) => !tabs.has(tabId))) } : {}),
                    ...(space.profileUserOwner && tabs.has(space.profileUserOwner.tabId) ? { profileUserOwner: null } : {}),
                    ...(space.dedupe ? { dedupe: Object.fromEntries(Object.entries(space.dedupe).filter(([, entry]) => !mentions(entry.result))) } : {}),
                }
                if (stable(next) !== stable(space)) {
                    this.spaces.set(space.taskSpaceId, next)
                    changed = true
                }
            }
            if (changed)
                await this.writeMetadata()
        })
        await this.faultInjector?.('purge-delete')
        await rm(join(this.stateDir, PURGED_DIR, id), { recursive: true, force: true })
        await this.syncDirectory(join(this.stateDir, PURGED_DIR))
    }
    async createTask(task: StoredTask, event: StoreEventInput): Promise<StoredTask> {
        if (this.tasks.has(task.taskId))
            throw new BrowserRuntimeError('CONFLICT', 'Task already exists')
        await this.assertWriter()
        const initial = { ...structuredClone(task), lastSeq: 0 } as StoredTask
        this.tasks.set(task.taskId, initial)
        try {
            return await this.commit(task.taskId, {}, event)
        }
        catch (error) {
            this.tasks.delete(task.taskId)
            throw error
        }
    }
    getTask(id: TaskId): StoredTask | undefined {
        if (this.unreadableTasks.has(id))
            throw journalError('Task journal is unreadable')
        const value = this.tasks.get(id)
        return value && structuredClone(value)
    }
    markUnreadable(id: TaskId): void { this.unreadableTasks.add(id) }
    listTasks(): StoredTask[] { return [...this.tasks.values()].map((task) => structuredClone(task)); }
    async commit(id: TaskId, patch: Partial<StoredTask>, event: StoreEventInput, business = false): Promise<StoredTask> {
        return this.withTaskQueue(id, () => this.commitNow(id, patch, event, business))
    }
    async mutate(id: TaskId, callback: (current: StoredTask) => TaskMutation | null): Promise<StoredTask | null> {
        return this.withTaskQueue(id, async () => {
            await this.assertWriter()
            const current = this.tasks.get(id)
            if (!current)
                throw new BrowserRuntimeError('SCOPE_DENIED', 'Task does not exist')
            const mutation = callback(structuredClone(current))
            if (!mutation)
                return null
            return this.commitNow(id, mutation.patch, mutation.event, mutation.business ?? false)
        })
    }
    private async commitNow(id: TaskId, patch: Partial<StoredTask>, event: StoreEventInput, business = false): Promise<StoredTask> {
        await this.assertWriter()
        const current = this.tasks.get(id)
        if (!current)
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Task does not exist')
        const taskDir = join(this.stateDir, 'tasks', id)
        const eventFile = join(taskDir, 'events.jsonl')
        // A patch may pin stateVersion (bookkeeping such as request dedupe records):
        // the task did not change for the agent, so its expectedVersion must stay valid.
        const stateVersion = patch.stateVersion ?? current.stateVersion + 1
        const body: TaskEvent = { schemaVersion: SCHEMA_VERSION, taskId: id, seq: Number(current.highWatermarkSeq) + 1,
            ...structuredClone(event), stateVersion, data: event.data }
        const envelope = { body, checksum: checksum(stable(body)) }
        const bookkeeping = patch.stateVersion === current.stateVersion
        const next = { ...current, ...structuredClone(patch), stateVersion,
            updatedAtMs: bookkeeping ? current.updatedAtMs : event.atMs, highWatermarkSeq: body.seq, lastSeq: body.seq } as StoredTask
        const bytes = Buffer.byteLength(stable(next))
        const eventCount = body.seq
        if (business && (bytes > POC_LIMITS.journalMaxBytesPerTask
            || eventCount > POC_LIMITS.journalMaxEventsPerTask - POC_LIMITS.journalControlReserveEvents))
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task journal business quota reached')
        if (!business && eventCount > POC_LIMITS.journalMaxEventsPerTask)
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task journal control reserve is exhausted')
        let previousEventSize: number | undefined
        let eventAppended = false
        try {
            await mkdir(taskDir, { recursive: true })
            await this.faultInjector?.('event-append')
            const handle = await open(eventFile, 'a', 0o600)
            try {
                previousEventSize = (await handle.stat()).size
                await handle.writeFile(`${stable(envelope)}\n`)
                await handle.sync()
                eventAppended = true
            }
            finally {
                await handle.close()
            }
            await this.atomicWrite(join(taskDir, 'task.json'), next, 'task-replace')
            next.__events = [...(current.__events as TaskEvent[] | undefined ?? []), body]
            this.tasks.set(id, next)
            for (const listener of this.commitListeners) {
                try { listener(structuredClone(next), structuredClone(body)) } catch { /* observers never fail a commit */ }
            }
            return structuredClone(next)
        }
        catch (error) {
            if (eventAppended && previousEventSize !== undefined) {
                try {
                    await truncate(eventFile, previousEventSize)
                }
                catch {
                    this.unreadableTasks.add(id)
                }
            }
            throw journalError(error instanceof Error ? `Task journal write failed: ${error.message}` : undefined)
        }
    }
    private async withTaskQueue<T>(id: TaskId, operation: () => Promise<T>): Promise<T> {
        const previous = this.taskTails.get(id) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => { release = resolve; })
        const queued = previous.then(() => current)
        this.taskTails.set(id, queued)
        await previous
        try {
            return await operation()
        }
        finally {
            release()
            if (this.taskTails.get(id) === queued)
                this.taskTails.delete(id)
        }
    }
    events(id: TaskId, afterSeq = 0, nowMs = Date.now()): TaskEvent[] {
        const task = this.tasks.get(id)
        if (task && ['succeeded', 'failed', 'cancelled'].includes(task.status) && nowMs - task.updatedAtMs > POC_LIMITS.eventRetentionMs)
            return []
        return (task?.__events as TaskEvent[] | undefined ?? [])
            .filter((event) => event.seq > afterSeq)
            .map((event) => structuredClone(event))
    }
    private async acquire(): Promise<void> {
        await mkdir(this.stateDir, { recursive: true })
        await this.faultInjector?.('lock')
        const lockPath = join(this.stateDir, 'writer.lock')
        try {
            this.lockHandle = await open(lockPath, 'wx', 0o600)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw journalError()
            let lock: {
                pid: number
                processInstanceId?: string
                heartbeatAtMs?: number
                started?: number
            } | undefined
            try {
                lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
                    pid: number
                    processInstanceId?: string
                }
            }
            catch {
                lock = undefined
            }
            const heartbeatAtMs = Number(lock?.heartbeatAtMs ?? lock?.started ?? 0)
            const alive = heartbeatAtMs > 0 && this.now() - heartbeatAtMs <= 20_000
            if (alive)
                throw journalError('Task store already has a live writer')
            await rm(lockPath, { force: true })
            this.lockHandle = await open(lockPath, 'wx', 0o600)
        }
        const fencePath = join(this.stateDir, 'fencing')
        let previous = 0
        try {
            previous = Number(await readFile(fencePath, 'utf8')) || 0
        }
        catch { /* first writer */ }
        this.fencingToken = previous + 1
        const fence = await open(fencePath, 'w', 0o600)
        try {
            await fence.writeFile(String(this.fencingToken))
            await fence.sync()
        }
        finally {
            await fence.close()
        }
        await this.lockHandle.writeFile(stable({ pid: process.pid, processInstanceId,
            fencingToken: this.fencingToken, started: this.now(), heartbeatAtMs: this.now() }))
        await this.lockHandle.sync()
        await this.syncDirectory(this.stateDir)
    }
    private async assertWriter(): Promise<void> {
        if (this.closed)
            throw journalError('Task store is closed')
        let lock: {
            fencingToken?: number
        } | undefined
        try {
            lock = JSON.parse(await readFile(join(this.stateDir, 'writer.lock'), 'utf8')) as {
                fencingToken?: number
            }
        }
        catch {
            throw journalError()
        }
        let diskToken = 0
        try {
            diskToken = Number(await readFile(join(this.stateDir, 'fencing'), 'utf8'))
        }
        catch {
            throw journalError()
        }
        if (lock?.fencingToken !== this.fencingToken || diskToken !== this.fencingToken)
            throw journalError('Writer fencing token changed')
    }
    private async loadMetadata(): Promise<void> {
        try {
            const metadata = JSON.parse(await readFile(join(this.stateDir, 'spaces.json'), 'utf8')) as {
                schemaVersion: number
                spaces: SpaceRecord[]
            }
            if (metadata.schemaVersion !== SCHEMA_VERSION)
                throw journalError('Unknown metadata schema')
            for (const space of metadata.spaces)
                this.spaces.set(space.taskSpaceId, space)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error
        }
    }
    private async loadRevocations(): Promise<void> {
        try {
            const metadata = JSON.parse(await readFile(join(this.stateDir, 'revocations.json'), 'utf8')) as {
                schemaVersion: number
                ids: string[]
            }
            if (metadata.schemaVersion !== SCHEMA_VERSION)
                throw journalError('Unknown revocation schema')
            for (const id of metadata.ids)
                this.revocations.add(id)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error
        }
    }
    private async writeMetadata(): Promise<void> {
        await this.assertWriter()
        try {
            await this.atomicWrite(join(this.stateDir, 'spaces.json'), { schemaVersion: SCHEMA_VERSION,
                spaces: [...this.spaces.values()] }, 'metadata')
        }
        catch {
            throw journalError()
        }
    }
    private async writeRevocations(): Promise<void> {
        await this.assertWriter()
        try {
            await this.atomicWrite(join(this.stateDir, 'revocations.json'), { schemaVersion: SCHEMA_VERSION,
                ids: [...this.revocations] }, 'metadata')
        }
        catch {
            throw journalError()
        }
    }
    private async loadTasks(): Promise<void> {
        const taskRoot = join(this.stateDir, 'tasks')
        let dirs: string[]
        try {
            dirs = await readdir(taskRoot)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return
            throw error
        }
        for (const id of dirs) {
            const taskDir = join(taskRoot, id)
            try {
                let task: StoredTask
                try {
                    task = JSON.parse(await readFile(join(taskDir, 'task.json'), 'utf8')) as StoredTask
                }
                catch {
                    throw journalError('Task checkpoint is unreadable')
                }
                if (task.schemaVersion !== SCHEMA_VERSION)
                    throw journalError('Unknown task schema')
                const eventFile = join(taskDir, 'events.jsonl')
                let raw = ''
                try {
                    raw = await readFile(eventFile, 'utf8')
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error
                }
                const lines = raw.split('\n')
                const events: TaskEvent[] = []
                const committedLines: string[] = []
                let expectedSeq = 1
                let orphan = ''
                for (let index = 0; index < lines.length; index++) {
                    const line = lines[index]
                    if (!line)
                        continue
                    let envelope: {
                        body: TaskEvent
                        checksum: string
                    }
                    try {
                        envelope = JSON.parse(line) as typeof envelope
                    }
                    catch {
                        if (index === lines.length - 1 || (index === lines.length - 2 && !lines.at(-1))) {
                            orphan += `${line}\n`
                            continue
                        }
                        throw journalError('Task event journal has middle corruption')
                    }
                    if (envelope.checksum !== checksum(stable(envelope.body)) || envelope.body.seq !== expectedSeq)
                        throw journalError('Task event journal checksum or sequence is invalid')
                    expectedSeq += 1
                    if (envelope.body.seq <= Number(task.lastSeq ?? 0)) {
                        events.push(envelope.body)
                        committedLines.push(line)
                    }
                    else
                        orphan += `${line}\n`
                }
                if (orphan)
                    await writeFile(join(taskDir, 'events.orphan.jsonl'), orphan, { flag: 'a', mode: 0o600 })
                if (committedLines.length !== lines.filter(Boolean).length)
                    await this.atomicReplaceText(eventFile, committedLines.length ? `${committedLines.join('\n')}\n` : '')
                task.__events = events
                this.tasks.set(task.taskId, task)
            }
            catch {
                this.unreadableTasks.add(id as TaskId)
            }
        }
    }
    private async atomicWrite(file: string, value: unknown, fault: 'task-replace' | 'metadata'): Promise<void> {
        const dir = join(file, '..')
        await mkdir(dir, { recursive: true })
        const temporary = join(dir, `.${randomUUID()}.tmp`)
        try {
            await this.faultInjector?.(fault)
            const handle = await open(temporary, 'wx', 0o600)
            try {
                await handle.writeFile(stable(value))
                await handle.sync()
            }
            finally {
                await handle.close()
            }
            await rename(temporary, file)
            await this.syncDirectory(dir)
        }
        catch (error) {
            await rm(temporary, { force: true })
            throw error
        }
    }
    private async atomicReplaceText(file: string, value: string): Promise<void> {
        const dir = join(file, '..')
        const temporary = join(dir, `.${randomUUID()}.tmp`)
        const handle = await open(temporary, 'wx', 0o600)
        try {
            await handle.writeFile(value)
            await handle.sync()
        }
        finally {
            await handle.close()
        }
        await rename(temporary, file)
        await this.syncDirectory(dir)
    }
    private async syncDirectory(dir: string): Promise<void> { const handle = await open(dir, 'r'); try {
        await handle.sync()
    }
    finally {
        await handle.close()
    } }
}
