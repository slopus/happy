/**
 * Agent Browser PoC — shared contract v1.
 *
 * Source of truth for the plan: Saydo `specs/agent-browser-poc/contracts.md`.
 * Everything a module boundary exchanges lives here so the Runtime core, the
 * CDP driver, the transport and the agent tools can be built in parallel.
 *
 * Nothing in this file performs I/O.
 */

export const SCHEMA_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Identifiers. Branded so a tabId can never be passed where a taskId is meant.
// ---------------------------------------------------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B }

export type PrincipalId = Brand<string, 'PrincipalId'>
export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type MachineId = Brand<string, 'MachineId'>
export type AgentSessionId = Brand<string, 'AgentSessionId'>
export type ProfileId = Brand<string, 'ProfileId'>
export type TaskSpaceId = Brand<string, 'TaskSpaceId'>
export type TaskId = Brand<string, 'TaskId'>
export type BatchId = Brand<string, 'BatchId'>
export type ActionId = Brand<string, 'ActionId'>
export type StepId = Brand<string, 'StepId'>
export type TabId = Brand<string, 'TabId'>
export type RequestId = Brand<string, 'RequestId'>
export type ApprovalId = Brand<string, 'ApprovalId'>
export type GrantId = Brand<string, 'GrantId'>
export type BrowserInstanceId = Brand<string, 'BrowserInstanceId'>
export type SnapshotId = Brand<string, 'SnapshotId'>
/** Frame-qualified element ref, e.g. `@e3` (main frame) or `@f2:e7`. Opaque to callers. */
export type ElementRef = Brand<string, 'ElementRef'>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
    'UNAUTHORIZED',
    'SCOPE_DENIED',
    'STALE_LEASE',
    'STALE_REF',
    'ORIGIN_DENIED',
    'APPROVAL_REQUIRED',
    'APPROVAL_EXPIRED',
    'CONFLICT',
    'QUOTA_EXCEEDED',
    'TARGET_GONE',
    'RUNTIME_UNAVAILABLE',
    'OUTCOME_UNKNOWN',
    'UNSUPPORTED_OPERATION',
    'JOURNAL_UNAVAILABLE',
    // Not in the original list but needed to report malformed input without
    // overloading CONFLICT. Kept separate so callers can tell "fix the request"
    // from "someone else changed the task".
    'INVALID_REQUEST',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface RuntimeErrorBody {
    code: ErrorCode
    message: string
    retryable: boolean
    mayHaveSideEffects: boolean
}

export class BrowserRuntimeError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        readonly retryable = false,
        readonly mayHaveSideEffects = false,
    ) {
        super(message)
        this.name = 'BrowserRuntimeError'
    }

    toBody(): RuntimeErrorBody {
        return { code: this.code, message: this.message, retryable: this.retryable, mayHaveSideEffects: this.mayHaveSideEffects }
    }
}

// ---------------------------------------------------------------------------
// Authentication context. Produced by the transport from a verified token,
// never from request JSON.
// ---------------------------------------------------------------------------

export type Operation =
    | 'createSpace' | 'createTask' | 'openPage' | 'closePage' | 'observe' | 'screenshot'
    | 'submitBatch' | 'finishTask' | 'getTask' | 'subscribe' | 'approve' | 'takeOver'
    | 'releaseControl' | 'resume' | 'cancel' | 'closeSpace' | 'viewerTicket' | 'listTasks'

/** Operations an agent task grant may carry. approve/takeOver/releaseControl never. */
export const AGENT_OPERATIONS: readonly Operation[] = [
    'createSpace', 'createTask', 'openPage', 'closePage', 'observe', 'screenshot',
    'submitBatch', 'finishTask', 'getTask', 'resume', 'cancel', 'closeSpace',
]
/** Operations that require an interactive (human UI) capability. */
export const INTERACTIVE_OPERATIONS: readonly Operation[] = ['approve', 'takeOver', 'releaseControl', 'viewerTicket']

export interface AgentGrant {
    kind: 'agent-grant'
    grantId: GrantId
    principalId: PrincipalId
    workspaceId: WorkspaceId
    machineId: MachineId
    agentSessionId: AgentSessionId
    profileId: ProfileId
    /** Exact origins, e.g. `http://a.poc-one.test`. No wildcards in the PoC. */
    allowedOrigins: string[]
    operations: Operation[]
    /** Optional narrowing to specific task spaces; empty = any space of the profile. */
    taskSpaceIds: TaskSpaceId[]
    issuedAtMs: number
    expiresAtMs: number
}

