import { randomUUID } from 'node:crypto'
import { BrowserRuntimeError, POC_LIMITS, SCHEMA_VERSION, TERMINAL_STATUSES, type ActionId, type AgentGrant, type AuthContext, type BatchId,
    type BatchResult, type BatchStep, type BrowserDriver, type BrowserInstanceId, type BrowserRuntimeApi, type GrantId,
        type ApproveResult, type ControlResult, type RuntimeErrorBody, type SnapshotId, type InputOwner, type Operation,
            type ProfileId, type RequestId, type TaskEvent, type TaskId, type TaskSpaceId, type TaskView, type TaskStatus,
                type TabId, type ApprovalId,
                type DispatchExpectation, type ElementDescription, type ElementRef, type Observation, type ScreenshotResult, type SubscribeResult } from './contracts'
import { assertOperation } from './auth'
import { approvalPayloadHash, createApproval } from './approvals'
import { dispatchStep } from './batchWorker'
import { systemClock, type RuntimeClock } from './clock'
import { InputLeaseManager } from './inputLease'
import { approvalBinding, assertAllowedOrigin, assertSiteAllowed, classifySiteAction, classifyUserWait, loginCompleted, payloadHash, redact, type SitePolicy } from './policy'
import { RECLAIMING_SPACE_RESERVE, TaskStore, type SpaceRecord, type StoredTask, type StoreEventInput } from './taskStore'
import { browserInstanceMatches, inFlightWriteActions } from './recovery'
import { transitionTask } from './stateMachine'
export interface BrowserRuntimeOptions {
    store: TaskStore
    drivers: Map<ProfileId, BrowserDriver> | Record<string, BrowserDriver>
    clock?: RuntimeClock
    /** Site allowlist and action policy (D7). Origins outside it cannot be opened, whatever a grant allows. */
    sites: SitePolicy[]
    /** Open spaces per profile (runtime.json; the PoC limit without configuration). */
    maxSpacesPerProfile?: number
    /** Close spaces whose tasks are all finished after this long without activity; off when absent. */
    spaceIdleReclaimMs?: number
}
/** What one reclamation pass did (or could not do) for a space. */
export interface SpaceReclaimReport {
    taskSpaceId: TaskSpaceId
    reason: NonNullable<SpaceRecord['reclaimReason']>
    closed: boolean
    closedTabs: TabId[]
    /** beforeunload kept these open; retried on the next pass. */
    blockedTabs?: TabId[]
    /** A user holds these, or the browser could not close them; retried. */
    failedTabs?: TabId[]
    /** Tasks with an unknown write outcome, kept (paused) for the user. */
    retained?: TaskId[]
    /** Cancelled tasks whose batch has not stopped yet. */
    waiting?: TaskId[]
}
/** One space as the operator sees it (admin socket). */
export interface SpaceSummary {
    taskSpaceId: TaskSpaceId
    profileId: ProfileId
    agentSessionId?: string
    createdAtMs: number
    ageMs: number
    closed: boolean
    /** Counts against maxSpacesPerProfile (see RECLAIMING_SPACE_RESERVE for reclaiming ones). */
    counted: boolean
    reclaimReason?: SpaceRecord['reclaimReason']
    reclaimBlockedTabs?: TabId[]
    tabs: TabId[]
    tasks: Array<{ taskId: TaskId; agentSessionId: string; status: TaskView['status']; pauseReason?: string; uncertainActions: number; updatedAtMs: number }>
}
type DriverWithAction = BrowserDriver & {
    armAction?: (actionId: string) => void
}
/** How a user wait is recognised as done (`task.waitCompletion`). */
type UserWaitCompletion = {
    batchId?: string
    nextStep?: number
    tabId: TabId
    predicate?: BatchStep['until']
    notPathPrefix?: string
    /** The site whose loginCompleteWhen decides a login wait. */
    protectedOrigin?: string
    handoff?: true
}
/** Durable, scoped task runtime. Driver awaits never hold the task commit queue. */
/** Finished tasks are not offered to the console; the listing is bounded (D12). */
const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set(TERMINAL_STATUSES)
const LIST_TASKS_LIMIT = 50


