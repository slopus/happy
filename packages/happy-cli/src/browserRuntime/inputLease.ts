import { BrowserRuntimeError, type InputOwner, type ProfileId, type TabId, type TaskId } from './contracts'

interface TabLease { owner: InputOwner; epoch: number; profileId: ProfileId }
interface PendingTakeover {
    taskId: TaskId
    owner: Extract<InputOwner, { kind: 'user' }>
}

/** In-memory dispatch fence. Persisted task state remains owned by TaskStore. */
export class InputLeaseManager {
    private readonly tabs = new Map<TabId, TabLease>()
    private readonly taskTabs = new Map<TaskId, Set<TabId>>()
    private readonly pendingTakeovers = new Map<TabId, PendingTakeover>()
    private readonly listeners = new Set<() => void>()
    private readonly externalFences = new Map<symbol, ProfileId>()

    /**
     * Keeps every new input owner off the profile until the returned function
     * is called (idempotent): agents cannot acquire, users cannot take over,
     * and userControl reports settling so no viewer's input passes. The viewer
     * holds this while x11vnc may still be consuming human input written before
     * control was lost (D2). Setting and lifting notify subscribers.
     */
    fenceProfile(profileId: ProfileId): () => void {
        const token = Symbol('fence')
        this.externalFences.set(token, profileId)
        this.changed()
        return () => {
            if (this.externalFences.delete(token)) this.changed()
        }
    }

    /** Called after every lease change; viewer connections re-check their control here (D2). */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    /** The profile's user-owned tabs, and whether a takeover still waits for an in-flight driver call or a drain fence. */
    userControl(profileId: ProfileId): { tabs: Array<{ tabId: TabId; leaseEpoch: number; owner: Extract<InputOwner, { kind: 'user' }> }>; settling: boolean } {
        const tabs: Array<{ tabId: TabId; leaseEpoch: number; owner: Extract<InputOwner, { kind: 'user' }> }> = []
        for (const [tabId, lease] of this.tabs) {
            if (lease.profileId === profileId && lease.owner.kind === 'user') tabs.push({ tabId, leaseEpoch: lease.epoch, owner: structuredClone(lease.owner) })
        }
        const settling = this.isDrainFenced(profileId)
            || [...this.pendingTakeovers.keys()].some((tabId) => this.tabs.get(tabId)?.profileId === profileId)
        return { tabs, settling }
    }

    acquire(tabId: TabId, profileId: ProfileId, owner: Extract<InputOwner, { kind: 'agent' }>): number {
        if (this.isUserFenced(profileId)) throw new BrowserRuntimeError('STALE_LEASE', 'User input fences the whole profile')
        const lease = this.get(tabId, profileId)
        if (lease.owner.kind !== 'none' && (lease.owner.kind !== 'agent' || lease.owner.taskId !== owner.taskId || lease.owner.segmentId !== owner.segmentId)) {
            throw new BrowserRuntimeError('STALE_LEASE', 'Tab input is owned by another segment')
        }
        lease.owner = owner
        this.taskTabs.set(owner.taskId, (this.taskTabs.get(owner.taskId) ?? new Set()).add(tabId))
        this.changed()
        return lease.epoch
    }

    restore(tabId: TabId, profileId: ProfileId, previousEpoch: number, owner: InputOwner = { kind: 'none' }): number {
        const lease = this.get(tabId, profileId)
        lease.epoch = Math.max(lease.epoch, previousEpoch) + 1
        lease.owner = structuredClone(owner)
        this.changed()
        return lease.epoch
    }

    takeOver(tabId: TabId, profileId: ProfileId, owner: Extract<InputOwner, { kind: 'user' }>): number {
        this.assertNotDrainFenced(profileId)
        const priorUser = [...this.tabs.values()].find((tab) => tab.profileId === profileId && tab.owner.kind === 'user')
        if (priorUser?.owner.kind === 'user' && (priorUser.owner.principalId !== owner.principalId || priorUser.owner.viewerSessionId !== owner.viewerSessionId)) throw new BrowserRuntimeError('STALE_LEASE', 'Another viewer owns profile input')
        const lease = this.get(tabId, profileId)
        lease.epoch += 1
        lease.owner = owner
        this.changed()
        return lease.epoch
    }