export interface InteractiveCapability {
    kind: 'interactive'
    capabilityId: string
    principalId: PrincipalId
    workspaceId: WorkspaceId
    machineId: MachineId
    viewerSessionId: string
    profileId: ProfileId
    operations: Operation[]
    issuedAtMs: number
    expiresAtMs: number
    /** abp2 only: the Happy machineId the capability is for (must equal the Runtime's configured machineId). */
    aud?: string
    /** abp2 only: always INTERACTIVE_CAPABILITY_ISSUER. */
    iss?: string
}

/** `iss` of every server-signed (abp2) interactive capability. */
export const INTERACTIVE_CAPABILITY_ISSUER = 'saycode-server'

/**
 * Runtime auth mode. `harness` keeps the PoC behaviour (abp1 HMAC interactive
 * capabilities minted by the E2E harness). `production` accepts interactive
 * capabilities only as abp2 (Ed25519, signed by the Saycode server).
 */
export type AuthMode = 'harness' | 'production'

/** Client (UI) read access: getTask/subscribe for the principal's tasks. */
export type Credential = AgentGrant | InteractiveCapability

export interface AuthContext {
    credential: Credential
    /** Set by the transport after verifying signature, expiry and revocation. */
    verifiedAtMs: number
}

// ---------------------------------------------------------------------------
// Task / action state
// ---------------------------------------------------------------------------

export type TaskStatus =
    | 'queued'
    | 'running'
    | 'paused'
    | 'awaiting-user'
    | 'recovering'
    | 'succeeded'
    | 'failed'
    | 'cancelled'

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled']

export const PAUSE_REASONS = [
    'awaiting-agent',
    'user-control',
    'user-input-complete',
    'user-wait-expired',
    'approval-expired',
    'grant-expired',
    'quota',
    'task-time-limit',
    'outcome-unknown',
    'browser-replaced',
    'cancelled-with-unknown-effect',
] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

/** handoff: the user performs an action the agent may not (it cannot be bound for approval or verified) */
export type WaitReason = 'approval' | 'login' | 'captcha' | 'handoff'

export type ActionState = 'planned' | 'intent-committed' | 'dispatched' | 'confirmed' | 'uncertain' | 'failed' | 'skipped'

export type StepKind = 'navigate' | 'observe' | 'screenshot' | 'fill' | 'click' | 'waitFor'

/** Condition predicates allowed in waitFor. No functions. */
export type WaitPredicate =
    | { kind: 'text'; text: string }
    | { kind: 'ref'; ref: ElementRef }
    | { kind: 'url'; urlPrefix: string }

export interface BatchStep {
    stepId: StepId
    actionId: ActionId
    tabId: TabId
    kind: StepKind
    timeoutMs: number
    /** navigate */
    url?: string
    /** click/fill target. May be `$name.<label>` to reference a named observe result in the same batch. */
    ref?: ElementRef | string
    /** Snapshot from which ref was obtained; stale refs must fail at the driver. */
    snapshotId?: SnapshotId
    /** fill value — synthetic, non-secret in the PoC */
    value?: string
    /** observe: name so later steps can refer to its refs */
    name?: string
    /** waitFor */
    until?: WaitPredicate
}

export type StepOutcome = 'succeeded' | 'failed' | 'awaiting-user' | 'uncertain' | 'skipped'

export interface StepResult {
    stepId: StepId
    actionId: ActionId
    outcome: StepOutcome
    error?: RuntimeErrorBody
    /** observe/screenshot payload summary; never raw secrets */
    observation?: Observation
    screenshot?: ScreenshotResult
}

export interface BatchResult {
    batchId: BatchId
    taskId: TaskId
    outcome: 'succeeded' | 'failed' | 'awaiting-user' | 'uncertain' | 'cancelled'
    completedSteps: StepId[]
    failedStep?: StepId
    mayHaveSideEffects: boolean
    lastCheckpointSeq: number
    steps: StepResult[]
    /** When outcome = awaiting-user */
    pendingApproval?: PendingApprovalSummary
    waitReason?: WaitReason
}