export class BrowserRuntime implements BrowserRuntimeApi {
    readonly leases = new InputLeaseManager()
    private readonly drivers: Map<ProfileId, BrowserDriver>
    private readonly clock: RuntimeClock
    private readonly controllers = new Map<TaskId, AbortController>()
    private readonly workers = new Map<TaskId, Promise<BatchResult>>()
    private readonly inFlightDriverCalls = new Set<TaskId>()
    private readonly latestAgentSnapshots = new Map<TabId, SnapshotId>()
    private readonly liveBatchSteps = new Map<BatchId, BatchStep[]>()
    /** Profiles between a driver disconnect and the end of its reconnect handling (which alone judges browser identity) */
    private readonly reconnecting = new Set<ProfileId>()
    private readonly latestAgentUrls = new Map<TabId, string>()
    private readonly commitTails = new Map<TaskId, Promise<unknown>>()
    private readonly eventWaiters = new Map<TaskId, Set<() => void>>()
    private readonly requestFlights = new Map<string, { hash: string; promise: Promise<unknown> }>()
    private readonly recovery: Promise<void>
    constructor(private readonly options: BrowserRuntimeOptions) {
        this.drivers = options.drivers instanceof Map ? options.drivers : new Map(Object.entries(options.drivers) as [
            ProfileId,
            BrowserDriver
        ][])
        this.clock = options.clock ?? systemClock
        this.recovery = this.recoverExistingTasks().catch(() => undefined)
    }
    createSpace: BrowserRuntimeApi['createSpace'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'createSpace', ...req }, () => this.createSpaceImpl(auth, req))
    createTask: BrowserRuntimeApi['createTask'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'createTask', ...req }, () => this.createTaskImpl(auth, req))
    openPage: BrowserRuntimeApi['openPage'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'openPage', ...req }, () => this.openPageImpl(auth, req))
    closePage: BrowserRuntimeApi['closePage'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'closePage', ...req }, () => this.closePageImpl(auth, req))
    submitBatch: BrowserRuntimeApi['submitBatch'] = (auth, req, opts) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'submitBatch', ...req }, () => this.submitBatchImpl(auth, req, opts))
    finishTask: BrowserRuntimeApi['finishTask'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'finishTask', ...req }, () => this.finishTaskImpl(auth, req))
    approve: BrowserRuntimeApi['approve'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'approve', ...req }, () => this.approveImpl(auth, req))
    takeOver: BrowserRuntimeApi['takeOver'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'takeOver', ...req }, () => this.takeOverImpl(auth, req))
    releaseControl: BrowserRuntimeApi['releaseControl'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'releaseControl', ...req }, () => this.releaseControlImpl(auth, req))
    resume: BrowserRuntimeApi['resume'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'resume', ...req }, () => this.resumeImpl(auth, req))
    cancel: BrowserRuntimeApi['cancel'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'cancel', ...req }, () => this.cancelImpl(auth, req))
    closeSpace: BrowserRuntimeApi['closeSpace'] = (auth, req) =>
        this.withRequestFlight(auth, req.requestId, { operation: 'closeSpace', ...req }, () => this.closeSpaceImpl(auth, req))

    private async createSpaceImpl(auth: AuthContext, req: {
        profileId: ProfileId
        requestId: RequestId
    }): Promise<{
        taskSpaceId: TaskSpaceId
    }> {
        await this.recovery
        this.checkCredential(auth, 'createSpace', req.profileId)
        const requestKeyValue = requestKey(auth, req.requestId)
        const existing = this.options.store.listSpaces().find((space) => space.requestKey === requestKeyValue)
        if (existing) {
            if (existing.requestHash !== payloadHash({ operation: 'createSpace', ...req }))
                throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return { taskSpaceId: existing.taskSpaceId }
        }
        const taskSpaceId = `space-${randomUUID()}` as TaskSpaceId
        await this.options.store.createSpace({ taskSpaceId, profileId: req.profileId, createdAtMs: this.clock.now(), tabs: [],
            tabTargets: {}, tabLeaseEpochs: {},
            owner: identity(auth), requestKey: requestKeyValue, requestHash: payloadHash({ operation: 'createSpace', ...req }),
                dedupe: {}, ...(auth.credential.kind === 'agent-grant' ? { agentSessionId: auth.credential.agentSessionId } : {}) },
            this.options.maxSpacesPerProfile)
        return { taskSpaceId }
    }
    private async createTaskImpl(auth: AuthContext, req: {
        taskSpaceId: TaskSpaceId
        requestId: RequestId
    }): Promise<TaskView> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'createTask', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.findRequest(req.requestId, auth)
        if (duplicate) {
            if (duplicate.hash !== payloadHash({ operation: 'createTask', ...req }))
                throw new BrowserRuntimeError('CONFLICT', 'requestId payload differs')
            return this.view(duplicate.result as StoredTask)
        }
        this.assertSpaceOpen(space)
        const now = this.clock.now()
        const taskId = `task-${randomUUID()}` as TaskId
        const credential = auth.credential as AgentGrant
        const task: StoredTask = { schemaVersion: SCHEMA_VERSION, taskId, taskSpaceId: req.taskSpaceId, profileId: space.profileId,
            agentSessionId: credential.agentSessionId, status: 'queued', cancelRequested: false, stateVersion: 0, highWatermarkSeq: 0,
                tabs: [], tabTargets: {}, tabLeaseEpochs: {}, uncertainActions: [], createdAtMs: now, updatedAtMs: now,
                    owner: identity(auth), agentGrant: credential,
                    actions: {}, approvals: {}, batches: {}, dedupe: {},
                    browserInstanceId: this.driver(space.profileId).browserInstanceId() }
        const saved = await this.options.store.createTask(task, this.event('task-created', { taskSpaceId: req.taskSpaceId }, 0))
        const stored = await this.saveRequest(saved, auth, req.requestId, { operation: 'createTask', ...req }, this.view(saved))
        return this.view(stored)
    }
    private async openPageImpl(auth: AuthContext, req: {
        taskId: TaskId
        url: string
        requestId: RequestId
    }): Promise<{
        tabId: TabId
        actionId: ActionId
        url: string
        task: TaskView
    }> {
        await this.recovery
        let task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'openPage', task)
        const duplicate = this.taskRequest(task, auth, req.requestId, { operation: 'openPage', ...req })
        if (duplicate)
            return duplicate as {
                tabId: TabId
                actionId: ActionId
                url: string
                task: TaskView
            }
        this.assertSpaceOpen(this.requireSpace(task.taskSpaceId))
        this.assertCanStart(task)
        if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) {
            await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed',
                { pauseReason: 'task-time-limit' })
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task time limit reached')
        }
        assertSiteAllowed(this.options.sites, req.url)
        // The same navigation policy as a navigate step; a held page is not opened (there is no tab to hand over yet).
        const navigation = classifySiteAction(this.options.sites, { kind: 'navigate', url: req.url } as BatchStep)
        if (navigation === 'deny')
            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Site policy refuses this destination')
        if (navigation !== 'auto')
            throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'Site policy requires the user for this page; it was not opened', false, false)
        const grant = this.agentGrant(auth)
        const origin = assertAllowedOrigin(req.url, grant)
        const driver = this.driver(task.profileId)
        const totalTabs = this.options.store.listSpaces(task.profileId).reduce((sum, item) => sum + item.tabs.length, 0)
        if (totalTabs >= POC_LIMITS.maxActiveTabs)
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Profile has reached its active tab limit')
        const actionId = `action-${randomUUID()}` as ActionId
        const reservation = this.allocateTabId()
        const epoch = this.leases.acquire(reservation, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId,
            taskId: task.taskId, segmentId: actionId })
        try {
            const started = await this.options.store.mutate(task.taskId, (current) => {
                this.assertCanStart(current)
                if (current.stateVersion !== task.stateVersion)
                    throw new BrowserRuntimeError('CONFLICT', 'Task version changed before page open')
                const next = transitionTask({ status: current.status, pauseReason: current.pauseReason }, { type: 'start' })
                return {
                    patch: {
                        ...next,
                        currentBatchId: undefined,
                        actions: { ...current.actions, [actionId]: {
                            state: 'intent-committed',
                            kind: 'navigate',
                            grantId: grant.grantId,
                            payloadHash: payloadHash({ url: req.url }),
                            leaseEpoch: epoch,
                            browserInstanceId: driver.browserInstanceId(),
                        } },
                        dedupe: { ...current.dedupe, [requestKey(auth, req.requestId)]: {
                            hash: payloadHash({ operation: 'openPage', ...req }),
                            result: redact({ tabId: reservation, actionId, url: req.url,
                                task: this.view({ ...current, ...next,
                                    actions: { ...current.actions, [actionId]: { state: 'intent-committed', kind: 'navigate',
                                        grantId: grant.grantId, payloadHash: payloadHash({ url: req.url }), leaseEpoch: epoch,
                                        browserInstanceId: driver.browserInstanceId() } },
                                    stateVersion: current.stateVersion + 1,
                                    highWatermarkSeq: current.highWatermarkSeq + 1,
                                    updatedAtMs: this.clock.now(),
                                } as StoredTask),
                            }),
                        } },
                    },
                    event: this.event('action-intent', { actionId, kind: 'navigate',
                        url: redact(req.url), phase: 'intent-committed' }, current.stateVersion + 1, epoch),
                }
            })
            if (!started)
                throw new BrowserRuntimeError('CONFLICT', 'Task changed before page open')
            task = started
        }
        catch (error) {
            this.leases.release(reservation, task.profileId)
            throw error
        }
        const controller = new AbortController()
        this.controllers.set(task.taskId, controller)
        ;(driver as DriverWithAction).armAction?.(actionId)
        this.leases.assert(reservation, task.profileId, task.taskId, actionId, epoch)
        let handle: Awaited<ReturnType<BrowserDriver['openTab']>>
        try {
            handle = await driver.openTab(req.url, grant.allowedOrigins, { signal: controller.signal, timeoutMs: 30000 })
        }
        catch (error) {
            this.leases.release(reservation, task.profileId)
            const current = this.requireTask(task.taskId)
            if (error instanceof BrowserRuntimeError && error.code === 'ORIGIN_DENIED'
                && !error.mayHaveSideEffects) {
                await this.commit(current, {
                    status: 'failed',
                    actions: { ...current.actions, [actionId]: { ...current.actions[actionId], state: 'failed' } },
                }, 'action-failed', { actionId, error: safeError(error) }, epoch)
                throw error
            }
            // The driver refuses before creating any target when its agent windows are all in use:
            // nothing happened, so the agent may close a page and open again.
            if (error instanceof BrowserRuntimeError && error.code === 'QUOTA_EXCEEDED' && !error.mayHaveSideEffects) {
                await this.commit(current, {
                    status: 'paused',
                    pauseReason: 'awaiting-agent',
                    actions: { ...current.actions, [actionId]: { ...current.actions[actionId], state: 'failed' } },
                }, 'action-failed', { actionId, error: safeError(error) }, epoch)
                throw error
            }
            if (!current.cancelRequested)
                await this.commit(current, { status: 'paused', pauseReason: 'outcome-unknown', actions: { ...current.actions,
                    [actionId]: { ...current.actions[actionId], state: 'uncertain' } }, uncertainActions: [...current.uncertainActions,
                        actionId] }, 'action-uncertain', { actionId, error: safeError(error) }, epoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open result is uncertain', false, true)
        }
        const afterOpenTask = this.requireTask(task.taskId)
        const leaseAfterOpen = this.leases.owner(reservation, task.profileId)
        const browserChanged = afterOpenTask.browserInstanceId !== driver.browserInstanceId()
        if (afterOpenTask.cancelRequested || !this.isCredentialLive(auth) || leaseAfterOpen.leaseEpoch !== epoch
            || afterOpenTask.status !== 'running' || browserChanged) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 }).catch(() => undefined)
            if (leaseAfterOpen.owner.kind === 'agent' && leaseAfterOpen.owner.taskId === task.taskId)
                this.leases.release(reservation, task.profileId)
            const actions = { ...afterOpenTask.actions, [actionId]: { ...afterOpenTask.actions[actionId], state: 'uncertain' as const } }
            await this.commit(afterOpenTask, { actions, uncertainActions: [...new Set([...afterOpenTask.uncertainActions, actionId])],
                ...(!this.isCredentialLive(auth) && !afterOpenTask.cancelRequested ? { status: 'paused',
                    pauseReason: 'grant-expired' } : browserChanged ? { status: 'paused', pauseReason: 'browser-replaced' } : {}) },
                        'late-result', { actionId, lateOpen: true, browserChanged }, epoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open completed after its execution fence changed', false, true)
        }
        const finalOrigin = await driver.currentOrigin(handle.tabId)
        if (!grant.allowedOrigins.includes(finalOrigin)) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 })
            this.leases.release(reservation, task.profileId)
            const current = this.requireTask(task.taskId)
            await this.commit(current, { status: 'failed', actions: { ...current.actions, [actionId]: { ...current.actions[actionId],
                state: 'failed' } } }, 'action-failed', { actionId, code: 'ORIGIN_DENIED' }, epoch)
            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Navigation ended at a disallowed origin')
        }
        const finalObservation = await driver.observe(handle.tabId, grant.allowedOrigins, { timeoutMs: 10000 })
        const waitReason = classifyUserWait(finalObservation.url)
        this.leases.release(reservation, task.profileId)
        const dispatched = this.requireTask(task.taskId)
        await this.commit(dispatched, { actions: { ...dispatched.actions, [actionId]: { ...dispatched.actions[actionId],
            state: 'dispatched' } } }, 'action-dispatched', { actionId }, epoch)
        const tabEpoch = this.leases.acquire(handle.tabId, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId,
            taskId: task.taskId, segmentId: actionId })
        const next = this.requireTask(task.taskId)
        const after = await this.options.store.mutate(next.taskId, (current) => {
            if (current.status !== 'running' || current.cancelRequested || !this.isCredentialLive(auth)
                || current.browserInstanceId !== driver.browserInstanceId())
                return null
            return {
                patch: {
                    tabs: [...new Set([...current.tabs, handle.tabId])],
                    tabTargets: { ...current.tabTargets, [handle.tabId]: handle.targetId },
                    tabLeaseEpochs: { ...current.tabLeaseEpochs, [handle.tabId]: tabEpoch },
                    status: waitReason ? 'awaiting-user' : 'paused',
                    pauseReason: waitReason ? undefined : 'awaiting-agent',
                    ...(waitReason ? { waitReason, waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs,
                        waitCompletion: { tabId: handle.tabId,
                            notPathPrefix: waitReason === 'login' ? '/login' : '/challenge' } } : {}),
                    browserInstanceId: driver.browserInstanceId(),
                    actions: { ...current.actions, [actionId]: { ...current.actions[actionId], state: 'confirmed' } },
                },
                event: this.event('page-opened', { tabId: handle.tabId, actionId, origin: finalOrigin },
                    current.stateVersion + 1, tabEpoch),
            }
        })
        if (!after) {
            await driver.closeTab(handle.tabId, { timeoutMs: 5000 }).catch(() => undefined)
            const current = this.requireTask(task.taskId)
            await this.commit(current, { actions: { ...current.actions, [actionId]: { ...current.actions[actionId],
                state: 'uncertain' } }, uncertainActions: [...new Set([...current.uncertainActions, actionId])] },
                    'late-result', { actionId, lateOpen: true, ignored: true }, tabEpoch)
            throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'Page open completed after its execution fence changed', false, true)
        }
        if (this.controllers.get(task.taskId) === controller)
            this.controllers.delete(task.taskId)
        // Derived from the space as it is inside the store queue: concurrent opens in one space must not drop each other's tabs.
        await this.options.store.mutateSpace(task.taskSpaceId, (space) => ({
            tabs: [...space.tabs, handle.tabId],
            tabTargets: { ...space.tabTargets, [handle.tabId]: handle.targetId },
            tabLeaseEpochs: { ...space.tabLeaseEpochs, [handle.tabId]: tabEpoch },
        }))
        const result = { tabId: handle.tabId, actionId, url: redact(req.url), task: this.view(after) }
        await this.saveTaskRequest(after, auth, req.requestId, { operation: 'openPage', ...req }, result)
        const releasedEpoch = this.leases.release(handle.tabId, task.profileId)
        await this.persistTabLease(task.taskId, task.taskSpaceId, handle.tabId, releasedEpoch)
        return result
    }
    private async closePageImpl(auth: AuthContext, req: {
        taskSpaceId: TaskSpaceId
        tabId: TabId
        requestId: RequestId
    }): Promise<{
        closed: boolean
        handoff?: 'beforeunload'
    }> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'closePage', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.spaceRequest(space, auth, req.requestId, { operation: 'closePage', ...req })
        if (duplicate)
            return duplicate as {
                closed: boolean
                handoff?: 'beforeunload'
            }
        if (!space.tabs.includes(req.tabId) && space.goneTabs?.includes(req.tabId)) {
            const response = { closed: false }
            await this.options.store.mutateSpace(req.taskSpaceId, (current) => ({
                dedupe: this.spaceDedupe(current, auth, req.requestId, { operation: 'closePage', ...req }, response),
            }))
            return response
        }
        if (!space.tabs.includes(req.tabId))
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab is not registered to this task space')
        const refs = this.options.store.listTasks().filter((task) => task.tabs.includes(req.tabId) && (!['succeeded', 'failed',
            'cancelled'].includes(task.status) || this.workers.has(task.taskId)))
        if (refs.length)
            throw new BrowserRuntimeError('CONFLICT', 'Tab is referenced by a non-terminal task')
        const lease = this.leases.owner(req.tabId, space.profileId)
        if (lease.owner.kind !== 'none')
            throw new BrowserRuntimeError('STALE_LEASE', 'Tab has an input owner')
        const result = await this.driver(space.profileId).closeTab(req.tabId, { timeoutMs: 5000 })
        if (result.beforeUnloadBlocked)
            return { closed: false, handoff: 'beforeunload' }
        if (!result.closed)
            return { closed: false }
        const response = { closed: result.closed }
        await this.options.store.mutateSpace(req.taskSpaceId, (current) => {
            const { [req.tabId]: _target, ...tabTargets } = current.tabTargets ?? {}
            const { [req.tabId]: _epoch, ...tabLeaseEpochs } = current.tabLeaseEpochs ?? {}
            return {
                tabs: current.tabs.filter((tab) => tab !== req.tabId),
                goneTabs: [...new Set([...(current.goneTabs ?? []), req.tabId])],
                tabTargets, tabLeaseEpochs,
                dedupe: this.spaceDedupe(current, auth, req.requestId, { operation: 'closePage', ...req }, response),
            }
        })
        return response
    }
    async observe(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
        maxElements?: number
        scopeRef?: ElementRef
    }): Promise<Observation> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'observe', task)
        this.assertTaskTab(task, req.tabId)
        if (task.status === 'awaiting-user' && task.waitReason === 'approval'
            && Object.values(task.approvals).some((approval) => approval.state === 'pending'
                && task.batches[String(approval.batchId)]?.steps[Number(approval.nextStep)]?.tabId === req.tabId))
            throw new BrowserRuntimeError('CONFLICT', 'The tab snapshot is bound to a pending approval')
        const result = await this.driver(task.profileId).observe(req.tabId, this.agentGrant(auth).allowedOrigins, { timeoutMs: 30000,
            maxElements: req.maxElements, scopeRef: req.scopeRef })
        if (!this.agentGrant(auth).allowedOrigins.includes(new URL(result.url).origin))
            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Observed page origin is not allowed')
        this.latestAgentSnapshots.set(req.tabId, result.snapshotId)
        this.latestAgentUrls.set(req.tabId, result.url)
        return sanitizeObservation(result, this.agentGrant(auth).allowedOrigins)
    }
    async screenshot(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
    }): Promise<ScreenshotResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'screenshot', task)
        this.assertTaskTab(task, req.tabId)
        return this.driver(task.profileId).screenshot(req.tabId, this.agentGrant(auth).allowedOrigins, { timeoutMs: 30000 })
    }
    private async submitBatchImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
        steps: BatchStep[]
    }, opts?: {
        waitMs?: number
    }): Promise<{
        batchId: BatchId
        accepted: true
        task: TaskView
        result?: BatchResult
    }> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'submitBatch', task)
        const duplicate = this.taskRequest(task, auth, req.requestId, { operation: 'submitBatch', ...req })
        if (duplicate)
            return duplicate as {
                batchId: BatchId
                accepted: true
                task: TaskView
                result?: BatchResult
            }
        if (task.stateVersion !== req.expectedVersion)
            throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
        this.assertCanStart(task)
        if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) {
            await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed',
                { pauseReason: 'task-time-limit' })
            throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Task time limit reached')
        }
        if (!req.steps.length || req.steps.length > POC_LIMITS.maxBatchSteps)
            throw new BrowserRuntimeError('INVALID_REQUEST', 'Batch size is invalid')
        const ids = new Set<string>()
        for (const step of req.steps) {
            if (ids.has(step.actionId))
                throw new BrowserRuntimeError('CONFLICT', 'actionId repeats in batch')
            ids.add(step.actionId)
            const prior = task.actions[step.actionId]
            if (prior)
                throw new BrowserRuntimeError('CONFLICT', prior.payloadHash !== payloadHash(step)
                    ? 'actionId was reused with different input'
                    : 'actionId was already used in a prior batch')
            if (!task.tabs.includes(step.tabId))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'Step tab does not belong to task')
            if (step.timeoutMs <= 0 || step.timeoutMs > (step.kind === 'waitFor'
                ? POC_LIMITS.maxWaitForTimeoutMs : POC_LIMITS.maxStepTimeoutMs))
                throw new BrowserRuntimeError('INVALID_REQUEST', 'Step timeout is outside the allowed range')
        }
        const submittedSteps = req.steps.map((step) => ['click', 'fill'].includes(step.kind) && !step.snapshotId
            ? { ...step, ...(this.latestAgentSnapshots.get(step.tabId)
                ? { snapshotId: this.latestAgentSnapshots.get(step.tabId) } : {}) }
            : step)
        const batchId = `batch-${randomUUID()}` as BatchId
        let accepted: StoredTask | null
        const hash = payloadHash({ operation: 'submitBatch', ...req })
        const key = requestKey(auth, req.requestId)
        try {
            accepted = await this.options.store.mutate(task.taskId, (current) => {
                const prior = current.dedupe[key]
                if (prior) {
                    if (prior.hash !== hash)
                        throw new BrowserRuntimeError('CONFLICT', 'requestId payload differs')
                    return null
                }
                if (current.stateVersion !== req.expectedVersion)
                    throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
                this.assertCanStart(current)
                if (submittedSteps.some((step) => current.actions[step.actionId]))
                    throw new BrowserRuntimeError('CONFLICT', 'actionId already has a durable intent')
                const next = transitionTask({ status: current.status, pauseReason: current.pauseReason }, { type: 'start' })
                const predictedTask = this.view({ ...current, ...next, currentBatchId: batchId, pauseReason: undefined,
                    waitReason: undefined, stateVersion: current.stateVersion + 1, highWatermarkSeq: current.highWatermarkSeq + 1,
                        updatedAtMs: this.clock.now() } as StoredTask)
                const dedupe = { ...current.dedupe, [key]: { hash, result: { batchId, accepted: true, task: predictedTask } } }
                return {
                    patch: { ...next, currentBatchId: batchId, pauseReason: undefined, waitReason: undefined,
                        waitExpiresAtMs: undefined, dedupe,
                        batches: { ...current.batches, [batchId]: { steps: persistedBatchSteps(submittedSteps), nextStep: 0,
                            grant: this.agentGrant(auth) } } },
                    event: this.event('batch-accepted', { batchId, stepCount: req.steps.length }, current.stateVersion + 1),
                    business: true,
                }
            })
            if (!accepted) {
                const current = this.requireTask(task.taskId)
                const duplicate = this.taskRequest(current, auth, req.requestId, { operation: 'submitBatch', ...req })
                if (duplicate)
                    return duplicate as {
                        batchId: BatchId
                        accepted: true
                        task: TaskView
                        result?: BatchResult
                    }
                throw new BrowserRuntimeError('CONFLICT', 'Task version changed')
            }
        }
        catch (error) {
            if (error instanceof BrowserRuntimeError && error.code === 'QUOTA_EXCEEDED')
                await this.commit(this.requireTask(task.taskId), { status: 'paused', pauseReason: 'quota' }, 'state-changed',
                    { status: 'paused', pauseReason: 'quota' })
            throw error
        }
        let resultPromise: Promise<BatchResult>
        this.liveBatchSteps.set(batchId, submittedSteps)
        resultPromise = this.runBatch(accepted, batchId, submittedSteps, auth).catch(async (error) => {
            if (error instanceof BrowserRuntimeError && error.code === 'JOURNAL_UNAVAILABLE')
                throw error
            let current = this.requireTask(task.taskId)
            if (current.status === 'running') {
                const unresolved = Object.entries(current.actions).filter(([, action]) => action.batchId === batchId && ['navigate',
                    'click', 'fill'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
                const uncertainActions = unresolved.map(([id]) => id as ActionId)
                const actions = { ...current.actions }
                for (const [id, action] of unresolved)
                    actions[id] = { ...action, state: 'uncertain' }
                current = await this.commit(current, {
                    status: 'paused',
                    pauseReason: uncertainActions.length ? 'outcome-unknown' : 'awaiting-agent',
                    actions,
                    ...(uncertainActions.length
                        ? { uncertainActions: [...new Set([...current.uncertainActions, ...uncertainActions])] }
                        : {}),
                }, uncertainActions.length ? 'action-uncertain' : 'action-failed', {
                    batchId,
                    error: safeError(error),
                })
            }
            const uncertain = current.pauseReason === 'outcome-unknown'
            return this.saveBatchResult(current, batchId, { batchId, taskId: current.taskId,
                outcome: uncertain ? 'uncertain' : 'failed', completedSteps: [], mayHaveSideEffects: uncertain,
                    lastCheckpointSeq: current.highWatermarkSeq + 1, steps: [{ stepId: req.steps[0].stepId,
                        actionId: req.steps[0].actionId, outcome: uncertain ? 'uncertain' : 'failed', error: safeError(error) }] })
        }).finally(() => { if (this.workers.get(task.taskId) === resultPromise)
            this.workers.delete(task.taskId); })
        void resultPromise.catch(() => undefined)
        this.workers.set(task.taskId, resultPromise)
        const waitMs = Math.max(0, opts?.waitMs ?? 0)
        if (!waitMs)
            return { batchId, accepted: true, task: this.view(accepted) }
        const result = await Promise.race([resultPromise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined),
            waitMs))])
        return { batchId, accepted: true, task: await this.getTask(auth, { taskId: task.taskId }), ...(result ? { result } : {}) }
    }
    private async finishTaskImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
    }): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'finishTask', task)
        if (task.stateVersion !== req.expectedVersion || task.status !== 'paused' || task.pauseReason !== 'awaiting-agent'
            || task.uncertainActions.length || Object.values(task.approvals).some((a) => a.state === 'pending'))
            throw new BrowserRuntimeError('CONFLICT', 'Task is not ready to finish')
        const next = transitionTask({ status: task.status, pauseReason: task.pauseReason }, { type: 'finish' })
        return this.view(await this.commit(task, { ...next }, 'state-changed', { status: 'succeeded' }))
    }
    async getTask(auth: AuthContext, req: {
        taskId: TaskId
    }): Promise<TaskView> { await this.recovery; const task = this.requireTask(req.taskId); this.authorizeTask(auth, 'getTask',
        task); return this.view(task); }
    /** Interactive only (assertOperation refuses agent grants): unfinished tasks of the credential's owner on its profile. */
    async listTasks(auth: AuthContext, req: { profileId: ProfileId }): Promise<{ tasks: TaskView[] }> {
        await this.recovery
        if (auth.credential.kind !== 'interactive') throw new BrowserRuntimeError('SCOPE_DENIED', 'Task listing needs an interactive capability')
        this.checkCredential(auth, 'listTasks', req.profileId)
        const { principalId, workspaceId, machineId } = auth.credential
        const tasks = this.options.store.listTasks()
            .filter((task) => task.profileId === req.profileId && task.owner.principalId === principalId
                && task.owner.workspaceId === workspaceId && task.owner.machineId === machineId && !FINISHED_STATUSES.has(task.status))
            .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.taskId < b.taskId ? -1 : 1))
            .slice(0, LIST_TASKS_LIMIT)
        return { tasks: tasks.map((task) => this.view(task)) }
    }
    async subscribe(auth: AuthContext, req: {
        taskId: TaskId
        afterSeq: number
    }): Promise<SubscribeResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'subscribe', task)
        if (req.afterSeq < 0)
            throw new BrowserRuntimeError('INVALID_REQUEST', 'Invalid event cursor')
        if (req.afterSeq > task.highWatermarkSeq)
            return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        const events = this.options.store.events(req.taskId, req.afterSeq, this.clock.now())
        if (!events.length && req.afterSeq < task.highWatermarkSeq && ['succeeded', 'failed',
            'cancelled'].includes(task.status) && this.clock.now() - task.updatedAtMs > POC_LIMITS.eventRetentionMs)
            return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        if (events.length && req.afterSeq < events[0].seq - 1)
            return { kind: 'snapshot-required', snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
        return { kind: 'events', events, highWatermarkSeq: task.highWatermarkSeq }
    }
    async waitForEvents(taskId: TaskId, afterSeq: number, waitMs: number): Promise<SubscribeResult> {
        await this.recovery
        const read = () => {
            const task = this.requireTask(taskId)
            if (afterSeq > task.highWatermarkSeq)
                return { kind: 'snapshot-required' as const, snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
            const events = this.options.store.events(taskId, afterSeq, this.clock.now())
            if (events.length && afterSeq < events[0].seq - 1)
                return { kind: 'snapshot-required' as const, snapshot: this.view(task), highWatermarkSeq: task.highWatermarkSeq }
            return { kind: 'events' as const, events, highWatermarkSeq: task.highWatermarkSeq }
        }
        const first = read()
        if (first.kind === 'snapshot-required' || first.events.length || waitMs <= 0)
            return first
        await new Promise<void>((resolve) => {
            const waiters = this.eventWaiters.get(taskId) ?? new Set<() => void>()
            const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); }
            const timer = setTimeout(finish, waitMs)
            waiters.add(finish)
            this.eventWaiters.set(taskId, waiters)
        })
        return read()
    }
    async onDriverDisconnected(profileId: ProfileId): Promise<void> {
        this.reconnecting.add(profileId)
        await this.recovery
        for (const task of this.options.store.listTasks()) {
            if (task.profileId !== profileId || ['succeeded', 'failed', 'cancelled'].includes(task.status))
                continue
            if (task.status === 'recovering')
                continue
            const writeIds = inFlightWriteActions(task)
            const inflight = Object.entries(task.actions).filter(([, action]) => ['intent-committed', 'dispatched'].includes(action.state))
            const actions = { ...task.actions }
            for (const [id, action] of inflight) {
                if (['navigate', 'click', 'fill'].includes(String(action.kind)))
                    actions[id] = { ...action, state: 'uncertain' }
            }
            const writes = writeIds
            const pauseReason = writes.length ? 'outcome-unknown' : undefined
            await this.commit(task, { status: 'recovering', previousDriverStatus: task.status, ...(pauseReason ? { pauseReason,
                uncertainActions: [...new Set([...task.uncertainActions, ...writes])] } : {}), actions }, 'recovered',
                    { driver: 'disconnected', inFlightWrites: writes })
        }
    }
    async onDriverReconnected(profileId: ProfileId): Promise<void> {
        try {
            await this.handleDriverReconnected(profileId)
        } finally {
            this.reconnecting.delete(profileId)
        }
    }
    private async handleDriverReconnected(profileId: ProfileId): Promise<void> {
        await this.recovery
        await this.restorePersistedTabs(profileId)
        const driver = this.drivers.get(profileId)
        let currentInstance: BrowserInstanceId | undefined
        try {
            currentInstance = driver?.browserInstanceId()
        }
        catch {
            currentInstance = undefined
        }
        for (const task of this.options.store.listTasks()) {
            if (task.profileId !== profileId || task.status !== 'recovering')
                continue
            const replaced = !browserInstanceMatches(task, currentInstance)
            if (replaced) {
                const approvals = Object.fromEntries(Object.entries(task.approvals).map(([id, approval]) => [id, { ...approval,
                    state: approval.state === 'pending' ? 'expired' : approval.state }]))
                await this.options.store.mutateSpace(task.taskSpaceId, (space) => ({ tabs: space.tabs.filter((tab) => !task.tabs.includes(tab)) }))
                await this.commit(task, { status: 'paused', pauseReason: 'browser-replaced', tabs: [], pendingApproval: undefined,
                    approvals, browserInstanceId: currentInstance }, 'recovered', { driver: 'reconnected', browserReplaced: true,
                        attention: 'recovered' })
                continue
            }
            const previousStatus = task.previousDriverStatus as TaskStatus | undefined
            const writes = inFlightWriteActions(task)
            const workerExists = this.workers.has(task.taskId)
            const previous: TaskStatus = task.pauseReason === 'outcome-unknown' || writes.length
                || previousStatus === 'running' && !workerExists ? 'paused' : previousStatus ?? 'paused'
            const pauseReason = writes.length || task.pauseReason === 'outcome-unknown'
                ? 'outcome-unknown' : previousStatus === 'running' && !workerExists ? 'awaiting-agent' : task.pauseReason
            const patch: Partial<StoredTask> = previous === 'paused'
                ? { status: previous, pauseReason: pauseReason ?? 'awaiting-agent' as const,
                    ...(writes.length ? { uncertainActions: [...new Set([...task.uncertainActions, ...writes])] } : {}) }
                : { status: previous, pauseReason: undefined }
            // A batch the agent was waiting on ended with the disconnect: the agent must re-plan.
            await this.commit(task, { ...patch, previousDriverStatus: undefined }, 'recovered', { driver: 'reconnected',
                browserReplaced: false, ...(previousStatus === 'running' && patch.status === 'paused' ? { attention: 'recovered' } : {}) })
        }
    }
    /**
     * Retention (retentionDays): deletes terminal tasks whose last change is older than
     * `retentionMs` and what the Runtime keeps in memory for them. Their still-open browser
     * tabs are closed first and only then dropped from the space; a task whose tab cannot be
     * closed (browser unreachable, beforeunload, user holding it) keeps all its state and is
     * retried on the next run, also after a restart.
     */
    async purgeExpiredTasks(retentionMs: number): Promise<TaskId[]> {
        await this.recovery
        await this.options.store.resumePurges()
        const purged: TaskId[] = []
        for (const task of this.options.store.expiredTasks(this.clock.now(), retentionMs)) {
            if (!(await this.closeRetainedTabs(task).catch(() => false)) || !(await this.options.store.purgeTask(task.taskId)))
                continue
            purged.push(task.taskId)
            this.controllers.delete(task.taskId)
            this.workers.delete(task.taskId)
            this.inFlightDriverCalls.delete(task.taskId)
            this.commitTails.delete(task.taskId)
            for (const wake of this.eventWaiters.get(task.taskId) ?? [])
                wake()
            this.eventWaiters.delete(task.taskId)
            this.leases.revokeTask(task.taskId)
            for (const batchId of Object.keys(task.batches))
                this.liveBatchSteps.delete(batchId as BatchId)
            for (const tabId of task.tabs) {
                this.latestAgentSnapshots.delete(tabId)
                this.latestAgentUrls.delete(tabId)
            }
        }
        return purged
    }
    /** Closes an expired task's open tabs, removing each from its space once closed; false if any stays open. */
    private async closeRetainedTabs(task: StoredTask): Promise<boolean> {
        let closedAll = true
        for (const tabId of this.options.store.openTabsOf(task)) {
            if (await this.closeSpaceTab(task.profileId, task.taskSpaceId, tabId) !== 'closed')
                closedAll = false
        }
        return closedAll
    }
    /**
     * Closes one space tab in the browser and only then drops it from the space. A target
     * that is already gone (closed just before a crash) counts as closed; a tab a user holds
     * is not touched.
     */
    private async closeSpaceTab(profileId: ProfileId, taskSpaceId: TaskSpaceId, tabId: TabId): Promise<'closed' | 'held' | 'blocked' | 'failed'> {
        if (this.leases.owner(tabId, profileId).owner.kind !== 'none')
            return 'held'
        const driver = this.driver(profileId)
        const result = await driver.closeTab(tabId, { timeoutMs: 5000 }).catch(() => undefined)
        if (result?.beforeUnloadBlocked)
            return 'blocked'
        if (!result?.closed && !(result && !driver.hasTab(tabId)))
            return 'failed'
        await this.options.store.mutateSpace(taskSpaceId, (current) => {
            const { [tabId]: _target, ...tabTargets } = current.tabTargets ?? {}
            const { [tabId]: _epoch, ...tabLeaseEpochs } = current.tabLeaseEpochs ?? {}
            return { tabs: current.tabs.filter((tab) => tab !== tabId), goneTabs: [...new Set([...(current.goneTabs ?? []), tabId])],
                tabTargets, tabLeaseEpochs }
        })
        return 'closed'
    }
    /**
     * The agent session ended (broker revocation at session exit): its spaces are marked
     * for reclamation (durably, so a restart finishes it) and its unfinished tasks go
     * through the cancel fence. reclaimSpaces closes them once their tasks allow.
     * Idempotent.
     */
    async endSession(agentSessionId: string): Promise<void> {
        await this.recovery
        const tasks = this.options.store.listTasks().filter((task) => task.agentSessionId === agentSessionId)
        const spaceIds = new Set([...this.options.store.listSpaces().filter((space) => space.agentSessionId === agentSessionId).map((space) => space.taskSpaceId),
            ...tasks.map((task) => task.taskSpaceId)])
        for (const taskSpaceId of spaceIds)
            await this.markReclaiming(taskSpaceId, 'session-ended')
        for (const task of tasks) {
            if (!FINISHED_STATUSES.has(task.status))
                await this.cancelTask(this.requireTask(task.taskId))
        }
    }
    /**
     * One reclamation pass: spaces marked for reclamation, and (with spaceIdleReclaimMs)
     * spaces whose tasks are all finished and that saw no activity for that long, are
     * closed tab by tab. A task with an unknown write outcome keeps its space for the user;
     * a tab blocking unload stays open and is reported. Passes are serialized.
     */
    reclaimSpaces(): Promise<SpaceReclaimReport[]> {
        const run = this.reclaimTail.then(() => this.reclaimPass(), () => this.reclaimPass())
        this.reclaimTail = run.catch(() => undefined)
        return run
    }
    private reclaimTail: Promise<unknown> = Promise.resolve()
    private async reclaimPass(): Promise<SpaceReclaimReport[]> {
        await this.recovery
        const reports: SpaceReclaimReport[] = []
        const idleMs = this.options.spaceIdleReclaimMs
        for (const space of this.options.store.listSpaces()) {
            if (space.closed)
                continue
            if (space.reclaimingSinceMs === undefined) {
                const tasks = this.spaceTasks(space.taskSpaceId)
                const lastActivityMs = Math.max(space.createdAtMs, ...tasks.map((task) => Number(task.updatedAtMs)))
                if (idleMs === undefined || tasks.some((task) => !FINISHED_STATUSES.has(task.status) || this.workers.has(task.taskId))
                    || this.clock.now() - lastActivityMs < idleMs)
                    continue
                await this.markReclaiming(space.taskSpaceId, 'idle')
            }
            reports.push(await this.reclaimSpace(space.taskSpaceId))
        }
        return reports
    }
    /** Operator view of every space (admin socket). */
    spaceReport(): SpaceSummary[] {
        const now = this.clock.now()
        const spaces = this.options.store.listSpaces()
        const reclaimingByProfile = new Map<ProfileId, number>()
        return spaces.map((space) => {
            let counted = !space.closed
            if (counted && space.reclaimingSinceMs !== undefined) {
                const seen = (reclaimingByProfile.get(space.profileId) ?? 0) + 1
                reclaimingByProfile.set(space.profileId, seen)
                counted = seen > RECLAIMING_SPACE_RESERVE
            }
            const tasks = this.spaceTasks(space.taskSpaceId)
            return {
                taskSpaceId: space.taskSpaceId, profileId: space.profileId,
                agentSessionId: space.agentSessionId ?? tasks[0]?.agentSessionId,
                createdAtMs: space.createdAtMs, ageMs: now - space.createdAtMs, closed: Boolean(space.closed), counted,
                ...(space.reclaimReason ? { reclaimReason: space.reclaimReason } : {}),
                ...(space.reclaimBlockedTabs?.length ? { reclaimBlockedTabs: space.reclaimBlockedTabs } : {}),
                tabs: [...space.tabs],
                tasks: tasks.map((task) => ({ taskId: task.taskId, agentSessionId: task.agentSessionId, status: task.status,
                    ...(task.pauseReason ? { pauseReason: task.pauseReason } : {}), uncertainActions: task.uncertainActions.length,
                    updatedAtMs: Number(task.updatedAtMs) })),
            }
        })
    }
    /**
     * Operator close (admin socket): cancels the space's tasks and closes it. A task with an
     * unknown write outcome keeps the space unless `force` (its record stays for reconcile).
     */
    async closeSpaceAsOperator(taskSpaceId: TaskSpaceId, options: { force?: boolean } = {}): Promise<SpaceReclaimReport> {
        await this.recovery
        const space = this.requireSpace(taskSpaceId)
        if (space.closed)
            return { taskSpaceId, reason: space.reclaimReason ?? 'operator', closed: true, closedTabs: [] }
        await this.markReclaiming(taskSpaceId, 'operator')
        for (const task of this.spaceTasks(taskSpaceId)) {
            if (!FINISHED_STATUSES.has(task.status))
                await this.cancelTask(this.requireTask(task.taskId))
        }
        await Promise.all(this.spaceTasks(taskSpaceId).map((task) => this.workers.get(task.taskId)?.catch(() => undefined)))
        return this.reclaimSpace(taskSpaceId, options.force)
    }
    private spaceTasks(taskSpaceId: TaskSpaceId): StoredTask[] {
        return this.options.store.listTasks().filter((task) => task.taskSpaceId === taskSpaceId)
    }
    private async markReclaiming(taskSpaceId: TaskSpaceId, reason: NonNullable<SpaceRecord['reclaimReason']>): Promise<void> {
        await this.options.store.mutateSpace(taskSpaceId, (current) => current.closed || current.reclaimingSinceMs !== undefined ? null
            : { reclaimingSinceMs: this.clock.now(), reclaimReason: reason })
    }
    private async reclaimSpace(taskSpaceId: TaskSpaceId, force = false): Promise<SpaceReclaimReport> {
        const space = this.requireSpace(taskSpaceId)
        const report: SpaceReclaimReport = { taskSpaceId, reason: space.reclaimReason ?? 'operator', closed: false, closedTabs: [] }
        const tasks = this.spaceTasks(taskSpaceId)
        // A crash between marking and cancelling is finished here.
        for (const task of tasks) {
            if (report.reason !== 'idle' && !FINISHED_STATUSES.has(task.status) && !task.cancelRequested)
                await this.cancelTask(this.requireTask(task.taskId))
        }
        const current = this.spaceTasks(taskSpaceId)
        const retained = current.filter((task) => !FINISHED_STATUSES.has(task.status) && task.uncertainActions.length && !this.workers.has(task.taskId))
            .map((task) => task.taskId)
        const waiting = current.filter((task) => this.workers.has(task.taskId)
            || (!FINISHED_STATUSES.has(task.status) && !task.uncertainActions.length)).map((task) => task.taskId)
        if (waiting.length)
            return { ...report, waiting }
        if (retained.length && !force)
            return { ...report, retained }
        const blockedTabs: TabId[] = []
        const failedTabs: TabId[] = []
        for (const tabId of space.tabs) {
            const outcome = await this.closeSpaceTab(space.profileId, taskSpaceId, tabId)
            if (outcome === 'closed')
                report.closedTabs.push(tabId)
            else if (outcome === 'blocked')
                blockedTabs.push(tabId)
            else
                failedTabs.push(tabId)
        }
        await this.options.store.mutateSpace(taskSpaceId, (latest) => blockedTabs.length || failedTabs.length
            ? { reclaimBlockedTabs: blockedTabs }
            : { tabs: [], tabTargets: {}, tabLeaseEpochs: {}, profileUserOwner: null, closed: true, reclaimBlockedTabs: undefined,
                goneTabs: [...new Set([...(latest.goneTabs ?? []), ...latest.tabs])] })
        if (blockedTabs.length || failedTabs.length)
            return { ...report, ...(blockedTabs.length ? { blockedTabs } : {}), ...(failedTabs.length ? { failedTabs } : {}),
                ...(retained.length ? { retained } : {}) }
        return { ...report, closed: true, ...(retained.length ? { retained } : {}) }
    }
    async revokeGrant(grantId: GrantId): Promise<void> {
        let failure: unknown
        try {
            await this.options.store.revoke(grantId)
        }
        catch (error) {
            failure = error
        }
        for (const task of this.options.store.listTasks()) {
            const usesGrant = (task.agentGrant as AgentGrant | undefined)?.grantId === grantId
                || Object.values(task.batches).some((batch) => batch.grant?.grantId === grantId)
                || Object.values(task.actions).some((action) => action.grantId === grantId)
            if (!usesGrant)
                continue
            const revoked = this.leases.revokeTask(task.taskId)
            this.controllers.get(task.taskId)?.abort(new Error('grant revoked'))
            for (const lease of revoked)
                await this.persistTabLease(task.taskId, task.taskSpaceId, lease.tabId, lease.leaseEpoch).catch(() => undefined)
        }
        try {
            await this.sweep(this.clock.now())
        }
        catch (error) {
            failure ??= error
        }
        if (failure)
            throw failure
    }
    async sweep(nowMs: number): Promise<void> {
        await this.recovery
        for (const task of this.options.store.listTasks()) {
            let fenceReason: string | undefined
            const changed = await this.options.store.mutate(task.taskId, (current) => {
                if (['succeeded', 'failed', 'cancelled'].includes(current.status) || current.cancelRequested)
                    return null
                const recoveryDriver = this.drivers.get(current.profileId)
                let driverConnected = false
                try {
                    driverConnected = Boolean(recoveryDriver?.browserInstanceId())
                }
                catch {
                    driverConnected = false
                }
                // While reconnect handling runs it decides (it compares browser identity); a sweep
                // in between would mark a replaced browser's task as merely waiting for the agent.
                if (current.status === 'recovering' && !this.workers.has(current.taskId) && driverConnected
                    && !this.reconnecting.has(current.profileId)) {
                    const writes = inFlightWriteActions(current)
                    const actions = { ...current.actions }
                    for (const actionId of writes)
                        actions[actionId] = { ...actions[actionId], state: 'uncertain' }
                    fenceReason = 'recovered-without-worker'
                    return {
                        patch: { status: 'paused', pauseReason: writes.length ? 'outcome-unknown' : 'awaiting-agent',
                            ...(writes.length ? { actions, uncertainActions: [...new Set([...current.uncertainActions, ...writes])] } : {}),
                            previousDriverStatus: undefined },
                        event: this.event('recovered', { recoveredWithoutWorker: true, uncertainActions: writes },
                            current.stateVersion + 1),
                    }
                }
                const grant = current.agentGrant as AgentGrant | undefined
                const revokedBatchGrant = current.currentBatchId
                    ? current.batches[current.currentBatchId]?.grant
                    : undefined
                const revokedActionIds = Object.entries(current.actions).filter(([, action]) => action.grantId
                    && this.options.store.isRevoked(action.grantId)
                    && ['planned', 'intent-committed', 'dispatched'].includes(action.state)).map(([id]) => id as ActionId)
                let reason: StoredTask['pauseReason'] | undefined
                if (!grant || grant.expiresAtMs <= nowMs || this.options.store.isRevoked(grant.grantId)
                    || Boolean(revokedBatchGrant && this.options.store.isRevoked(revokedBatchGrant.grantId))
                    || revokedActionIds.length)
                    reason = 'grant-expired'
                else if (Number(current.waitExpiresAtMs ?? 0) > 0 && Number(current.waitExpiresAtMs) <= nowMs)
                    reason = current.waitReason === 'approval' ? 'approval-expired' : 'user-wait-expired'
                else if (nowMs - current.createdAtMs >= POC_LIMITS.taskTimeLimitMs)
                    reason = 'task-time-limit'
                if (reason) {
                    if (current.status === 'paused' && current.pauseReason === reason)
                        return null
                    fenceReason = reason
                    const actions = { ...current.actions }
                    const uncertainWrites = revokedActionIds.filter((id) => ['intent-committed', 'dispatched']
                        .includes(actions[id]?.state ?? '') && ['navigate', 'click', 'fill'].includes(String(actions[id]?.kind)))
                    for (const id of uncertainWrites)
                        actions[id] = { ...actions[id], state: 'uncertain' }
                    const approvals = Object.fromEntries(Object.entries(current.approvals).map(([id, approval]) => [id, {
                        ...approval,
                        ...(approval.grantId && this.options.store.isRevoked(approval.grantId)
                            && approval.state === 'pending' ? { state: 'expired' as const } : {}),
                    }]))
                    return {
                        patch: { status: 'paused', pauseReason: uncertainWrites.length ? 'outcome-unknown' : reason,
                            ...(uncertainWrites.length ? { actions, uncertainActions: [...new Set([...current.uncertainActions,
                                ...uncertainWrites])] } : {}),
                            approvals,
                            ...(reason === 'approval-expired' ? { pendingApproval: undefined } : {}) },
                        event: this.event('state-changed', { pauseReason: reason }, current.stateVersion + 1),
                    }
                }
                if (current.status === 'running' && !this.inFlightDriverCalls.has(current.taskId)
                    && nowMs - current.updatedAtMs >= POC_LIMITS.workerStaleMs) {
                    fenceReason = 'worker-heartbeat-stale'
                    return { patch: { status: 'recovering' },
                        event: this.event('recovered', { reason: fenceReason }, current.stateVersion + 1) }
                }
                return null
            })
            if (!changed || !fenceReason)
                continue
            const revoked = this.leases.revokeTask(task.taskId)
            this.controllers.get(task.taskId)?.abort(new Error(fenceReason))
            for (const lease of revoked)
                await this.persistTabLease(task.taskId, task.taskSpaceId, lease.tabId, lease.leaseEpoch)
        }
    }
    private async approveImpl(auth: AuthContext, req: {
        taskId: TaskId
        approvalId: ApprovalId
        bindingHash: string
        requestId: RequestId
        decision: 'approve' | 'reject'
    }): Promise<ApproveResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'approve', task)
        const approval = task.approvals[req.approvalId]
        if (!approval || approval.bindingHash !== req.bindingHash)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval is no longer pending')
        if (approval.state === 'consumed' && approval.result)
            return { outcome: 'approved', task: this.view(task), batch: approval.result as BatchResult }
        if (approval.state !== 'pending')
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval is no longer pending')
        if (Number(approval.expiresAtMs) <= this.clock.now()) {
            await this.commit(task, { status: 'paused', pauseReason: 'approval-expired' }, 'state-changed', { status: 'paused',
                pauseReason: 'approval-expired' })
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval expired')
        }
        if (req.decision === 'reject') {
            const cancelled = await this.commit(task, { status: 'cancelled', cancelRequested: true, approvals: { ...task.approvals,
                [req.approvalId]: { ...approval, state: 'rejected' } } }, 'approval-rejected', { approvalId: req.approvalId,
                    attention: 'approval-rejected' })
            for (const lease of this.leases.revokeTask(task.taskId))
                await this.persistTabLease(task.taskId, task.taskSpaceId, lease.tabId, lease.leaseEpoch)
            return { outcome: 'rejected', task: this.view(cancelled) }
        }
        const batchGrant = task.batches[String(approval.batchId)]?.grant
        const originalGrant = (batchGrant?.grantId === approval.grantId ? batchGrant : task.agentGrant) as AgentGrant | undefined
        if (!originalGrant || originalGrant.expiresAtMs <= this.clock.now() || this.options.store.isRevoked(originalGrant.grantId))
            throw new BrowserRuntimeError('UNAUTHORIZED', 'Agent execution grant is no longer valid')
        const originalAuth: AuthContext = { credential: originalGrant, verifiedAtMs: this.clock.now() }
        const batchRecord = task.batches[String(approval.batchId)] as {
            steps: BatchStep[]
            nextStep: number
            grant?: AgentGrant
        }
        // Fill values are never persisted: they come back from this process's memory, or the approval cannot be used.
        const live = this.liveBatchSteps.get(approval.batchId as BatchId)
        const batchSteps = batchRecord.steps.map((candidate) => candidate.kind === 'fill' && candidate.value === undefined
            ? { ...candidate, value: live?.find((step) => step.actionId === candidate.actionId)?.value } : candidate)
        const storedStep = batchSteps[Number(approval.nextStep)]
        if (storedStep.kind === 'fill' && storedStep.value === undefined)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'The approved value is no longer available; submit the step again')
        const approvedStep = { ...storedStep, snapshotId: approval.snapshotId ?? storedStep.snapshotId }
        const driver = this.driver(task.profileId)
        const lease = this.leases.owner(approvedStep.tabId, task.profileId)
        const sameLiveApprovalLease = lease.leaseEpoch === Number(approval.leaseEpoch)
            && lease.owner.kind === 'agent' && lease.owner.taskId === task.taskId
            && lease.owner.segmentId === approval.batchId
        // Recovery bumps epochs to fence stale clients. A pending approval may
        // survive that bump only when recovery restored an otherwise idle tab,
        // no user owns this profile, and the same approval still blocks the task.
        const recoveredApprovalLease = lease.owner.kind === 'none'
            && task.status === 'awaiting-user' && task.waitReason === 'approval'
            && !this.leases.isUserFenced(task.profileId)
            && lease.leaseEpoch > Number(approval.leaseEpoch)
            && task.tabLeaseEpochs?.[approvedStep.tabId] === lease.leaseEpoch
        if ((!sameLiveApprovalLease && !recoveredApprovalLease) || driver.browserInstanceId() !== approval.browserInstanceId
            || await driver.currentOrigin(approvedStep.tabId) !== approval.origin)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed')
        let description: ElementDescription | undefined
        // After a Runtime-only restart the new driver connection has no snapshots:
        // re-bind the approved element from its persisted identity. The driver only
        // does so if the element's document is unchanged; anything else expires the approval.
        if (approvedStep.snapshotId && approval.elementIdentity && driver.restoreRef) {
            const restored = await driver.restoreRef(approvedStep.tabId, approvedStep.snapshotId, approvedStep.ref as ElementRef,
                approval.elementIdentity, { timeoutMs: approvedStep.timeoutMs })
            if (restored === 'gone') throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval reference was replaced')
        }
        if (approvedStep.snapshotId && driver.describeRef) {
            try {
                description = await driver.describeRef(approvedStep.tabId, approvedStep.ref as ElementRef,
                    approvedStep.snapshotId, { timeoutMs: approvedStep.timeoutMs })
            }
            catch (error) {
                if (error instanceof BrowserRuntimeError && error.code === 'STALE_REF')
                    throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval reference was replaced')
                throw error
            }
        }
        if (!description)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval reference can no longer be verified')
        if (approval.elementIdentity && description.identity !== approval.elementIdentity)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval element was re-bound to a different node')
        if (this.clock.now() >= Number(approval.expiresAtMs) || originalGrant.expiresAtMs <= this.clock.now()
            || this.options.store.isRevoked(originalGrant.grantId))
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval or execution grant expired before dispatch')
        const currentApprovalPayloadHash = approvalPayloadHash(approvedStep, description)
        if (description.documentGeneration !== Number(approval.documentGeneration)
            || description.frameOrigin !== approval.frameOrigin
            || new URL(description.pageUrl).origin !== approval.origin
            || currentApprovalPayloadHash !== approval.payloadHash)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval document or payload changed')
        const expectedBinding = approvalBinding({ principalId: originalGrant.principalId, workspaceId: originalGrant.workspaceId,
            taskId: task.taskId, actionId: approvedStep.actionId, origin: String(approval.origin),
                payloadHash: String(approval.payloadHash), leaseEpoch: Number(approval.leaseEpoch),
                    browserInstanceId: String(approval.browserInstanceId), documentGeneration: Number(approval.documentGeneration),
                        expiresAtMs: Number(approval.expiresAtMs), frameOrigin: String(approval.frameOrigin) })
        if (expectedBinding !== req.bindingHash)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed')
        const consumed = await this.options.store.mutate(task.taskId, (current) => {
            const latestApproval = current.approvals[req.approvalId]
            if (current.cancelRequested || current.status !== 'awaiting-user' || !latestApproval || latestApproval.state !== 'pending'
                || latestApproval.bindingHash !== req.bindingHash || Number(latestApproval.expiresAtMs) <= this.clock.now()) {
                throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval changed before consumption')
            }
            const { [approvedStep.actionId]: _priorAction, ...remainingActions } = current.actions
            return {
                patch: { status: 'running', pauseReason: undefined, waitReason: undefined, waitExpiresAtMs: undefined,
                    actions: remainingActions,
                    approvals: { ...current.approvals, [req.approvalId]: { ...latestApproval, state: 'consumed' } } },
                event: this.event('approval-consumed', { approvalId: req.approvalId }, current.stateVersion + 1),
            }
        })
        if (!consumed)
            throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval changed before consumption')
        const result = await this.runBatch(consumed, approval.batchId as BatchId, batchSteps, originalAuth,
            Number(approval.nextStep), approvedStep.actionId)
        const finalTask = this.requireTask(req.taskId)
        await this.commit(finalTask, { approvals: { ...finalTask.approvals, [req.approvalId]: { ...finalTask.approvals[req.approvalId],
            result } } }, 'agent-attention-required', { approvalId: req.approvalId, outcome: result.outcome, attention: 'approval-approved' })
        return { outcome: 'approved', task: this.view(this.requireTask(req.taskId)), batch: result }
    }
    private async takeOverImpl(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
        expectedEpoch: number
        requestId: RequestId
    }): Promise<ControlResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'takeOver', task)
        if (['succeeded', 'failed', 'cancelled'].includes(task.status))
            throw new BrowserRuntimeError('CONFLICT', 'Terminal tasks cannot be taken over')
        this.assertTaskTab(task, req.tabId)
        if (task.waitReason === 'approval')
            throw new BrowserRuntimeError('CONFLICT', 'Approval waits cannot be replaced with user takeover')
        const lease = this.leases.owner(req.tabId, task.profileId)
        if (lease.leaseEpoch !== req.expectedEpoch)
            throw new BrowserRuntimeError('STALE_LEASE', 'Lease epoch changed')
        const interactive = auth.credential as Extract<AuthContext['credential'], {
            kind: 'interactive'
        }>
        const owner: InputOwner = { kind: 'user', principalId: interactive.principalId, viewerSessionId: interactive.viewerSessionId }
        const settling = this.inFlightDriverCalls.has(task.taskId)
        const epoch = this.leases.fenceForTakeover(req.tabId, task.profileId, task.taskId, owner)
        await this.persistTabLease(task.taskId, task.taskSpaceId, req.tabId, epoch, { tabId: req.tabId, owner })
        await this.persistProfileUserOwner(task.profileId, { tabId: req.tabId, owner })
        if (!settling)
            this.leases.completePendingTakeovers(task.taskId)
        const pending = Object.entries(task.actions).filter(([, action]) => ['click', 'fill',
            'navigate'].includes(String(action.kind)) && ['intent-committed', 'dispatched'].includes(String(action.state)))
        const actions = { ...task.actions }
        for (const [id, action] of pending)
            actions[id] = { ...action, state: 'uncertain' }
        const paused = await this.commit(task, { status: 'paused', pauseReason: 'user-control', actions,
            ...(pending.length ? { uncertainActions: [...new Set([...task.uncertainActions,
                ...pending.map(([id]) => id as ActionId)])] } : {}) }, 'input-owner-changed', { tabId: req.tabId, owner: 'user',
                    unsettledActions: pending.map(([id]) => id), settling }, epoch)
        this.controllers.get(task.taskId)?.abort(new Error('user takeover'))
        const currentOwner = this.leases.owner(req.tabId, task.profileId).owner
        return { leaseEpoch: epoch, owner: currentOwner, task: this.view(paused), settling }
    }
    private async releaseControlImpl(auth: AuthContext, req: {
        taskId: TaskId
        tabId: TabId
        expectedEpoch: number
        requestId: RequestId
    }): Promise<ControlResult> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'releaseControl', task)
        if (['succeeded', 'failed', 'cancelled'].includes(task.status))
            throw new BrowserRuntimeError('CONFLICT', 'Terminal tasks cannot release control')
        this.assertTaskTab(task, req.tabId)
        const current = this.leases.owner(req.tabId, task.profileId)
        const interactive = auth.credential as Extract<AuthContext['credential'], {
            kind: 'interactive'
        }>
        if (current.leaseEpoch !== req.expectedEpoch || current.owner.kind !== 'user'
            || current.owner.principalId !== interactive.principalId || current.owner.viewerSessionId !== interactive.viewerSessionId)
            throw new BrowserRuntimeError('STALE_LEASE', 'User lease changed')
        const epoch = this.leases.release(req.tabId, task.profileId)
        await this.persistTabLease(task.taskId, task.taskSpaceId, req.tabId, epoch, null)
        await this.persistProfileUserOwner(task.profileId, null)
        const next = await this.commit(task, { status: 'paused', pauseReason: 'user-input-complete' }, 'input-owner-changed',
            { tabId: req.tabId, owner: 'none', attention: 'takeover-released' }, epoch)
        return { leaseEpoch: epoch, owner: { kind: 'none' }, task: this.view(next) }
    }
    private async resumeImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
    }): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'resume', task)
        if (['succeeded', 'failed', 'cancelled'].includes(task.status))
            throw new BrowserRuntimeError('CONFLICT', 'Terminal tasks cannot be resumed')
        const claimId = String(req.requestId)
        await this.options.store.mutate(task.taskId, (current) => {
            if (['succeeded', 'failed', 'cancelled'].includes(current.status)
                || current.stateVersion !== req.expectedVersion || current.status !== task.status
                || current.pauseReason !== task.pauseReason || current.resumeClaimId)
                throw new BrowserRuntimeError('CONFLICT', 'Task changed before resume')
            return {
                patch: { resumeClaimId: claimId, stateVersion: current.stateVersion },
                event: this.event('state-changed', { resumeClaimed: true }, current.stateVersion),
            }
        })
        try {
            return await this.resumeClaimedImpl(auth, req)
        }
        finally {
            await this.options.store.mutate(task.taskId, (current) => current.resumeClaimId === claimId ? {
                patch: { resumeClaimId: undefined, stateVersion: current.stateVersion },
                event: this.event('state-changed', { resumeClaimReleased: true }, current.stateVersion),
            } : null).catch(() => undefined)
        }
    }
    private async resumeClaimedImpl(auth: AuthContext, req: {
        taskId: TaskId
        expectedVersion: number
        requestId: RequestId
    }): Promise<TaskView> {
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'resume', task)
        if (auth.credential.kind === 'interactive')
            return this.userResume(task)
        if (task.cancelRequested || ['user-control', 'quota', 'task-time-limit', 'outcome-unknown',
            'cancelled-with-unknown-effect'].includes(task.pauseReason ?? '') || task.uncertainActions.length)
            throw new BrowserRuntimeError('CONFLICT', 'Task pause cannot be resumed directly')
        if (task.stateVersion !== req.expectedVersion || task.status !== 'paused' || !['awaiting-agent', 'user-input-complete',
            'approval-expired', 'grant-expired', 'browser-replaced'].includes(task.pauseReason ?? ''))
            throw new BrowserRuntimeError('CONFLICT', 'Task is not resumable')
        if (auth.credential.kind !== 'agent-grant')
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent grant required to resume')
        if (task.pauseReason === 'grant-expired')
            task.agentGrant = auth.credential
        if (task.pauseReason === 'user-input-complete' && task.waitReason) {
            if (Number(task.waitExpiresAtMs ?? 0) > 0 && this.clock.now() > Number(task.waitExpiresAtMs))
                return this.view(await this.commit(task, { status: 'paused', pauseReason: 'user-wait-expired' }, 'state-changed',
                    { pauseReason: 'user-wait-expired', waitReason: task.waitReason }))
            // A handed-off action was done (or not) by the user: nothing to verify, the agent re-observes.
            if (task.waitReason === 'handoff')
                return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent', waitReason: undefined,
                    waitCompletion: undefined, waitExpiresAtMs: undefined, agentGrant: auth.credential }, 'state-changed',
                    { status: 'paused', pauseReason: 'awaiting-agent', handoffEnded: true }))
            const wait = task.waitCompletion as UserWaitCompletion | undefined
            const waitCompleted = await this.userWaitCompleted(task, wait, auth.credential.allowedOrigins)
            if (!wait || !waitCompleted)
                return this.view(await this.commit(task, { status: 'awaiting-user' }, 'state-changed', { status: 'awaiting-user',
                    waitReason: task.waitReason }))
            if (!wait.batchId) {
                return this.view(await this.commit(task, {
                    status: 'paused',
                    pauseReason: 'awaiting-agent',
                    waitReason: undefined,
                    waitCompletion: undefined,
                    waitExpiresAtMs: undefined,
                    agentGrant: auth.credential,
                }, 'state-changed', { status: 'paused', pauseReason: 'awaiting-agent', waitCompleted: true }))
            }
            const record = task.batches[wait.batchId] as {
                steps: BatchStep[]
            }
            const resumeAt = Number(wait.nextStep ?? 0)
            const liveSteps = this.liveBatchSteps.get(wait.batchId as BatchId)
            if (!liveSteps)
                return this.view(await this.interruptPersistedBatch(task, wait.batchId as BatchId, resumeAt))
            const running = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined,
                waitCompletion: undefined, waitExpiresAtMs: undefined,
                browserInstanceId: this.driver(task.profileId).browserInstanceId(),
                    batches: { ...task.batches, [wait.batchId]: { ...record, nextStep: resumeAt } } }, 'state-changed',
                        { status: 'running', resumedAfter: task.waitReason })
            await this.runBatch(running, wait.batchId as BatchId, liveSteps, auth, resumeAt)
            return this.view(this.requireTask(task.taskId))
        }
        if (task.pauseReason === 'approval-expired' || task.pauseReason === 'user-wait-expired') {
            const approvalEntry = Object.entries(task.approvals).find(([, approval]) => approval.state === 'pending')
            if (approvalEntry) {
                const [approvalId, approval] = approvalEntry
                const liveSteps = this.liveBatchSteps.get(approval.batchId as BatchId)
                if (!liveSteps)
                    return this.view(await this.interruptPersistedBatch(task, approval.batchId as BatchId,
                        Number(approval.nextStep)))
                const { [String(approval.actionId)]: _oldAction, ...actions } = task.actions
                const approvals = { ...task.approvals, [approvalId]: { ...approval, state: 'expired' as const } }
                const running = await this.commit(task, { status: 'running', pauseReason: undefined, waitReason: undefined,
                    waitExpiresAtMs: undefined, pendingApproval: undefined, agentGrant: auth.credential, actions, approvals }, 'state-changed',
                        { status: 'running', approvalExpired: approvalId })
                await this.runBatch(running, approval.batchId as BatchId, liveSteps, auth, Number(approval.nextStep))
                return this.view(this.requireTask(task.taskId))
            }
        }
        if (task.pauseReason === 'browser-replaced') {
            const driver = this.driver(task.profileId)
            for (const tab of task.tabs)
                if (!driver.hasTab(tab))
                    throw new BrowserRuntimeError('TARGET_GONE', 'Task tabs were lost with the browser instance')
            return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent',
                browserInstanceId: driver.browserInstanceId() }, 'recovered', { browserInstanceId: driver.browserInstanceId() }))
        }
        if (task.pauseReason === 'awaiting-agent')
            return this.view(task)
        return this.view(await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent', agentGrant: auth.credential },
            'state-changed', { status: 'paused', pauseReason: 'awaiting-agent' }))
    }
    /**
     * Whether the user side of a wait is done, for both the agent's and the user's resume:
     * a handoff needs no check (the agent re-observes); a login needs the site's
     * loginCompleteWhen (or, without one, leaving the login path); other waits their predicate.
     */
    private async userWaitCompleted(task: StoredTask, wait: UserWaitCompletion | undefined, allowedOrigins: string[]): Promise<boolean> {
        if (task.waitReason === 'handoff')
            return true
        if (!wait?.predicate && !wait?.notPathPrefix)
            throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Wait completion condition is missing')
        const observation = await this.driver(task.profileId).observe(wait.tabId, allowedOrigins, { timeoutMs: 10000 })
        return wait.notPathPrefix
            ? task.waitReason === 'login'
                ? loginCompleted(this.options.sites, observation, wait.notPathPrefix, wait.protectedOrigin)
                : !new URL(observation.url).pathname.startsWith(wait.notPathPrefix)
            : matchesWait(wait.predicate!, observation)
    }
    /**
     * D8: the user can only hand a task back to the agent after something the user
     * resolved (a released takeover, possibly finishing a login/challenge wait), and
     * only while the task's stored execution grant is still valid. Approval waits,
     * uncertain writes, cancel requests and browser replacement are never released here.
     */
    private async userResume(task: StoredTask): Promise<TaskView> {
        if (task.status === 'paused' && task.pauseReason === 'awaiting-agent')
            return this.view(task)
        if (task.cancelRequested || task.uncertainActions.length || task.status !== 'paused'
            || task.pauseReason !== 'user-input-complete' || task.pendingApproval)
            throw new BrowserRuntimeError('CONFLICT', 'Task pause cannot be resumed by the user')
        const grant = task.agentGrant as AgentGrant | undefined
        if (!grant || grant.expiresAtMs <= this.clock.now() || this.options.store.isRevoked(grant.grantId))
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Task execution grant is expired or revoked')
        // Rechecked inside the final write: the page check below awaits the browser, and a
        // revoke, expiry, cancel or new takeover may land meanwhile.
        const unchanged = (current: StoredTask) => {
            if (current.stateVersion !== task.stateVersion || current.status !== task.status || current.pauseReason !== task.pauseReason
                || current.cancelRequested || current.uncertainActions.length || current.pendingApproval
                || current.tabs.some((tabId) => this.leases.owner(tabId, current.profileId).owner.kind === 'user'))
                throw new BrowserRuntimeError('CONFLICT', 'Task changed during resume')
            const currentGrant = current.agentGrant as AgentGrant | undefined
            if (!currentGrant || currentGrant.grantId !== grant.grantId || currentGrant.expiresAtMs <= this.clock.now()
                || this.options.store.isRevoked(currentGrant.grantId))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'Task execution grant is expired or revoked')
        }
        const wait = task.waitCompletion as UserWaitCompletion | undefined
        // Same completion rules as the agent's resume (handoff, site login condition, predicate).
        if (task.waitReason) {
            if (Number(task.waitExpiresAtMs ?? 0) > 0 && this.clock.now() > Number(task.waitExpiresAtMs))
                return this.view(await this.commit(task, { status: 'paused', pauseReason: 'user-wait-expired' }, 'state-changed',
                    { pauseReason: 'user-wait-expired', waitReason: task.waitReason }))
            if (!(await this.userWaitCompleted(task, wait, grant.allowedOrigins)))
                return this.view(await this.commit(task, { status: 'awaiting-user' }, 'state-changed', { status: 'awaiting-user',
                    waitReason: task.waitReason }, 0, false, unchanged))
        }
        const batchId = wait?.batchId as BatchId | undefined
        const batch = batchId ? task.batches[batchId] : undefined
        // The agent re-plans the rest of an interrupted batch; the user never continues agent steps.
        // Steps from nextStep on were never dispatched (the wait was committed before them).
        const remaining = batch ? batch.steps.slice(Number(wait?.nextStep ?? 0)) : []
        const completed = batch ? batch.steps.filter((step) => task.actions[step.actionId]?.state === 'confirmed') : []
        const result: BatchResult | undefined = batch && batchId ? {
            batchId, taskId: task.taskId, outcome: remaining.length ? 'failed' : 'succeeded',
            completedSteps: completed.map((step) => step.stepId), ...(remaining.length ? { failedStep: remaining[0].stepId } : {}),
            mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1,
            steps: [...completed.map((step) => ({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded' as const })),
                ...remaining.map((step) => ({ stepId: step.stepId, actionId: step.actionId, outcome: 'skipped' as const }))],
        } : undefined
        const resumed = await this.commit(task, { status: 'paused', pauseReason: 'awaiting-agent', waitReason: undefined,
            waitCompletion: undefined, waitExpiresAtMs: undefined,
            ...(result && batch && batchId ? { currentBatchId: undefined, lastBatch: result, batches: { ...task.batches, [batchId]: { ...batch, result } } } : {}),
        }, 'agent-attention-required', { attention: 'user-resumed', ...(task.waitReason ? { waitCompleted: task.waitReason } : {}),
            ...(batchId ? { batchId, skippedSteps: remaining.length } : {}) }, 0, false, unchanged)
        if (batchId)
            this.liveBatchSteps.delete(batchId)
        return this.view(resumed)
    }
    private async cancelImpl(auth: AuthContext, req: {
        taskId: TaskId
        requestId: RequestId
    }): Promise<{
        status: 'cancel-accepted'
        task: TaskView
        fenceAckMs: number
    }> {
        await this.recovery
        const started = this.clock.now()
        const task = this.requireTask(req.taskId)
        this.authorizeTask(auth, 'cancel', task)
        if (['succeeded', 'failed', 'cancelled'].includes(task.status))
            return { status: 'cancel-accepted', task: this.view(task), fenceAckMs: Math.max(0, this.clock.now() - started) }
        const latest = await this.cancelTask(task)
        return { status: 'cancel-accepted', task: this.view(latest), fenceAckMs: Math.max(0, this.clock.now() - started) }
    }
    /**
     * The cancel fence: revokes the task's input leases, aborts its worker and durably
     * records the cancel; writes whose outcome is unknown leave it paused
     * (`cancelled-with-unknown-effect`) instead of cancelled.
     */
    private async cancelTask(task: StoredTask): Promise<StoredTask> {
        const revokedLeases = this.leases.revokeTask(task.taskId)
        for (const lease of revokedLeases)
            await this.persistTabLease(task.taskId, task.taskSpaceId, lease.tabId, lease.leaseEpoch)
        this.controllers.get(task.taskId)?.abort(new Error('cancelled'))
        let uncertain: ActionId[] = []
        const next = await this.options.store.mutate(task.taskId, (current) => {
            if (['succeeded', 'failed', 'cancelled'].includes(current.status))
                return null
            uncertain = [...new Set([...current.uncertainActions, ...Object.entries(current.actions).filter(([, action]) =>
                ['navigate', 'click', 'fill'].includes(String(action.kind))
                    && ['intent-committed', 'dispatched'].includes(action.state)).map(([id]) => id as ActionId)])]
            return {
                patch: { cancelRequested: true, status: uncertain.length ? 'paused' : 'cancelled',
                    ...(uncertain.length ? { pauseReason: 'cancelled-with-unknown-effect', uncertainActions: uncertain } : {}) },
                event: this.event('cancel-accepted', { cancelRequested: true, uncertainActions: uncertain },
                    current.stateVersion + 1),
            }
        })
        return next ?? this.requireTask(task.taskId)
    }
    private async closeSpaceImpl(auth: AuthContext, req: {
        taskSpaceId: TaskSpaceId
        requestId: RequestId
    }): Promise<{
        closedTabs: TabId[]
    }> {
        await this.recovery
        const space = this.requireSpace(req.taskSpaceId)
        this.checkCredential(auth, 'closeSpace', space.profileId, req.taskSpaceId)
        this.authorizeSpace(auth, space)
        const duplicate = this.spaceRequest(space, auth, req.requestId, { operation: 'closeSpace', ...req })
        if (duplicate)
            return duplicate as {
                closedTabs: TabId[]
            }
        if (this.options.store.listTasks().some((task) => task.taskSpaceId === req.taskSpaceId && (!['succeeded', 'failed',
            'cancelled'].includes(task.status) || this.workers.has(task.taskId))))
            throw new BrowserRuntimeError('CONFLICT', 'Task space has non-terminal or in-flight tasks')
        const closedTabs: TabId[] = []
        for (const tab of space.tabs) {
            if (this.leases.owner(tab as TabId, space.profileId).owner.kind !== 'none')
                throw new BrowserRuntimeError('STALE_LEASE', 'Task space has an input owner')
            const result = await this.driver(space.profileId).closeTab(tab as TabId, { timeoutMs: 5000 })
            if (result.beforeUnloadBlocked || !result.closed)
                throw new BrowserRuntimeError('CONFLICT', 'A task space tab could not be closed')
            closedTabs.push(tab as TabId)
            await this.options.store.mutateSpace(req.taskSpaceId, (current) => {
                const { [tab]: _target, ...tabTargets } = current.tabTargets ?? {}
                const { [tab]: _epoch, ...tabLeaseEpochs } = current.tabLeaseEpochs ?? {}
                return {
                    tabs: current.tabs.filter((item) => item !== tab),
                    goneTabs: [...new Set([...(current.goneTabs ?? []), tab as TabId])],
                    tabTargets,
                    tabLeaseEpochs,
                }
            })
        }
        const response = { closedTabs }
        await this.options.store.updateSpace(req.taskSpaceId, {
            tabs: [], tabTargets: {}, tabLeaseEpochs: {}, profileUserOwner: null, closed: true,
            dedupe: this.spaceDedupe(space, auth, req.requestId, { operation: 'closeSpace', ...req }, response),
        })
        return response
    }
    async reconcileAction(taskId: TaskId, actionId: ActionId, confirmed: boolean): Promise<TaskView> {
        await this.recovery
        const task = this.requireTask(taskId)
        const action = task.actions[actionId]
        if (!action || action.state !== 'uncertain')
            throw new BrowserRuntimeError('CONFLICT', 'Action is not uncertain')
        const state = confirmed ? 'confirmed' as const : 'uncertain' as const
        const actions = { ...task.actions, [actionId]: { ...action, state } }
        const uncertainActions = confirmed ? task.uncertainActions.filter((id) => id !== actionId) : task.uncertainActions
        const status = task.cancelRequested && confirmed && uncertainActions.length === 0 ? 'cancelled' : task.status
        const updated = await this.commit(task, { actions, uncertainActions, status,
            ...(status === 'cancelled' ? { pauseReason: undefined } : uncertainActions.length === 0
                && !task.cancelRequested ? { pauseReason: 'awaiting-agent' } : {}) },
                    confirmed ? 'action-confirmed' : 'action-uncertain', { actionId, reconciled: confirmed })
        return this.view(updated)
    }
    private async withRequestFlight<T>(
        auth: AuthContext,
        requestId: RequestId,
        payload: unknown,
        run: () => Promise<T>,
    ): Promise<T> {
        await this.recovery
        this.assertMutationScope(auth, payload)
        const key = requestKey(auth, requestId)
        const hash = payloadHash(payload)
        const stored = this.findDurableRequest(key)
        if (stored) {
            if (stored.hash !== hash)
                throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return structuredClone(stored.result) as T
        }
        const active = this.requestFlights.get(key)
        if (active) {
            if (active.hash !== hash)
                throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
            return structuredClone(await active.promise) as T
        }
        const promise = (async () => {
            const result = await run()
            await this.persistRequestResult(key, hash, payload, result)
            return result
        })()
        this.requestFlights.set(key, { hash, promise })
        try {
            return await promise
        } finally {
            if (this.requestFlights.get(key)?.promise === promise)
                this.requestFlights.delete(key)
        }
    }
    private assertMutationScope(auth: AuthContext, payload: unknown): void {
        if (!isRecord(payload) || typeof payload.operation !== 'string')
            throw new BrowserRuntimeError('INVALID_REQUEST', 'Mutation operation is missing')
        const operation = payload.operation as Operation
        if (typeof payload.taskId === 'string') {
            const task = this.requireTask(payload.taskId as TaskId)
            this.authorizeTask(auth, operation, task)
            return
        }
        if (typeof payload.taskSpaceId === 'string') {
            const space = this.requireSpace(payload.taskSpaceId as TaskSpaceId)
            this.checkCredential(auth, operation, space.profileId, space.taskSpaceId)
            this.authorizeSpace(auth, space)
            return
        }
        if (typeof payload.profileId === 'string') {
            this.checkCredential(auth, operation, payload.profileId as ProfileId)
            return
        }
        throw new BrowserRuntimeError('INVALID_REQUEST', 'Mutation resource is missing')
    }
    private findDurableRequest(key: string): { hash: string; result: unknown } | undefined {
        for (const task of this.options.store.listTasks()) {
            const value = task.dedupe[key]
            if (value) return value
        }
        for (const space of this.options.store.listSpaces()) {
            const value = space.dedupe?.[key]
            if (value) return value
            if (space.requestKey === key && space.requestHash)
                return { hash: space.requestHash, result: { taskSpaceId: space.taskSpaceId } }
        }
        return undefined
    }
    private async persistRequestResult(key: string, hash: string, payload: unknown, result: unknown): Promise<void> {
        if (this.findDurableRequest(key)) return
        const payloadRecord = isRecord(payload) ? payload : {}
        const resultRecord = isRecord(result) ? result : {}
        const nestedTask = isRecord(resultRecord.task) ? resultRecord.task : undefined
        const taskIdValue = payloadRecord.taskId ?? resultRecord.taskId ?? nestedTask?.taskId
        if (typeof taskIdValue === 'string') {
            const taskId = taskIdValue as TaskId
            await this.options.store.mutate(taskId, (current) => {
                const existing = current.dedupe[key]
                if (existing) {
                    if (existing.hash !== hash)
                        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
                    return null
                }
                return {
                    patch: { dedupe: { ...current.dedupe, [key]: { hash, result: redact(result) } }, stateVersion: current.stateVersion },
                    event: this.event('state-changed', { requestStored: true }, current.stateVersion),
                }
            })
            return
        }
        const spaceIdValue = payloadRecord.taskSpaceId ?? resultRecord.taskSpaceId
        if (typeof spaceIdValue === 'string') {
            const spaceId = spaceIdValue as TaskSpaceId
            await this.options.store.mutateSpace(spaceId, (current) => {
                const existing = current.dedupe?.[key]
                if (existing) {
                    if (existing.hash !== hash)
                        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
                    return null
                }
                return { dedupe: { ...current.dedupe, [key]: { hash, result: redact(result) } } }
            })
        }
    }
    private async persistTabLease(taskId: TaskId, taskSpaceId: TaskSpaceId, tabId: TabId, epoch: number,
        profileUserOwner?: SpaceRecord['profileUserOwner']): Promise<void> {
        await this.options.store.mutate(taskId, (current) => ({
            patch: {
                tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
                stateVersion: current.stateVersion,
            },
            event: this.event('state-changed', { tabId, leaseEpochStored: true }, current.stateVersion),
        }))
        await this.options.store.mutateSpace(taskSpaceId, (current) => ({
            tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
            ...(profileUserOwner === undefined ? {} : { profileUserOwner }),
        }))
    }
    private async persistProfileUserOwner(profileId: ProfileId,
        profileUserOwner: SpaceRecord['profileUserOwner']): Promise<void> {
        for (const space of this.options.store.listSpaces(profileId))
            await this.options.store.updateSpace(space.taskSpaceId, { profileUserOwner })
    }
    private async restorePersistedTabs(profileId?: ProfileId): Promise<void> {
        for (const space of this.options.store.listSpaces(profileId)) {
            const driver = this.drivers.get(space.profileId)
            if (!driver)
                continue
            let currentInstance: BrowserInstanceId | undefined
            try {
                currentInstance = driver.browserInstanceId()
            }
            catch {
                currentInstance = undefined
            }
            const profileOwner = this.options.store.listSpaces(space.profileId)
                .map((item) => item.profileUserOwner)
                .find((owner) => owner != null) ?? undefined
            for (const tabId of [...space.tabs]) {
                const references = this.options.store.listTasks().filter((task) => task.tabs.includes(tabId))
                const targetId = space.tabTargets?.[tabId]
                    ?? references.map((task) => task.tabTargets?.[tabId]).find((target): target is string => Boolean(target))
                const browserMatches = Boolean(currentInstance) && references.every((task) =>
                    !task.browserInstanceId || task.browserInstanceId === currentInstance)
                const allowedOrigins = references.flatMap((task) => (task.agentGrant as AgentGrant | undefined)?.allowedOrigins ?? [])
                let adopted = false
                if (browserMatches && targetId && driver.adoptTab) {
                    try {
                        adopted = await driver.adoptTab(tabId, targetId, [...new Set(allowedOrigins)], { timeoutMs: 10000 })
                    }
                    catch {
                        adopted = false
                    }
                }
                else if (browserMatches) {
                    adopted = driver.hasTab(tabId)
                }
                if (!adopted) {
                    try {
                        await this.dropOwnedTab(space, tabId, references)
                    }
                    catch {
                        for (const task of references)
                            this.options.store.markUnreadable(task.taskId)
                    }
                    continue
                }
                const previousEpoch = Math.max(space.tabLeaseEpochs?.[tabId] ?? 0,
                    ...references.map((task) => task.tabLeaseEpochs?.[tabId] ?? 0))
                const persistedOwner = profileOwner?.tabId === tabId ? profileOwner.owner : { kind: 'none' as const }
                const epoch = this.leases.restore(tabId, space.profileId, previousEpoch, persistedOwner)
                await this.options.store.mutateSpace(space.taskSpaceId, (current) => ({
                    tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
                }))
                for (const task of references) {
                    await this.options.store.mutate(task.taskId, (current) => ({
                        patch: {
                            ...(targetId ? { tabTargets: { ...current.tabTargets, [tabId]: targetId } } : {}),
                            tabLeaseEpochs: { ...current.tabLeaseEpochs, [tabId]: epoch },
                            stateVersion: current.stateVersion,
                        },
                        event: this.event('state-changed', { tabId, leaseEpochRestored: true }, current.stateVersion),
                    }))
                }
            }
        }
    }
    private async dropOwnedTab(space: SpaceRecord, tabId: TabId, references: StoredTask[]): Promise<void> {
        await this.options.store.mutateSpace(space.taskSpaceId, (current) => {
            const { [tabId]: _target, ...tabTargets } = current.tabTargets ?? {}
            const { [tabId]: _epoch, ...tabLeaseEpochs } = current.tabLeaseEpochs ?? {}
            return {
                tabs: current.tabs.filter((tab) => tab !== tabId),
                goneTabs: [...new Set([...(current.goneTabs ?? []), tabId])],
                tabTargets,
                tabLeaseEpochs,
            }
        })
        for (const task of references) {
            const current = this.options.store.getTask(task.taskId)
            if (!current)
                continue
            const writes = inFlightWriteActions(current)
            const actions = { ...current.actions }
            for (const actionId of writes)
                actions[actionId] = { ...actions[actionId], state: 'uncertain' }
            await this.commit(task, {
                tabs: current.tabs.filter((tab) => tab !== tabId),
                tabTargets: Object.fromEntries(Object.entries(current.tabTargets ?? {}).filter(([tab]) => tab !== tabId)),
                tabLeaseEpochs: Object.fromEntries(Object.entries(current.tabLeaseEpochs ?? {}).filter(([tab]) => tab !== tabId)),
                ...(writes.length ? { status: 'paused', pauseReason: 'outcome-unknown', actions,
                    uncertainActions: [...new Set([...current.uncertainActions, ...writes])] } : {}),
            }, writes.length ? 'action-uncertain' : 'page-closed', { tabId, reason: 'adoption-failed', uncertainActions: writes })
        }
    }
    private async interruptPersistedBatch(task: StoredTask, batchId: BatchId, nextStep: number): Promise<StoredTask> {
        const batch = task.batches[String(batchId)]
        if (!batch)
            throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Interrupted batch record is missing')
        const step = batch.steps[nextStep]
        const action = step ? task.actions[step.actionId] : undefined
        const mayHaveSideEffects = Boolean(action && ['intent-committed', 'dispatched', 'uncertain'].includes(action.state)
            && ['navigate', 'click', 'fill'].includes(String(action.kind)))
        const actions = { ...task.actions }
        const uncertainActions = [...task.uncertainActions]
        if (mayHaveSideEffects && step) {
            actions[step.actionId] = { ...action, state: 'uncertain' }
            if (!uncertainActions.includes(step.actionId))
                uncertainActions.push(step.actionId)
        }
        const completedSteps = batch.steps.filter((item) => task.actions[item.actionId]?.state === 'confirmed')
            .map((item) => item.stepId)
        const result: BatchResult = {
            batchId,
            taskId: task.taskId,
            outcome: 'failed',
            completedSteps,
            ...(step ? { failedStep: step.stepId } : {}),
            mayHaveSideEffects,
            lastCheckpointSeq: task.highWatermarkSeq + 1,
            steps: [
                ...batch.steps.filter((item) => completedSteps.includes(item.stepId)).map((item) => ({
                    stepId: item.stepId,
                    actionId: item.actionId,
                    outcome: 'succeeded' as const,
                })),
                ...(step ? [{ stepId: step.stepId, actionId: step.actionId,
                    outcome: mayHaveSideEffects ? 'uncertain' as const : 'failed' as const }] : []),
            ],
        }
        const approvals = Object.fromEntries(Object.entries(task.approvals).map(([id, approval]) => [id, {
            ...approval,
            ...(approval.batchId === batchId && approval.state === 'pending' ? { state: 'expired' as const } : {}),
        }]))
        const interrupted = await this.commit(task, {
            status: 'paused',
            pauseReason: 'awaiting-agent',
            waitReason: undefined,
            waitCompletion: undefined,
            waitExpiresAtMs: undefined,
            currentBatchId: undefined,
            pendingApproval: undefined,
            approvals,
            actions,
            uncertainActions,
            lastBatch: result,
            batches: { ...task.batches, [batchId]: { ...batch, result } },
        }, 'recovered', { batchId, interrupted: true, failedStep: step?.stepId, mayHaveSideEffects })
        return interrupted
    }
    private async recoverExistingTasks(): Promise<void> {
        await this.restorePersistedTabs().catch(() => undefined)
        for (const task of this.options.store.listTasks()) {
            if (['succeeded', 'failed', 'cancelled'].includes(task.status))
                continue
            if (task.resumeClaimId) {
                await this.options.store.mutate(task.taskId, (current) => current.resumeClaimId ? {
                    patch: { resumeClaimId: undefined, stateVersion: current.stateVersion },
                    event: this.event('recovered', { resumeClaimCleared: true }, current.stateVersion),
                } : null).catch(() => undefined)
            }
            const driver = this.drivers.get(task.profileId)
            const taskGrant = task.agentGrant as AgentGrant | undefined
            const pendingWriteIds = inFlightWriteActions(task)
            const pendingWrites = pendingWriteIds.map((id) => [id, task.actions[id]] as const)
            const revokedSegmentActions = Object.entries(task.actions).filter(([, action]) => action.grantId
                && this.options.store.isRevoked(action.grantId)
                && ['planned', 'intent-committed', 'dispatched'].includes(action.state)).map(([id]) => id as ActionId)
            const actions = { ...task.actions }
            for (const [id, action] of pendingWrites)
                actions[id] = { ...action, state: 'uncertain' }
            const batchId = task.currentBatchId
            const batch = batchId ? task.batches[batchId] : undefined
            const completedSteps = batch?.steps.filter((step) => task.actions[step.actionId]?.state === 'confirmed')
                .map((step) => step.stepId) ?? []
            const nextStep = batch?.steps.find((step) => !completedSteps.includes(step.stepId))
            const interrupted: BatchResult | undefined = batchId && batch ? {
                batchId,
                taskId: task.taskId,
                outcome: 'failed',
                completedSteps,
                ...(nextStep ? { failedStep: nextStep.stepId } : {}),
                mayHaveSideEffects: pendingWrites.length > 0,
                lastCheckpointSeq: task.highWatermarkSeq + 1,
                steps: [
                    ...batch.steps.filter((step) => completedSteps.includes(step.stepId)).map((step) => ({
                        stepId: step.stepId,
                        actionId: step.actionId,
                        outcome: 'succeeded' as const,
                    })),
                    ...(nextStep ? [{ stepId: nextStep.stepId, actionId: nextStep.actionId,
                        outcome: pendingWrites.some(([id]) => id === nextStep.actionId)
                            ? 'uncertain' as const : 'failed' as const }] : []),
                ],
            } : undefined
            const batchPatch = interrupted && batchId && batch
                ? { lastBatch: interrupted, currentBatchId: undefined,
                    batches: { ...task.batches, [batchId]: { ...batch, result: interrupted } } }
                : {}
            let patch: Partial<StoredTask>
            if (task.cancelRequested) {
                const unresolved = [...new Set([...task.uncertainActions, ...pendingWrites.map(([id]) => id as ActionId)])]
                patch = unresolved.length ? { status: 'paused', pauseReason: 'cancelled-with-unknown-effect',
                    uncertainActions: unresolved, actions } : { status: 'cancelled' }
            }
            else if (!taskGrant || taskGrant.expiresAtMs <= this.clock.now()
                || this.options.store.isRevoked(taskGrant.grantId) || revokedSegmentActions.length) {
                const approvals = Object.fromEntries(Object.entries(task.approvals).map(([id, approval]) => [id, {
                    ...approval,
                    ...(approval.grantId && this.options.store.isRevoked(approval.grantId)
                        && approval.state === 'pending' ? { state: 'expired' as const } : {}),
                }]))
                patch = { status: 'paused', pauseReason: pendingWrites.length ? 'outcome-unknown' : 'grant-expired', actions,
                    approvals,
                    ...batchPatch,
                    ...(pendingWrites.length ? { uncertainActions: [...new Set([...task.uncertainActions,
                        ...pendingWrites.map(([id]) => id as ActionId)])] } : {}) }
            }
            else if (!driver || !browserInstanceMatches(task, driver.browserInstanceId())) {
                patch = { status: 'paused', pauseReason: pendingWrites.length ? 'outcome-unknown' : 'browser-replaced',
                    browserInstanceId: driver?.browserInstanceId(), actions,
                    ...batchPatch,
                    ...(pendingWrites.length ? { uncertainActions: [...new Set([...task.uncertainActions,
                        ...pendingWrites.map(([id]) => id as ActionId)])] } : {}),
                    pendingApproval: undefined }
            }
            else if (pendingWrites.length) {
                patch = { status: 'paused', pauseReason: 'outcome-unknown', uncertainActions: [...new Set([...task.uncertainActions,
                    ...pendingWrites.map(([id]) => id as ActionId)])], actions, ...batchPatch }
            }
            else if (task.status === 'running' || task.status === 'recovering') {
                patch = {
                    status: 'paused',
                    pauseReason: 'awaiting-agent',
                    actions,
                    ...batchPatch,
                }
            }
            else
                continue
            await this.commit(task, patch, 'recovered', { previousStatus: task.status, pauseReason: patch.pauseReason,
                uncertainActions: patch.uncertainActions ?? [], attention: 'recovered' }).catch(() => this.options.store.markUnreadable(task.taskId))
        }
    }
    pinnedProfiles(nowMs = this.clock.now()): ProfileId[] {
        const profiles = new Set<ProfileId>()
        for (const task of this.options.store.listTasks()) {
            const age = nowMs - task.updatedAtMs
            if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
                if (age <= POC_LIMITS.terminalBrowserIdleMs)
                    profiles.add(task.profileId)
                continue
            }
            if (task.status === 'running' || task.status === 'recovering'
                || task.status === 'awaiting-user'
                    && age <= POC_LIMITS.userWaitMs + POC_LIMITS.pausedBrowserRetentionMs
                || task.status !== 'awaiting-user' && age <= POC_LIMITS.pausedBrowserRetentionMs)
                profiles.add(task.profileId)
        }
        return [...profiles]
    }
    private async runBatch(task0: StoredTask, batchId: BatchId, steps: BatchStep[], auth: AuthContext, fromIndex = 0,
        approvedActionId?: ActionId): Promise<BatchResult> {
        const results: BatchResult['steps'] = []
        const completedSteps: BatchResult['completedSteps'] = []
        let failedStep: BatchResult['failedStep']
        let outcome: BatchResult['outcome'] = 'succeeded'
        let mayHaveSideEffects = false
        const driver = this.driver(task0.profileId)
        const grant = this.agentGrant(auth)
        const controller = this.controllers.get(task0.taskId) ?? new AbortController()
        this.controllers.set(task0.taskId, controller)
        const batchLeases = new Map<TabId, number>()
        const pendingPostconditions: Array<{ actionId: ActionId; stepId: BatchStep['stepId']; tabId: TabId }> = []
        const namedObservations = new Map<string, Observation>()
        let preserveLeases = false
        /** The step is not executed; the task waits for the user (takeover), then the agent re-observes. */
        const handOff = async (current: StoredTask, step: BatchStep, index: number, leaseEpoch: number, reason: BrowserRuntimeError) => {
            const waiting = await this.commit(current, {
                status: 'awaiting-user',
                waitReason: 'handoff',
                waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs,
                waitCompletion: { batchId, nextStep: index, tabId: step.tabId, handoff: true },
                actions: { ...current.actions, [step.actionId]: { ...current.actions[step.actionId], state: 'failed' } },
            }, 'state-changed', { status: 'awaiting-user', waitReason: 'handoff', actionId: step.actionId, error: safeError(reason) }, leaseEpoch)
            preserveLeases = true
            results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'awaiting-user', error: safeError(reason) })
            return this.saveBatchResult(waiting, batchId, { batchId, taskId: waiting.taskId, outcome: 'awaiting-user', completedSteps,
                mayHaveSideEffects: false, lastCheckpointSeq: waiting.highWatermarkSeq + 1, steps: results, waitReason: 'handoff' })
        }
        try {
            for (let index = fromIndex; index < steps.length; index++) {
                const step = steps[index]
                let resolvedRef = step.ref
                let namedSnapshot: SnapshotId | undefined
                let refResolutionError: BrowserRuntimeError | undefined
                if (['click', 'fill'].includes(step.kind) && typeof step.ref === 'string' && step.ref.startsWith('$')) {
                    const separator = step.ref.indexOf('.', 1)
                    const resultName = separator > 1 ? step.ref.slice(1, separator) : ''
                    const accessibleName = separator > 1 ? step.ref.slice(separator + 1) : ''
                    const namedObservation = resultName ? namedObservations.get(resultName) : undefined
                    const matches = namedObservation?.elements.filter((element) => element.name === accessibleName) ?? []
                    if (!namedObservation || !accessibleName || matches.length !== 1) {
                        refResolutionError = new BrowserRuntimeError('INVALID_REQUEST',
                            'Named ref must identify exactly one element in this batch')
                    }
                    else {
                        resolvedRef = matches[0].ref
                        namedSnapshot = namedObservation.snapshotId
                    }
                }
                const agentSnapshot = namedSnapshot ?? (['click', 'fill'].includes(step.kind)
                    ? step.snapshotId
                    : undefined)
                const effectiveStep: BatchStep = {
                    ...step,
                    ...(resolvedRef ? { ref: resolvedRef } : {}),
                    ...(agentSnapshot ? { snapshotId: agentSnapshot } : {}),
                }
                let task = this.requireTask(task0.taskId)
                if (task.cancelRequested) {
                    outcome = 'cancelled'
                    break
                }
                if (!this.isCredentialLive(auth)) {
                    this.leases.revokeTask(task.taskId)
                    await this.commit(task, { status: 'paused', pauseReason: 'grant-expired' }, 'state-changed',
                        { pauseReason: 'grant-expired' })
                    outcome = 'failed'
                    break
                }
                if (this.clock.now() - task.createdAtMs >= POC_LIMITS.taskTimeLimitMs) {
                    this.leases.revokeTask(task.taskId)
                    await this.commit(task, { status: 'paused', pauseReason: 'task-time-limit' }, 'state-changed',
                        { pauseReason: 'task-time-limit' })
                    outcome = 'failed'
                    break
                }
                if (task.browserInstanceId !== driver.browserInstanceId()) {
                    await this.commit(task, { status: 'paused', pauseReason: 'browser-replaced',
                        browserInstanceId: driver.browserInstanceId() }, 'state-changed', { pauseReason: 'browser-replaced' })
                    outcome = 'failed'
                    break
                }
                const origin = await driver.currentOrigin(step.tabId)
                if (!grant.allowedOrigins.includes(origin))
                    throw new BrowserRuntimeError('ORIGIN_DENIED', 'Current page origin is not allowed')
                let leaseEpoch = batchLeases.get(step.tabId)
                if (leaseEpoch === undefined) {
                    leaseEpoch = this.leases.acquire(step.tabId, task.profileId, { kind: 'agent', agentSessionId: task.agentSessionId,
                        taskId: task.taskId, segmentId: batchId })
                    batchLeases.set(step.tabId, leaseEpoch)
                    await this.persistTabLease(task.taskId, task.taskSpaceId, step.tabId, leaseEpoch)
                }
                const action = task.actions[step.actionId]
                if (action) {
                    if (action.payloadHash !== payloadHash(step))
                        throw new BrowserRuntimeError('CONFLICT', 'actionId has been used with different input')
                    if (action.state === 'confirmed')
                        throw new BrowserRuntimeError('CONFLICT', 'actionId was already confirmed in a prior batch')
                    throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'actionId has an unresolved prior result', false, true)
                }
                const intent = await this.options.store.mutate(task.taskId, (current) => {
                    if (current.actions[step.actionId])
                        throw new BrowserRuntimeError('CONFLICT', 'actionId already has a durable intent')
                    if (current.cancelRequested || current.status !== 'running' || !this.isCredentialLive(auth))
                        throw new BrowserRuntimeError('STALE_LEASE', 'Task execution fence changed')
                    return {
                        patch: {
                            actions: { ...current.actions, [step.actionId]: { state: 'intent-committed', kind: step.kind,
                                batchId, grantId: grant.grantId, payloadHash: payloadHash(step), leaseEpoch,
                                browserInstanceId: driver.browserInstanceId() } },
                            batches: { ...current.batches, [batchId]: { ...current.batches[batchId],
                                steps: persistedBatchSteps(steps), nextStep: index } },
                        },
                        event: this.event('action-intent', { actionId: step.actionId, kind: step.kind,
                            payloadHash: payloadHash(step) }, current.stateVersion + 1, leaseEpoch),
                    }
                })
                if (!intent)
                    throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Action intent was not committed')
                task = intent
                let description: ElementDescription | undefined
                let decision: ReturnType<typeof classifySiteAction> = 'auto'
                try {
                    if (['click', 'fill'].includes(step.kind)) {
                        if (refResolutionError)
                            throw refResolutionError
                        if (!agentSnapshot)
                            throw new BrowserRuntimeError('STALE_REF', 'Action has no agent-visible snapshot', false, false)
                        if (!driver.describeRef)
                            throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'Driver cannot safely classify referenced actions', false, false)
                        description = await driver.describeRef(step.tabId, effectiveStep.ref as ElementRef, agentSnapshot,
                            { timeoutMs: step.timeoutMs })
                        if (!grant.allowedOrigins.includes(description.frameOrigin)
                            || !grant.allowedOrigins.includes(new URL(description.pageUrl).origin))
                            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Referenced element origin is not allowed', false, false)
                        // The agent chose this element by its snapshot label; a relabel in place means it chose something else.
                        if (description.currentName !== undefined && (description.role || description.name)
                            && (description.currentName !== description.name || description.currentRole !== description.role))
                            throw new BrowserRuntimeError('STALE_REF', 'Element label changed since the snapshot; observe again', false, false)
                    }
                    if (step.actionId !== approvedActionId)
                        decision = classifySiteAction(this.options.sites, effectiveStep, description)
                    if (decision === 'deny')
                        throw new BrowserRuntimeError('ORIGIN_DENIED', 'Site policy refuses this destination', false, false)
                }
                catch (error) {
                    // Description is read-only preflight; input has not been sent.
                    const safeRefusal = true
                    const write = ['click', 'fill', 'navigate'].includes(step.kind)
                    const uncertain = write && !safeRefusal
                    const state = uncertain ? 'uncertain' as const : 'failed' as const
                    task = await this.commit(task, {
                        actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state } },
                        status: 'paused',
                        ...(uncertain ? { pauseReason: 'outcome-unknown',
                            uncertainActions: [...new Set([...task.uncertainActions, step.actionId])] }
                            : { pauseReason: 'awaiting-agent' }),
                    }, uncertain ? 'action-uncertain' : 'action-failed', {
                        actionId: step.actionId,
                        error: safeError(error),
                    }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId,
                        outcome: uncertain ? 'uncertain' : 'failed', error: safeError(error) })
                    failedStep = step.stepId
                    outcome = uncertain ? 'uncertain' : 'failed'
                    mayHaveSideEffects = uncertain
                    break
                }
                if (approvedActionId === step.actionId) {
                    const boundApproval = Object.values(task.approvals).find((item) => item.actionId === step.actionId
                        && item.batchId === batchId && item.state === 'consumed')
                    const currentBindingHash = description ? approvalPayloadHash(effectiveStep, description) : ''
                    const recomputedApprovalBinding = boundApproval ? approvalBinding({
                        principalId: grant.principalId,
                        workspaceId: grant.workspaceId,
                        taskId: task.taskId,
                        actionId: step.actionId,
                        origin: String(boundApproval.origin),
                        payloadHash: currentBindingHash,
                        leaseEpoch: Number(boundApproval.leaseEpoch),
                        browserInstanceId: String(boundApproval.browserInstanceId),
                        documentGeneration: Number(description?.documentGeneration ?? -1),
                        expiresAtMs: Number(boundApproval.expiresAtMs),
                        frameOrigin: String(description?.frameOrigin),
                    }) : ''
                    const liveLease = this.leases.owner(step.tabId, task.profileId)
                    if (!boundApproval || !description || Number(boundApproval.expiresAtMs) <= this.clock.now()
                        || !this.isCredentialLive(auth) || task.cancelRequested || task.status !== 'running'
                        || liveLease.leaseEpoch !== Number(task.tabLeaseEpochs?.[step.tabId])
                        || liveLease.owner.kind !== 'agent' || liveLease.owner.taskId !== task.taskId
                        || liveLease.owner.segmentId !== batchId || driver.browserInstanceId() !== boundApproval.browserInstanceId
                        || origin !== boundApproval.origin || description.documentGeneration !== boundApproval.documentGeneration
                        || description.frameOrigin !== boundApproval.frameOrigin || currentBindingHash !== boundApproval.payloadHash
                        || (boundApproval.elementIdentity !== undefined && description.identity !== boundApproval.elementIdentity)
                        || recomputedApprovalBinding !== boundApproval.bindingHash)
                        throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'Approval binding changed before dispatch')
                }
                // Nothing to bind an approval to (a navigation) or nothing that can be bound: the user does it.
                if (decision === 'handoff' || (step.kind === 'navigate' && decision === 'requires-approval'))
                    return handOff(task, step, index, leaseEpoch, new BrowserRuntimeError('APPROVAL_REQUIRED',
                        'Site policy hands this action to the user', false, false))
                if (['click', 'fill'].includes(step.kind) && decision === 'requires-approval') {
                    const expiresAtMs = this.clock.now() + POC_LIMITS.userWaitMs
                    const approval = createApproval({
                        grant,
                        taskId: task.taskId,
                        batchId,
                        step: effectiveStep,
                        nextStep: index,
                        origin,
                        leaseEpoch,
                        browserInstanceId: driver.browserInstanceId(),
                        snapshotId: agentSnapshot!,
                        description: description!,
                        expiresAtMs,
                    })
                    const approvalId = approval.summary.approvalId
                    const pendingApproval = approval.summary
                    const approvals = { ...task.approvals, [approvalId]: approval.record }
                    const approvalBatch = task.batches[batchId]
                    const approvalSteps = [...approvalBatch.steps]
                    approvalSteps[index] = effectiveStep
                    task = await this.commit(task, {
                        status: 'awaiting-user',
                        waitReason: 'approval',
                        waitExpiresAtMs: expiresAtMs,
                        pendingApproval,
                        actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'planned' } },
                        approvals,
                        batches: { ...task.batches, [batchId]: { ...approvalBatch, steps: persistedBatchSteps(approvalSteps),
                            nextStep: index } },
                    }, 'approval-requested', {
                                approvalId,
                                actionId: step.actionId,
                                origin,
                                bindingHash: pendingApproval.bindingHash,
                            }, leaseEpoch)
                    preserveLeases = true
                    return this.saveBatchResult(task, batchId, { batchId, taskId: task.taskId, outcome: 'awaiting-user',
                        completedSteps, mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1, steps: results,
                            pendingApproval, waitReason: 'approval' })
                }
                if (step.kind === 'waitFor') {
                    const pageUrl = this.latestAgentUrls.get(step.tabId)
                    const waitReason = pageUrl ? classifyUserWait(pageUrl) : undefined
                    if (waitReason) {
                        task = await this.commit(task, { status: 'awaiting-user', waitReason,
                            waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs, waitCompletion: { batchId, nextStep: index,
                                tabId: step.tabId, notPathPrefix: waitReason === 'login' ? '/login' : '/challenge',
                                protectedOrigin: new URL(pageUrl!).origin } }, 'state-changed',
                                    { status: 'awaiting-user', waitReason, actionId: step.actionId }, leaseEpoch)
                        preserveLeases = true
                        return this.saveBatchResult(task, batchId, { batchId, taskId: task.taskId, outcome: 'awaiting-user',
                            completedSteps, mayHaveSideEffects: false, lastCheckpointSeq: task.highWatermarkSeq + 1, steps: results,
                                waitReason })
                    }
                }
                task = this.requireTask(task.taskId)
                if (task.cancelRequested || task.status !== 'running' || !this.isCredentialLive(auth)
                    || task.browserInstanceId !== driver.browserInstanceId())
                    throw new BrowserRuntimeError('STALE_LEASE', 'Task execution fence changed')
                if (this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch
                    || await driver.currentOrigin(step.tabId) !== origin)
                    throw new BrowserRuntimeError('STALE_LEASE', 'Input lease or origin changed before dispatch')
                this.leases.assert(step.tabId, task.profileId, task.taskId, batchId, leaseEpoch)
                const armed = driver as DriverWithAction
                armed.armAction?.(step.actionId)
                this.inFlightDriverCalls.add(task.taskId)
                try {
                    const dispatchResult = await this.dispatch(driver, effectiveStep, grant, controller.signal,
                        step.kind === 'click' && description ? dispatchExpectation(description) : undefined)
                    const finalOrigin = await driver.currentOrigin(step.tabId)
                    if (!grant.allowedOrigins.includes(finalOrigin))
                        throw new BrowserRuntimeError('ORIGIN_DENIED', 'Action navigated to a disallowed origin', false, false)
                    const landedUrl = step.kind === 'navigate' && dispatchResult && 'url' in dispatchResult
                        ? dispatchResult.url : undefined
                    const landedWaitReason = landedUrl ? classifyUserWait(landedUrl) : undefined
                    if (step.kind === 'observe' && dispatchResult && 'snapshotId' in dispatchResult) {
                        if (!grant.allowedOrigins.includes(new URL(dispatchResult.url).origin))
                            throw new BrowserRuntimeError('ORIGIN_DENIED', 'Observed page origin is not allowed', false, false)
                        this.latestAgentSnapshots.set(step.tabId, dispatchResult.snapshotId)
                        this.latestAgentUrls.set(step.tabId, dispatchResult.url)
                        if (step.name)
                            namedObservations.set(step.name, sanitizeObservation(dispatchResult, grant.allowedOrigins))
                    }
                    if (landedUrl)
                        this.latestAgentUrls.set(step.tabId, landedUrl)
                    task = this.requireTask(task.taskId)
                    if (task.cancelRequested || this.leases.owner(step.tabId,
                        task.profileId).leaseEpoch !== leaseEpoch || task.status !== 'running') {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' as const : 'skipped' as const
                        await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId],
                            state } }, ...(uncertain ? { uncertainActions: [...new Set([...task.uncertainActions,
                                step.actionId])] } : {}) }, 'late-result', { actionId: step.actionId, ignored: true }, leaseEpoch)
                        outcome = uncertain ? 'uncertain' : 'cancelled'
                        mayHaveSideEffects = uncertain
                        break
                    }
                    task = await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId],
                        state: 'dispatched' } } }, 'action-dispatched', { actionId: step.actionId }, leaseEpoch)
                    if (step.kind === 'waitFor') {
                        const observedPostconditions = pendingPostconditions.filter((pending) => pending.tabId === step.tabId)
                        if (observedPostconditions.length) {
                            const actions = { ...task.actions }
                            for (const pending of observedPostconditions)
                                actions[pending.actionId] = { ...actions[pending.actionId], state: 'confirmed' }
                            task = await this.commit(task, { actions }, 'action-confirmed', {
                                reason: 'postcondition-observed',
                                actionIds: observedPostconditions.map((pending) => pending.actionId),
                                postconditionActionId: step.actionId,
                            }, leaseEpoch)
                            for (const pending of observedPostconditions) {
                                completedSteps.push(pending.stepId)
                                results.push({ stepId: pending.stepId, actionId: pending.actionId, outcome: 'succeeded' })
                                pendingPostconditions.splice(pendingPostconditions.indexOf(pending), 1)
                            }
                        }
                    }
                    // An approved (or held) click or navigation is confirmed only by a trusted postcondition;
                    // a fill's own effect is the value it typed.
                    const requiresPostcondition = ['click', 'navigate'].includes(step.kind)
                        && classifySiteAction(this.options.sites, effectiveStep, description) !== 'auto'
                    const hasPostconditionStep = steps.slice(index + 1).some((candidate) => candidate.tabId === step.tabId
                        && candidate.kind === 'waitFor')
                    if (requiresPostcondition && !hasPostconditionStep) {
                        task = await this.commit(task, {
                            actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'uncertain' } },
                            status: 'paused',
                            pauseReason: 'outcome-unknown',
                            uncertainActions: [...new Set([...task.uncertainActions, step.actionId])],
                        }, 'action-uncertain', { actionId: step.actionId, reason: 'postcondition-required' }, leaseEpoch)
                        results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'uncertain' })
                        failedStep = step.stepId
                        outcome = 'uncertain'
                        mayHaveSideEffects = true
                        break
                    }
                    if (requiresPostcondition && hasPostconditionStep) {
                        pendingPostconditions.push({ actionId: step.actionId, stepId: step.stepId, tabId: step.tabId })
                        continue
                    }
                    const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: 'confirmed' as const } }
                    task = await this.commit(task, { actions, batches: { ...task.batches, [batchId]: {
                        ...task.batches[batchId], steps: persistedBatchSteps(steps),
                        nextStep: index + 1 } } }, 'action-confirmed', { actionId: step.actionId }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'succeeded',
                        ...(step.kind === 'observe' && dispatchResult && 'snapshotId' in dispatchResult
                            ? { observation: sanitizeObservation(dispatchResult, grant.allowedOrigins) } : {}) })
                    completedSteps.push(step.stepId)
                    if (landedWaitReason) {
                        const notPathPrefix = landedWaitReason === 'login' ? '/login' : '/challenge'
                        task = await this.commit(task, {
                            status: 'awaiting-user',
                            waitReason: landedWaitReason,
                            waitExpiresAtMs: this.clock.now() + POC_LIMITS.userWaitMs,
                            waitCompletion: { batchId, nextStep: index + 1, tabId: step.tabId, notPathPrefix },
                        }, 'state-changed', {
                            status: 'awaiting-user',
                            waitReason: landedWaitReason,
                            tabId: step.tabId,
                        }, leaseEpoch)
                        preserveLeases = true
                        return this.saveBatchResult(task, batchId, {
                            batchId,
                            taskId: task.taskId,
                            outcome: 'awaiting-user',
                            completedSteps,
                            mayHaveSideEffects: false,
                            lastCheckpointSeq: task.highWatermarkSeq + 1,
                            steps: results,
                            waitReason: landedWaitReason,
                        })
                    }
                }
                catch (error) {
                    task = this.requireTask(task.taskId)
                    const pending = pendingPostconditions.filter((candidate) => candidate.tabId === step.tabId)
                    if (pending.length && task.status === 'running' && !task.cancelRequested) {
                        const actions = { ...task.actions }
                        for (const candidate of pending)
                            actions[candidate.actionId] = { ...actions[candidate.actionId], state: 'uncertain' }
                        actions[step.actionId] = { ...actions[step.actionId], state: 'failed' }
                        const uncertainIds = [...new Set([...task.uncertainActions,
                            ...pending.map((candidate) => candidate.actionId)])]
                        task = await this.commit(task, { actions, status: 'paused', pauseReason: 'outcome-unknown',
                            uncertainActions: uncertainIds }, 'action-uncertain', {
                            actionIds: pending.map((candidate) => candidate.actionId),
                            postconditionActionId: step.actionId,
                            error: safeError(error),
                        }, leaseEpoch)
                        for (const candidate of pending) {
                            results.push({ stepId: candidate.stepId, actionId: candidate.actionId, outcome: 'uncertain' })
                            pendingPostconditions.splice(pendingPostconditions.indexOf(candidate), 1)
                        }
                        results.push({ stepId: step.stepId, actionId: step.actionId, outcome: 'failed',
                            error: safeError(error) })
                        failedStep = pending[0].stepId
                        outcome = 'uncertain'
                        mayHaveSideEffects = true
                        break
                    }
                    if (task.pauseReason === 'user-control' || this.leases.owner(step.tabId, task.profileId).leaseEpoch !== leaseEpoch) {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' as const : 'skipped' as const
                        await this.commit(task, { actions: { ...task.actions, [step.actionId]: { ...task.actions[step.actionId],
                            state } }, ...(uncertain ? { uncertainActions: [...new Set([...task.uncertainActions,
                                step.actionId])] } : {}) }, 'late-result', { actionId: step.actionId, ignored: true }, leaseEpoch)
                        outcome = uncertain ? 'uncertain' : 'cancelled'
                        mayHaveSideEffects = uncertain
                        break
                    }
                    if (task.cancelRequested) {
                        const uncertain = ['click', 'fill', 'navigate'].includes(step.kind)
                        const state = uncertain ? 'uncertain' as const : 'skipped' as const
                        const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state } }
                        await this.commit(task, { actions, ...(uncertain ? { status: 'paused',
                            pauseReason: 'cancelled-with-unknown-effect', uncertainActions: [...new Set([...task.uncertainActions,
                                step.actionId])] } : { status: 'cancelled' }) }, 'late-result', { actionId: step.actionId,
                                    cancelled: true }, leaseEpoch)
                        outcome = 'cancelled'
                        break
                    }
                    // The driver could not verify the action (e.g. a transformed frame) and sent nothing: the user does it.
                    if (error instanceof BrowserRuntimeError && error.code === 'APPROVAL_REQUIRED' && !error.mayHaveSideEffects)
                        return handOff(task, step, index, leaseEpoch, error)
                    const write = ['click', 'fill', 'navigate'].includes(step.kind)
                    const runtimeError = error instanceof BrowserRuntimeError ? error : undefined
                    const deniedOrigin = runtimeError?.code === 'ORIGIN_DENIED'
                    const uncertain = write && runtimeError?.mayHaveSideEffects !== false && !deniedOrigin
                    const actionState = uncertain ? 'uncertain' as const : 'failed' as const
                    const actions = { ...task.actions, [step.actionId]: { ...task.actions[step.actionId], state: actionState } }
                    const safeFailure = !uncertain && !deniedOrigin
                    task = await this.commit(task, {
                        actions,
                        status: uncertain || safeFailure ? 'paused' : 'failed',
                        ...(uncertain
                            ? { pauseReason: 'outcome-unknown', uncertainActions: [...task.uncertainActions, step.actionId] }
                            : safeFailure ? { pauseReason: 'awaiting-agent' } : {}),
                        ...(safeFailure ? { currentBatchId: undefined } : {}),
                    }, uncertain ? 'action-uncertain' : 'action-failed', { actionId: step.actionId,
                                error: safeError(error) }, leaseEpoch)
                    results.push({ stepId: step.stepId, actionId: step.actionId, outcome: uncertain ? 'uncertain' : 'failed',
                        error: safeError(error) })
                    failedStep = step.stepId
                    outcome = uncertain ? 'uncertain' : 'failed'
                    mayHaveSideEffects = uncertain
                    break
                }
                finally {
                    this.inFlightDriverCalls.delete(task.taskId)
                    const completedTakeovers = this.leases.completePendingTakeovers(task.taskId)
                    if (completedTakeovers.length) {
                        const current = this.requireTask(task.taskId)
                        await this.commit(current, {}, 'input-owner-changed', {
                            owner: 'user',
                            settling: false,
                            tabs: completedTakeovers.map((takeover) => takeover.tabId),
                        }, completedTakeovers[0].leaseEpoch)
                    }
                }
            }
            let finalTask = this.requireTask(task0.taskId)
            if (outcome === 'succeeded' && finalTask.status === 'running') {
                const pauseReason = this.clock.now() - finalTask.createdAtMs >= POC_LIMITS.taskTimeLimitMs
                    ? 'task-time-limit' : 'awaiting-agent'
                finalTask = await this.commit(finalTask, { status: 'paused', pauseReason, currentBatchId: undefined }, 'state-changed',
                    { status: 'paused', pauseReason })
            }
            finalTask = this.requireTask(finalTask.taskId)
            return this.saveBatchResult(finalTask, batchId, { batchId, taskId: finalTask.taskId, outcome, completedSteps,
                ...(failedStep ? { failedStep } : {}), mayHaveSideEffects, lastCheckpointSeq: finalTask.highWatermarkSeq + 1,
                    steps: results })
        }
        finally {
            if (!preserveLeases)
                for (const [tabId, epoch] of batchLeases) {
                    const current = this.leases.owner(tabId, task0.profileId)
                    if (current.owner.kind === 'agent' && current.owner.taskId === task0.taskId && current.owner.segmentId === batchId
                        && current.leaseEpoch === epoch) {
                        const releasedEpoch = this.leases.release(tabId, task0.profileId)
                        await this.persistTabLease(task0.taskId, task0.taskSpaceId, tabId, releasedEpoch)
                    }
                }
            if (this.controllers.get(task0.taskId) === controller)
                this.controllers.delete(task0.taskId)
        }
    }
    private async dispatch(driver: BrowserDriver, step: BatchStep, grant: AgentGrant,
        signal: AbortSignal, expect?: DispatchExpectation): ReturnType<typeof dispatchStep> {
        return dispatchStep(driver, step, grant, signal, expect)
    }
    /**
     * `guard` runs against the current task inside the serialized write; if it throws,
     * nothing is committed and its error is returned as is (leases stay untouched).
     */
    private async commit(task: StoredTask, patch: Partial<StoredTask>, type: TaskEvent['type'], data: Record<string, unknown>,
        leaseEpoch = 0, business = false, guard?: (current: StoredTask) => void): Promise<StoredTask> {
        const previous = this.commitTails.get(task.taskId) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => { release = resolve; })
        const queued = previous.then(() => current)
        this.commitTails.set(task.taskId, queued)
        await previous
        let guardFailure: unknown
        try {
            const committed = await this.options.store.mutate(task.taskId, (current) => {
                try {
                    guard?.(current)
                }
                catch (error) {
                    guardFailure = error
                    return null
                }
                const rebased = rebaseTaskPatch(task, current, patch)
                if (current.cancelRequested && !task.cancelRequested && rebased.status !== 'cancelled') {
                    delete rebased.status
                    delete rebased.pauseReason
                }
                return {
                    patch: rebased,
                    event: this.event(type, redact(data), current.stateVersion + 1, leaseEpoch),
                    business,
                }
            })
            if (guardFailure)
                throw guardFailure
            if (!committed)
                throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Task disappeared during commit')
            for (const wake of this.eventWaiters.get(task.taskId) ?? [])
                wake()
            return committed
        }
        catch (error) {
            if (guardFailure && error === guardFailure)
                throw error
            this.leases.revokeTask(task.taskId)
            this.controllers.get(task.taskId)?.abort(new Error('journal unavailable'))
            throw error
        }
        finally {
            release()
            if (this.commitTails.get(task.taskId) === queued)
                this.commitTails.delete(task.taskId)
        }
    }
    private async saveBatchResult(task: StoredTask, batchId: BatchId, result: BatchResult): Promise<BatchResult> {
        const committed = await this.options.store.mutate(task.taskId, (current) => {
            const batch = current.batches[batchId]
            if (!batch)
                throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Batch record is missing')
            return {
                patch: {
                    lastBatch: result,
                    batches: { ...current.batches, [batchId]: { ...batch, result } },
                    stateVersion: current.stateVersion,
                },
                event: this.event('state-changed', {
                    batchId,
                    batchOutcome: result.outcome,
                    resultStored: true,
                }, current.stateVersion),
            }
        })
        if (!committed)
            throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Batch result was not committed')
        return { ...result, lastCheckpointSeq: committed.highWatermarkSeq }
    }
    private event(type: TaskEvent['type'], data: Record<string, unknown>, stateVersion: number,
        leaseEpoch = 0): StoreEventInput { return { type, atMs: this.clock.now(), stateVersion, leaseEpoch, data }; }
    private authorizeTask(auth: AuthContext, operation: Operation, task: StoredTask): void {
        this.checkCredential(auth, operation, task.profileId, task.taskSpaceId)
        if (task.owner.principalId !== auth.credential.principalId || task.owner.workspaceId !== auth.credential.workspaceId
            || task.owner.machineId !== auth.credential.machineId)
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Task owner does not match credential')
        if (auth.credential.kind === 'agent-grant' && auth.credential.agentSessionId !== task.agentSessionId)
            throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent session does not own task')
    }
    private checkCredential(auth: AuthContext, op: Operation, profileId: ProfileId, taskSpaceId?: TaskSpaceId): void {
        const credential = auth.credential
        assertOperation(auth, op, { principalId: credential.principalId, workspaceId: credential.workspaceId,
            machineId: credential.machineId, profileId, ...(taskSpaceId ? { taskSpaceId } : {}) })
        if (!this.isCredentialLive(auth))
            throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has expired or been revoked')
    }
    private isCredentialLive(auth: AuthContext): boolean {
        const credential = auth.credential
        return credential.expiresAtMs > this.clock.now()
            && !this.options.store.isRevoked(credential.kind === 'agent-grant' ? credential.grantId : credential.capabilityId)
    }
    /** The agent's grant, narrowed to origins that have a site policy: every navigation, redirect and observation is checked against this. */
    private agentGrant(auth: AuthContext): AgentGrant { if (auth.credential.kind !== 'agent-grant')
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent grant required')
    const sited = new Set(this.options.sites.map((site) => site.origin))
    return { ...auth.credential, allowedOrigins: auth.credential.allowedOrigins.filter((origin) => sited.has(origin)) } }
    private driver(profileId: ProfileId): BrowserDriver { const driver = this.drivers.get(profileId); if (!driver)
        throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'No browser driver is configured for profile'); return driver; }
    private requireTask(id: TaskId): StoredTask { const task = this.options.store.getTask(id); if (!task)
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Task does not exist'); return task; }
    private requireSpace(id: TaskSpaceId): NonNullable<ReturnType<TaskStore['getSpace']>> {
        const space = this.options.store.getSpace(id)
        if (!space)
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space does not exist'); return space; }
    /** A closed or reclaiming space takes no new work; the agent creates a new space. */
    private assertSpaceOpen(space: SpaceRecord): void {
        if (space.closed || space.reclaimingSinceMs !== undefined)
            throw new BrowserRuntimeError('CONFLICT', 'Task space was closed; create a new task space')
    }
    private assertTaskTab(task: StoredTask, tab: TabId): void { if (!task.tabs.includes(tab))
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab is not owned by task'); }
    /**
     * Design: submitBatch can start from queued or paused(awaiting-agent).
     * Running/recovering, terminal, cancellation-fenced, and uncertain tasks
     * block. awaiting-user blocks for approval, login, and captcha. Paused
     * reasons user-control, user-input-complete, user-wait-expired,
     * approval-expired, grant-expired, quota, task-time-limit, outcome-unknown,
     * browser-replaced, and cancelled-with-unknown-effect all require their
     * dedicated resolution flow before another batch is accepted.
     */
    private assertCanStart(task: StoredTask): void {
        if (task.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(task.status))
            throw new BrowserRuntimeError('CONFLICT', 'Task cannot accept new work')
        if (task.status === 'running')
            throw new BrowserRuntimeError('CONFLICT', 'Task already owns an execution segment')
        if (task.status === 'paused' && task.pauseReason !== 'awaiting-agent' || task.status === 'awaiting-user'
            || task.uncertainActions.length)
            throw new BrowserRuntimeError('CONFLICT', `Task is paused for a blocking reason (${task.pauseReason ?? task.waitReason ?? task.status})`)
    }
    private allocateTabId(): TabId { return `lease-reservation-${randomUUID()}` as TabId; }
    private view(task: StoredTask): TaskView { const { owner: _owner, agentGrant: _grant, actions: _actions, approvals: _approvals,
        batches: _batches, dedupe: _dedupe, tabTargets: _tabTargets, tabLeaseEpochs: _tabLeaseEpochs,
        __events: _events, lastSeq: _lastSeq, ...view } = task; return structuredClone({ ...view,
        tabLeases: task.tabs.map((tabId) => ({ tabId, ...this.leases.owner(tabId, task.profileId) })) }); }
    private taskRequest(task: StoredTask, auth: AuthContext, requestId: string,
        payload: unknown): unknown | undefined { const key = requestKey(auth, requestId); const old = task.dedupe[key]; if (!old)
        return; if (old.hash !== payloadHash(payload))
        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input'); return old.result; }
    private spaceRequest(space: NonNullable<ReturnType<TaskStore['getSpace']>>, auth: AuthContext, requestId: string,
        payload: unknown): unknown | undefined { const old = space.dedupe?.[requestKey(auth, requestId)]; if (!old)
        return; if (old.hash !== payloadHash(payload))
        throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input'); return old.result; }
    private spaceDedupe(space: NonNullable<ReturnType<TaskStore['getSpace']>>, auth: AuthContext, requestId: string, payload: unknown,
        result: unknown): NonNullable<NonNullable<ReturnType<TaskStore['getSpace']>>['dedupe']> { return { ...space.dedupe,
            [requestKey(auth, requestId)]: { hash: payloadHash(payload), result: redact(result) } }; }
    private async saveTaskRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown,
        result: unknown): Promise<StoredTask> {
        const key = requestKey(auth, requestId)
        const hash = payloadHash(payload)
        const redactedResult = redact(result)
        const committed = await this.options.store.mutate(task.taskId, (current) => {
            const existing = current.dedupe[key]
            if (existing) {
                if (existing.hash !== hash)
                    throw new BrowserRuntimeError('CONFLICT', 'requestId was already used with different input')
                return {
                    patch: { dedupe: { ...current.dedupe, [key]: { hash, result: redactedResult } },
                        stateVersion: current.stateVersion },
                    event: this.event('state-changed', { requestStored: true }, current.stateVersion),
                }
            }
            return {
                patch: {
                    dedupe: { ...current.dedupe, [key]: { hash, result: redactedResult } },
                    stateVersion: current.stateVersion,
                },
                event: this.event('state-changed', { requestStored: true }, current.stateVersion),
            }
        })
        return committed ?? this.requireTask(task.taskId)
    }
    private async saveRequest(task: StoredTask, auth: AuthContext, requestId: string, payload: unknown,
        result: unknown): Promise<StoredTask> { return this.saveTaskRequest(task, auth, requestId, payload, result); }
    private findRequest(requestId: string, auth: AuthContext): {
        hash: string
        result: unknown
    } | undefined {
        const key = requestKey(auth, requestId)
        return this.options.store.listTasks().map((task) => task.dedupe[key]).find(Boolean)
    }
    private authorizeSpace(auth: AuthContext, space: NonNullable<ReturnType<TaskStore['getSpace']>>): void { if (space.owner
        && (space.owner.principalId !== auth.credential.principalId || space.owner.workspaceId !== auth.credential.workspaceId
            || space.owner.machineId !== auth.credential.machineId))
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space owner does not match credential'); }
}
function identity(auth: AuthContext): {
    principalId: string
    workspaceId: string
    machineId: string
} { return { principalId: auth.credential.principalId, workspaceId: auth.credential.workspaceId, machineId: auth.credential.machineId }; }
function rebaseTaskPatch(base: StoredTask, current: StoredTask, patch: Partial<StoredTask>): Partial<StoredTask> {
    const result = { ...patch }
    for (const field of ['actions', 'approvals', 'batches', 'dedupe'] as const) {
        const before = base[field] as Record<string, unknown>
        const proposed = patch[field] as Record<string, unknown> | undefined
        if (!proposed)
            continue
        const merged = { ...current[field] } as Record<string, unknown>
        const keys = new Set([...Object.keys(before), ...Object.keys(proposed)])
        for (const key of keys) {
            if (JSON.stringify(before[key]) === JSON.stringify(proposed[key]))
                continue
            if (!(key in proposed))
                delete merged[key]
            else
                merged[key] = proposed[key]
        }
        Object.assign(result, { [field]: merged })
    }
    return result
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function requestKey(auth: AuthContext, requestId: string): string {
    return `${auth.credential.principalId}/${auth.credential.workspaceId}/${auth.credential.machineId}/${requestId}`
}
function safeError(error: unknown): RuntimeErrorBody {
    const body = error instanceof BrowserRuntimeError ? error.toBody() : {
        code: 'RUNTIME_UNAVAILABLE' as const,
        message: 'Browser operation failed',
        retryable: true,
        mayHaveSideEffects: false,
    }
    return redact(body)
}

/** What the driver must find again right before a click: the classified label, link and submission. */
function dispatchExpectation(description: ElementDescription): DispatchExpectation {
    return {
        role: description.currentRole ?? description.role,
        name: description.currentName ?? description.name,
        ...(description.linkUrl ? { linkUrl: description.linkUrl, linkTarget: description.linkTarget ?? '' } : {}),
        ...(description.form ? { formDigest: description.form.digest } : {}),
    }
}
function persistedBatchSteps(steps: BatchStep[]): BatchStep[] {
    return redact(steps.map((step) => step.kind === 'fill' ? { ...step, value: undefined } : step))
}
function matchesWait(predicate: NonNullable<BatchStep['until']>, observation: Observation): boolean {
    if (predicate.kind === 'text')
        return observation.text.includes(predicate.text)
    if (predicate.kind === 'url')
        return observation.url.startsWith(predicate.urlPrefix)
    return observation.elements.some((element) => element.ref === predicate.ref)
}
function sanitizeObservation(observation: Observation, allowedOrigins: string[]): Observation {
    const hasDeniedFrame = observation.frames.some((frame) => !allowedOrigins.includes(frame.origin))
    return redact({ ...observation, elements: observation.elements.filter((element) => allowedOrigins.includes(element.frameOrigin)),
        frames: observation.frames.map((frame) => ({ ...frame, allowed: allowedOrigins.includes(frame.origin),
            ...(!allowedOrigins.includes(frame.origin) ? { text: undefined } : {}) })), ...(hasDeniedFrame ? { text: '' } : {}) })
}