    fenceForTakeover(tabId: TabId, profileId: ProfileId, taskId: TaskId,
        owner: Extract<InputOwner, { kind: 'user' }>): number {
        this.assertNotDrainFenced(profileId)
        const priorUser = [...this.tabs.values()].find((tab) => tab.profileId === profileId && tab.owner.kind === 'user')
        if (priorUser?.owner.kind === 'user'
            && (priorUser.owner.principalId !== owner.principalId || priorUser.owner.viewerSessionId !== owner.viewerSessionId))
            throw new BrowserRuntimeError('STALE_LEASE', 'Another viewer owns profile input')
        const lease = this.get(tabId, profileId)
        lease.epoch += 1
        lease.owner = { kind: 'none' }
        this.pendingTakeovers.set(tabId, { taskId, owner })
        this.changed()
        return lease.epoch
    }

    completePendingTakeovers(taskId: TaskId): Array<{ tabId: TabId; owner: InputOwner; leaseEpoch: number }> {
        const completed: Array<{ tabId: TabId; owner: InputOwner; leaseEpoch: number }> = []
        for (const [tabId, pending] of this.pendingTakeovers) {
            if (pending.taskId !== taskId)
                continue
            const lease = this.tabs.get(tabId)
            if (!lease)
                continue
            lease.owner = pending.owner
            this.pendingTakeovers.delete(tabId)
            completed.push({ tabId, owner: structuredClone(lease.owner), leaseEpoch: lease.epoch })
        }
        if (completed.length) this.changed()
        return completed
    }

    release(tabId: TabId, profileId: ProfileId): number {
        const lease = this.get(tabId, profileId)
        this.pendingTakeovers.delete(tabId)
        lease.epoch += 1
        lease.owner = { kind: 'none' }
        this.changed()
        return lease.epoch
    }

    assert(tabId: TabId, profileId: ProfileId, taskId: TaskId, segmentId: string, epoch: number): void {
        if (this.isUserFenced(profileId))
            throw new BrowserRuntimeError('STALE_LEASE', 'User input fences the whole profile')
        const lease = this.get(tabId, profileId)
        if (lease.owner.kind !== 'agent' || lease.owner.taskId !== taskId || lease.owner.segmentId !== segmentId || lease.epoch !== epoch) {
            throw new BrowserRuntimeError('STALE_LEASE', 'Input lease changed before dispatch')
        }
    }

    revokeTask(taskId: TaskId): Array<{ tabId: TabId; leaseEpoch: number }> {
        const revoked: Array<{ tabId: TabId; leaseEpoch: number }> = []
        for (const tabId of this.taskTabs.get(taskId) ?? []) {
            const lease = this.tabs.get(tabId)
            if (lease?.owner.kind === 'agent' && lease.owner.taskId === taskId) {
                revoked.push({ tabId, leaseEpoch: this.release(tabId, lease.profileId) })
            }
        }
        let settledPending = false
        for (const [tabId, pending] of this.pendingTakeovers) {
            if (pending.taskId === taskId) {
                this.pendingTakeovers.delete(tabId)
                settledPending = true
            }
        }
        this.taskTabs.delete(taskId)
        if (settledPending) this.changed()
        return revoked
    }

    owner(tabId: TabId, profileId: ProfileId): { owner: InputOwner; leaseEpoch: number } {
        const { owner, epoch } = this.get(tabId, profileId)
        return { owner: structuredClone(owner), leaseEpoch: epoch }
    }

    isUserFenced(profileId: ProfileId): boolean {
        return this.isDrainFenced(profileId)
            || [...this.tabs.values()].some((tab) => tab.profileId === profileId && tab.owner.kind === 'user')
            || [...this.pendingTakeovers.keys()].some((tabId) => this.tabs.get(tabId)?.profileId === profileId)
    }

    private isDrainFenced(profileId: ProfileId): boolean {
        return [...this.externalFences.values()].includes(profileId)
    }

    private assertNotDrainFenced(profileId: ProfileId): void {
        if (this.isDrainFenced(profileId)) throw new BrowserRuntimeError('STALE_LEASE', 'Earlier viewer input is still draining', true)
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            // A listener fault must never interrupt a lease transition.
            try { listener() } catch { /* ignored */ }
        }
    }

    private get(tabId: TabId, profileId: ProfileId): TabLease {
        let lease = this.tabs.get(tabId)
        if (!lease) {
            lease = { owner: { kind: 'none' }, epoch: 0, profileId }
            this.tabs.set(tabId, lease)
        }
        if (lease.profileId !== profileId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab profile mismatch')
        return lease
    }
}