export interface PendingApprovalSummary {
    approvalId: ApprovalId
    actionId: ActionId
    origin: string
    /** Human-readable, redacted description of what will be sent */
    description: string
    bindingHash: string
    expiresAtMs: number
}

export interface TaskView {
    schemaVersion: typeof SCHEMA_VERSION
    taskId: TaskId
    taskSpaceId: TaskSpaceId
    profileId: ProfileId
    agentSessionId: AgentSessionId
    status: TaskStatus
    pauseReason?: PauseReason
    waitReason?: WaitReason
    cancelRequested: boolean
    stateVersion: number
    highWatermarkSeq: number
    browserInstanceId?: BrowserInstanceId
    tabs: TabId[]
    tabLeases?: Array<{ tabId: TabId; leaseEpoch: number; owner: InputOwner }>
    currentBatchId?: BatchId
    lastBatch?: BatchResult
    pendingApproval?: PendingApprovalSummary
    uncertainActions: ActionId[]
    createdAtMs: number
    updatedAtMs: number
}

export interface TaskEvent {
    schemaVersion: typeof SCHEMA_VERSION
    taskId: TaskId
    seq: number
    type:
        | 'task-created' | 'state-changed' | 'batch-accepted' | 'action-intent' | 'action-dispatched'
        | 'action-confirmed' | 'action-uncertain' | 'action-failed' | 'approval-requested'
        | 'approval-consumed' | 'approval-rejected' | 'input-owner-changed' | 'agent-attention-required'
        | 'cancel-accepted' | 'page-opened' | 'page-closed' | 'recovered' | 'late-result'
    atMs: number
    stateVersion: number
    leaseEpoch: number
    /** Sanitized payload. Never contains cookies, passwords, tokens or raw DOM. */
    data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Observation (driver output)
// ---------------------------------------------------------------------------

export interface ObservedElement {
    ref: ElementRef
    role: string
    name: string
    /** text/value summary, redacted for password fields */
    value?: string
    disabled?: boolean
    visible: boolean
    frameOrigin: string
    /** Optional fixture risk hints; CDP may omit them, so policy also checks name and current page path. */
    targetUrl?: string
    formAction?: string
}

/**
 * A form field value as it would be submitted. Password values are never read
 * out (only their length is bound) and files are bound by name/size/type.
 */
export type FormFieldValue = string | { password: number } | { file: string; size: number; type: string }

/** What activating an element would submit, after submitter overrides (HTML form submission). */
export interface FormSubmission {
    /** Absolute action URL */
    action: string
    method: string
    enctype: string
    target: string
    /** The complete entry list in submission (tree) order; duplicates kept */
    fields: Array<[string, FormFieldValue]>
    /** The activated submit button, or null when the element does not submit the form itself */
    submitter: { name: string; value: string; formaction: string | null; formmethod: string | null; formenctype: string | null } | null
    /**
     * The digest cannot cover everything that would be sent: a form-associated custom
     * element (unreadable value), a non-empty password or a chosen file (content not bound).
     */
    opaque: boolean
}

export interface ElementDescription {
    ref: ElementRef
    role: string
    name: string
    frameOrigin: string
    /** URL of the element's frame document */
    pageUrl: string
    /** Absolute action URL of the enclosing form, if any */
    formAction?: string
    /** Current values of the enclosing form's fields; password fields are omitted */
    formValues: Record<string, string>
    /**
     * Identity of the element's document (derived from frame + loader), stable
     * across Runtime restarts and changed by any navigation/reload of that frame.
     * Unlike Observation.documentGeneration it is not a per-driver counter.
     */
    documentGeneration: number
    /** Opaque, non-secret element identity that restoreRef can re-bind after a Runtime-only restart. */
    identity: string
    /** Role/name computed now; `role`/`name` above are the snapshot's ('' for a restored ref). */
    currentRole?: string
    currentName?: string
    tag?: string
    /** Absolute href when the element is (inside) a link */
    linkUrl?: string
    /** The link's effective browsing-context target (its own, else <base target>, else '') */
    linkTarget?: string
    /** The enclosing form's submission and its SHA-256 digest (policy.formDigest) */
    form?: FormSubmission & { digest: string }
    /** True when activating the element submits `form` (submit button / image input) */
    submitsForm?: boolean
}

export interface ObservedFrame {
    frameKey: string
    origin: string
    allowed: boolean
    /** OOPIF = separate CDP target/session */
    outOfProcess: boolean
    /** only when allowed */
    text?: string
}

export interface Observation {
    snapshotId: SnapshotId
    tabId: TabId
    url: string
    title: string
    documentGeneration: number
    elements: ObservedElement[]
    frames: ObservedFrame[]
    truncated: boolean
    /** Body text context of allowed frames, truncated */
    text: string
}

export interface ScreenshotResult {
    tabId: TabId
    mimeType: 'image/png'
    /** base64; only returned to the caller, never persisted by the Runtime */
    data: string
    documentGeneration: number
    targetId: string
    capturedAtMs: number
}

// ---------------------------------------------------------------------------
// Driver port — implemented by drivers/cdpDriver.ts, faked in unit tests.
// ---------------------------------------------------------------------------

export interface DriverTabHandle {
    tabId: TabId
    /** CDP target id; opaque */
    targetId: string
}

/**
 * The element as the runtime classified (or the user approved) it. The driver
 * re-checks it after pointer preparation and guards the submission the click
 * makes; a mismatch is refused (before input) or stopped (after it).
 */
export interface DispatchExpectation {
    role: string
    name: string
    linkUrl?: string
    linkTarget?: string
    /** formDigest of the submission the element would make */
    formDigest?: string
}

export interface DriverOptions {
    signal?: AbortSignal
    timeoutMs: number
    /** click only */
    expect?: DispatchExpectation
}

export interface BrowserDriver {
    /** Identity of the browser process this driver is connected to. */
    browserInstanceId(): BrowserInstanceId
    openTab(url: string, allowedOrigins: string[], opts: DriverOptions): Promise<DriverTabHandle>
    closeTab(tabId: TabId, opts: DriverOptions): Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }>
    hasTab(tabId: TabId): boolean
    /**
     * Re-take ownership of a tab this Runtime created before it restarted, by the
     * targetId it persisted. Only valid while the browser instance is unchanged
     * (the caller checks browserInstanceId first). Returns false when the target
     * no longer exists. Refs from before the restart stay invalid.
     */
    adoptTab?(tabId: TabId, targetId: string, allowedOrigins: string[], opts: DriverOptions): Promise<boolean>
    /**
     * Describe the element a ref of `snapshotId` points to in the CURRENT document,
     * without taking a new snapshot (so the agent's refs stay valid). Throws
     * STALE_REF exactly like click/fill would. Used for policy classification and
     * approval binding right before dispatch.
     */
    describeRef?(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<ElementDescription>
    /**
     * After a Runtime-only restart (same browser instance, tab re-adopted), re-bind
     * `ref` of `snapshotId` from a persisted ElementDescription.identity, only if
     * the element's document (loader) is unchanged. 'present' = the snapshot is
     * already live, 'restored' = re-bound, 'gone' = document or node changed.
     */
    restoreRef?(tabId: TabId, snapshotId: SnapshotId, ref: ElementRef, identity: string, opts: DriverOptions): Promise<'present' | 'restored' | 'gone'>
    navigate(tabId: TabId, url: string, allowedOrigins: string[], opts: DriverOptions): Promise<{ url: string; documentGeneration: number }>
    observe(tabId: TabId, allowedOrigins: string[], opts: DriverOptions & { maxElements?: number; maxTextChars?: number; scopeRef?: ElementRef }): Promise<Observation>
    screenshot(tabId: TabId, allowedOrigins: string[], opts: DriverOptions): Promise<ScreenshotResult>
    /** Resolve ref against the *current* document; throws STALE_REF if generation/node changed. */
    click(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<void>
    fill(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, value: string, opts: DriverOptions): Promise<void>
    waitFor(tabId: TabId, predicate: WaitPredicate, allowedOrigins: string[], opts: DriverOptions): Promise<void>
    /** Current top-level origin of the tab, for policy checks. */
    currentOrigin(tabId: TabId): Promise<string>
    close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Operation requests (model/client DTOs). Auth is NOT part of these.
// ---------------------------------------------------------------------------

export interface CreateSpaceRequest { profileId: ProfileId; requestId: RequestId }
export interface CreateTaskRequest { taskSpaceId: TaskSpaceId; requestId: RequestId }
export interface OpenPageRequest { taskId: TaskId; url: string; requestId: RequestId }
export interface ClosePageRequest { taskSpaceId: TaskSpaceId; tabId: TabId; requestId: RequestId }
export interface ObserveRequest { taskId: TaskId; tabId: TabId; maxElements?: number; scopeRef?: ElementRef }
export interface ScreenshotRequest { taskId: TaskId; tabId: TabId }
export interface SubmitBatchRequest { taskId: TaskId; expectedVersion: number; requestId: RequestId; steps: BatchStep[] }
export interface FinishTaskRequest { taskId: TaskId; expectedVersion: number; requestId: RequestId }
export interface GetTaskRequest { taskId: TaskId }
/** Interactive: the principal's unfinished tasks on one profile (console task discovery, D12). */
export interface ListTasksRequest { profileId: ProfileId }
export interface ListTasksResult { tasks: TaskView[] }
export interface SubscribeRequest { taskId: TaskId; afterSeq: number }
export interface ApproveRequest { taskId: TaskId; approvalId: ApprovalId; bindingHash: string; requestId: RequestId; decision: 'approve' | 'reject' }
export interface TakeOverRequest { taskId: TaskId; tabId: TabId; expectedEpoch: number; requestId: RequestId }
export interface ReleaseControlRequest { taskId: TaskId; tabId: TabId; expectedEpoch: number; requestId: RequestId }
export interface ResumeRequest { taskId: TaskId; expectedVersion: number; requestId: RequestId }
export interface CancelRequest { taskId: TaskId; requestId: RequestId }
export interface CloseSpaceRequest { taskSpaceId: TaskSpaceId; requestId: RequestId }
/** Served by the viewer proxy (viewerProxy.ts), not by BrowserRuntimeApi. */
export interface ViewerTicketRequest { profileId: ProfileId }
/** One-time WebSocket ticket for `GET /v1/viewer/websockify?ticket=`, bound to the capability and profile. */
export interface ViewerTicket { ticket: string; expiresAtMs: number }

export type SubscribeResult =
    | { kind: 'events'; events: TaskEvent[]; highWatermarkSeq: number }
    | { kind: 'snapshot-required'; snapshot: TaskView; highWatermarkSeq: number }

// ---------------------------------------------------------------------------
// Runtime API — implemented by runtime.ts, served by server.ts, called by the
// agent tools (agentTools.ts) and the client console. Every method validates
// `auth` itself; transports only verify tokens.
// ---------------------------------------------------------------------------

export interface OpenPageResult { tabId: TabId; actionId: ActionId; url: string; task: TaskView }
export interface CancelResult { status: 'cancel-accepted'; task: TaskView; fenceAckMs: number }
export interface ControlResult { leaseEpoch: number; owner: InputOwner; task: TaskView; settling?: boolean }
export interface ApproveResult { outcome: 'approved' | 'rejected'; task: TaskView; batch?: BatchResult }

export type InputOwner =
    | { kind: 'agent'; agentSessionId: AgentSessionId; taskId: TaskId; segmentId: BatchId | ActionId }
    | { kind: 'user'; principalId: PrincipalId; viewerSessionId: string }
    | { kind: 'none' }

export interface BrowserRuntimeApi {
    createSpace(auth: AuthContext, req: CreateSpaceRequest): Promise<{ taskSpaceId: TaskSpaceId }>
    createTask(auth: AuthContext, req: CreateTaskRequest): Promise<TaskView>
    openPage(auth: AuthContext, req: OpenPageRequest): Promise<OpenPageResult>
    closePage(auth: AuthContext, req: ClosePageRequest): Promise<{ closed: boolean; handoff?: 'beforeunload' }>
    observe(auth: AuthContext, req: ObserveRequest): Promise<Observation>
    screenshot(auth: AuthContext, req: ScreenshotRequest): Promise<ScreenshotResult>
    /**
     * Returns once the batch is durably accepted AND has reached a stopping
     * point (paused/awaiting-user/terminal) or `waitMs` elapsed, whichever is
     * first. The batch keeps running server-side regardless of the caller.
     */
    submitBatch(auth: AuthContext, req: SubmitBatchRequest, opts?: { waitMs?: number }): Promise<{ batchId: BatchId; accepted: true; task: TaskView; result?: BatchResult }>
    finishTask(auth: AuthContext, req: FinishTaskRequest): Promise<TaskView>
    getTask(auth: AuthContext, req: GetTaskRequest): Promise<TaskView>
    listTasks(auth: AuthContext, req: ListTasksRequest): Promise<ListTasksResult>
    subscribe(auth: AuthContext, req: SubscribeRequest): Promise<SubscribeResult>
    approve(auth: AuthContext, req: ApproveRequest): Promise<ApproveResult>
    takeOver(auth: AuthContext, req: TakeOverRequest): Promise<ControlResult>
    releaseControl(auth: AuthContext, req: ReleaseControlRequest): Promise<ControlResult>
    resume(auth: AuthContext, req: ResumeRequest): Promise<TaskView>
    cancel(auth: AuthContext, req: CancelRequest): Promise<CancelResult>
    closeSpace(auth: AuthContext, req: CloseSpaceRequest): Promise<{ closedTabs: TabId[] }>
    /** Driver lifecycle notifications from the profile process wrapper. */
    onDriverDisconnected(profileId: ProfileId): Promise<void>
    onDriverReconnected(profileId: ProfileId): Promise<void>
    /** Trusted process-wrapper/admin hooks; these do not accept client identity. */
    revokeGrant(grantId: GrantId): Promise<void>
    sweep(nowMs: number): Promise<void>
    waitForEvents(taskId: TaskId, afterSeq: number, waitMs: number): Promise<SubscribeResult>
}

// ---------------------------------------------------------------------------
// Attention feed (D10): external transitions after which the owning agent
// session must look at its task again. Served on the broker socket to the daemon.
// ---------------------------------------------------------------------------

export const ATTENTION_REASONS = ['approval-approved', 'approval-rejected', 'takeover-released', 'user-resumed', 'recovered'] as const
export type AttentionReason = (typeof ATTENTION_REASONS)[number]

export interface AttentionEvent {
    /** Outbox sequence (persistent, strictly increasing). */
    seq: number
    taskId: TaskId
    agentSessionId: AgentSessionId
    /** Task status right after the transition. */
    status: TaskStatus
    /** Task event seq of the transition; the daemon's message localId is `abp-<taskId>-<eventSeq>`. */
    eventSeq: number
    reason: AttentionReason
}

/**
 * `nextSeq` is the cursor to pass as the next `afterSeq` (the last seq returned).
 * CURSOR_EXPIRED: the cursor is older than the retained window (or ahead of the
 * outbox); `snapshot` holds each task's latest attention entry that no agent
 * batch has followed yet. Delivery stays idempotent through the eventSeq localId.
 */
export type AttentionFeed =
    | { events: AttentionEvent[]; nextSeq: number; oldestSeq: number }
    | { code: 'CURSOR_EXPIRED'; events: []; snapshot: AttentionEvent[]; nextSeq: number; oldestSeq: number }

// ---------------------------------------------------------------------------
// PoC defaults (contracts.md "자원·권한 기본값")
// ---------------------------------------------------------------------------

export const POC_LIMITS = {
    maxSpacesPerProfile: 2,
    maxActiveTabs: 6,
    maxBatchSteps: 50,
    maxStepTimeoutMs: 30_000,
    maxWaitForTimeoutMs: 120_000,
    taskTimeLimitMs: 60 * 60_000,
    maxGrantLifetimeMs: 60 * 60_000,
    /** Server-signed (abp2) interactive capabilities; clients re-issue 1 minute before expiry. */
    maxInteractiveLifetimeMs: 5 * 60_000,
    workerHeartbeatMs: 10_000,
    workerStaleMs: 60_000,
    userWaitMs: 10 * 60_000,
    pausedBrowserRetentionMs: 10 * 60_000,
    fenceAckTargetMs: 2_000,
    journalMaxBytesPerTask: 10 * 1024 * 1024,
    journalMaxEventsPerTask: 10_000,
    /** Records reserved for pause/cancel/audit after the business cap is hit. */
    journalControlReserveEvents: 100,
    terminalBrowserIdleMs: 5 * 60_000,
    eventRetentionMs: 7 * 24 * 60 * 60_000,
} as const

/** Viewer proxy (D2) limits. */
export const VIEWER_LIMITS = {
    ticketTtlMs: 30_000,
    maxOutstandingTickets: 256,
    maxSetEncodings: 64,
    maxClientCutTextBytes: 64 * 1024,
} as const
