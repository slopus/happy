/**
 * Explicit-target CDP driver (BrowserDriver port) over one raw browser-level
 * WebSocket with flattened sessions.
 *
 * Invariants:
 * - Only tabs this driver created are addressable (TabId → targetId registry).
 *   There is no "active tab" and no fallback of any kind.
 * - Every frame is reached through its own session: the tab's page session for
 *   the main frame and same-process frames, a child session per out-of-process
 *   iframe (Target.setAutoAttach, flatten, recursive).
 * - Page scripts run only in the driver's isolated world.
 * - Refs are bound to {frame, frame stamp, loaderId, backendNodeId, snapshot}.
 *   Anything that no longer matches is STALE_REF; there is no re-matching by
 *   position or label.
 * - Frames whose origin is not allowed contribute no text, refs or pixels.
 * - Destinations are enforced before requests leave the browser: every owned
 *   tab, its frames, its workers and every page it opens (popups, recursively)
 *   start paused and run only after request interception is on. Navigations and
 *   data-carrying requests (Document, XHR, Fetch, Ping, EventSource, CSP reports, Other) to
 *   an origin the tab is not allowed are failed; subresources are not checked.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
    BrowserRuntimeError,
    type BrowserDriver,
    type BrowserInstanceId,
    type DispatchExpectation,
    type DriverOptions,
    type DriverTabHandle,
    type ElementDescription,
    type ElementRef,
    type FormSubmission,
    type Observation,
    type ObservedElement,
    type ObservedFrame,
    type ScreenshotResult,
    type SnapshotId,
    type TabId,
    type WaitPredicate,
} from '../contracts'
import { formDigest } from '../policy'
import { CdpConnection, CdpProtocolError, connectionClosedError } from './cdpConnection'
import { verifySubmissionRequest } from './submissionCheck'
import { CHECK_ELEMENT, CLIMB_FRAMES, COLLECT_FRAME, DESCRIBE_ELEMENT, FRAME_HAS_TEXT, HIT_TEST, IN_THIS_DOCUMENT, LABEL_OF, SELECT_CONTENT, SUBMIT_GUARD, type CollectedFrame, type ElementState } from './pageScripts'

export interface CdpDriverOptions {
    /** Browser-level endpoint from `/json/version` (webSocketDebuggerUrl). */
    browserWsUrl: string
    /** Read from the trusted browser start path; never derived from CDP. */
    browserInstanceIdProvider: () => Promise<BrowserInstanceId>
    /** Owned tabs (= agent windows) this driver keeps open at once; default DEFAULT_MAX_AGENT_WINDOWS. */
    maxAgentWindows?: number
    /** Test seams. Not for production wiring. */
    testHooks?: {
        afterCapture?: (tabId: TabId) => Promise<void>
        /** Simulates a failed cleanup: discardTarget does not send Target.closeTarget while this returns true. */
        discardCloseFails?: () => boolean
        /** Fault injection: make a guard command (Fetch.enable, Target.setAutoAttach) fail for a descendant. depth: popup generation */
        guardFailure?: (kind: GuardedKind, method: string, depth: number) => boolean
        /** Simulates a page guard whose verdicts never arrive. */
        dropGuardReports?: () => boolean
    }
}

/** Descendants of an owned tab whose requests are checked */
export type GuardedKind = 'popup' | 'worker' | 'iframe'

export interface DialogReport {
    tabId: TabId
    type: string
    atMs: number
}

export interface BlockedReport {
    tabId: TabId
    /** Destination origin only: paths and queries may carry data */
    origin: string
    resourceType: string
    atMs: number
}

export interface PopupReport {
    openerTabId: TabId
    targetId: string
    origin: string
    closed: boolean
}

const ISOLATED_WORLD = '__abp_driver__'
const DEFAULT_MAX_ELEMENTS = 200
const DEFAULT_MAX_TEXT_CHARS = 4_000
const WAIT_POLL_MS = 100
const MAX_POPUP_REPORTS = 100
const MAX_CLOSED_TABS = 1_000
const CLOSE_CONFIRM_MS = 2_000
const CONNECT_TIMEOUT_MS = 10_000
const CLOSE_RETRIES = 3
const CLOSE_RETRY_MS = 200
/** How long openTab waits for the auto-attached session of the target it created. */
const CLAIM_MS = 2_000
/** Requests that navigate or can carry data to their destination; checked before they are sent. */
const FETCH_PATTERNS = ['Document', 'XHR', 'Fetch', 'Ping', 'EventSource', 'Other', 'CSPViolationReport']
    .map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Request' }))
/** How long a click's submission guard stays armed. */
const SUBMIT_GUARD_MS = 10_000
/** Once a submission is under way, how long the click waits for the request check's verdict. */
const GUARD_VERDICT_MS = 1_500
const GUARD_BINDING = '__abpGuardReport'
/** After the click, how long to wait for a verdict of a submission the click may have started. */
const GUARD_SETTLE_MS = 300
/** Deeper frame nesting than this is refused rather than walked for overlays. */
const MAX_FRAME_DEPTH = 16
export const DEFAULT_MAX_AGENT_WINDOWS = 4

async function withDeadline<T>(ms: number, message: string, body: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            body(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', message, true, false)), ms)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

/** What DESCRIBE_ELEMENT returns (page-provided; typed here, not trusted beyond this driver). */
interface DescribedElement {
    pageUrl: string
    role: string
    name: string
    tag: string
    linkUrl?: string
    linkTarget?: string
    formAction?: string
    formValues: Record<string, string>
    form?: FormSubmission
    submitsForm?: boolean
}

interface RefBinding {
    frameId: string
    sessionId: string
    stamp: number
    loaderId: string
    backendNodeId: number
    role: string
    name: string
    frameOrigin: string
}

interface TabState {
    tabId: TabId
    targetId: string
    sessionId: string
    /** page session + every attached OOPIF session */
    sessions: Set<string>
    allowedOrigins: string[]
    /** bumps on any frame navigation / attach / detach / child session change */
    generation: number
    /** main-frame navigations stopped by destination enforcement */
    blockedMain: number
    /** A descendant's request interception could not be established: it never ran, and the tab refuses further work */
    unenforced?: boolean
    /** Armed by a click on a form element: document requests of this tab consult it before they are sent */
    submitGuard?: SubmitGuard
    /** frameId → generation value of the last event that touched it */
    stamps: Map<string, number>
    frameKeys: Map<string, string>
    nextFrameKey: number
    mainUrl: string
    snapshot?: { snapshotId: SnapshotId; refs: Map<string, RefBinding> }
    worlds: Map<string, { stamp: number; contextId: number }>
    pendingSetups: Set<Promise<unknown>>
    goneListeners: Set<() => void>
}

interface SubmitGuard {
    sessionId: string
    frameId: string
    expected: FormSubmission
    untilMs: number
    /**
     * armed → submitted (submit event) → submitting (form's formdata matched) → sent (the
     * request matched) | blocked (any mismatch, or the request did not match) | expired
     */
    lastStatus: string
    waiters: Set<() => void>
}

interface SessionInfo {
    tab: TabState
    targetId: string
    isMain: boolean
    /** OOPIF sessions: the session of the document that embeds this frame */
    parentSessionId?: string
}

interface LiveFrame {
    frameId: string
    parentId?: string
    loaderId: string
    url: string
    origin: string
    sessionId: string
    outOfProcess: boolean
}

class OpContext {
    dispatched = false
    aborted = false
    private rejectAborted!: (error: Error) => void
    /** Rejects once the operation was abandoned (timeout/abort/connection loss), so waits inside the body stop too. */
    readonly whenAborted: Promise<never> = new Promise<never>((_resolve, reject) => { this.rejectAborted = reject })

    constructor() {
        this.whenAborted.catch(() => undefined)
    }

    abort(error: Error): void {
        this.aborted = true
        this.rejectAborted(error)
    }

    /** Call immediately before sending anything with a page-visible effect. */
    markDispatch(): void {
        if (this.aborted) throw new BrowserRuntimeError('OUTCOME_UNKNOWN', 'operation aborted before dispatch', false, false)
        this.dispatched = true
    }
}

function staleRef(why: string): BrowserRuntimeError {
    return new BrowserRuntimeError('STALE_REF', `stale ref: ${why}; observe again`, false, false)
}

function originDenied(why: string, retryable = false, mayHaveSideEffects = false): BrowserRuntimeError {
    return new BrowserRuntimeError('ORIGIN_DENIED', why, retryable, mayHaveSideEffects)
}

function unenforced(mayHaveSideEffects: boolean): BrowserRuntimeError {
    return new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'request interception could not be established for a page this tab opened; it was not allowed to run. Close the tab', false, mayHaveSideEffects)
}

function targetGone(): BrowserRuntimeError {
    return new BrowserRuntimeError('TARGET_GONE', 'tab is not owned by this driver or no longer exists', false, false)
}

export function originOf(url: string): string {
    try {
        const origin = new URL(url).origin
        return origin === 'null' ? '' : origin
    } catch {
        return ''
    }
}

function frameOrigin(frame: { url: string; securityOrigin?: string }): string {
    const security = frame.securityOrigin
    if (security && security !== 'null' && security !== '://' && /^[a-z][a-z0-9+.-]*:\/\/./i.test(security)) return security
    return originOf(frame.url)
}

function newId(prefix: string): string {
    return `${prefix}-${randomBytes(9).toString('base64url')}`
}

export class CdpDriver implements BrowserDriver {
    private conn?: CdpConnection
    private instanceId?: BrowserInstanceId
    private browserWsUrl: string
    private readonly tabs = new Map<TabId, TabState>()
    private readonly tabsByTarget = new Map<string, TabState>()
    private readonly sessions = new Map<string, SessionInfo>()
    private readonly closedTabs = new Set<TabId>()
    private readonly popups = new Map<string, PopupReport>()
    private readonly disconnectListeners = new Set<() => void>()
    private readonly dialogs: DialogReport[] = []
    /**
     * Agent page targets that are alive (owned tabs and their popups): a reservation is
     * taken before the target exists (pendingWindows), moves here when it does, and is
     * released only when the browser confirms the target is gone.
     */
    private readonly windows = new Set<string>()
    private pendingWindows = 0
    private readonly destroyedWaiters = new Map<string, Set<() => void>>()
    /** Every session whose requests are checked → the tab whose allowed origins apply */
    private readonly guarded = new Map<string, TabState>()
    /** Popup target → the owned tab it (transitively) came from */
    private readonly popupTabs = new Map<string, TabState>()
    /** Popup page session → its target */
    private readonly popupSessions = new Map<string, string>()
    /** Popup target → generation (1 = opened by the owned tab) */
    private readonly popupDepths = new Map<string, number>()
    /** Pages auto-attached (paused) while openTab is creating one: claimed by targetId, else released */
    private readonly unclaimed = new Map<string, string>()
    private readonly claimWaiters = new Map<string, (sessionId: string) => void>()
    private creating = 0
    /** Targets being attached explicitly (adopt, fallback): their attach event is ours, not a page to release */
    private readonly attaching = new Set<string>()
    private readonly blocked: BlockedReport[] = []

    constructor(private readonly options: CdpDriverOptions) {
        this.browserWsUrl = options.browserWsUrl
    }

    // -----------------------------------------------------------------------
    // Connection lifecycle
    // -----------------------------------------------------------------------

    async connect(): Promise<BrowserInstanceId> {
        const conn = await CdpConnection.connect(this.browserWsUrl)
        this.conn = conn
        this.wire(conn)
        conn.onClose(() => {
            if (this.conn !== conn) return
            this.dropAllTabs()
            this.instanceId = undefined
            for (const listener of [...this.disconnectListeners]) listener()
        })
        const instanceId = await withDeadline(CONNECT_TIMEOUT_MS, 'browser did not answer during connect', async () => {
            await conn.send('Target.setDiscoverTargets', { discover: true })
            // Every new page starts paused and is attached here first, so a popup of an owned
            // tab gets request interception before its first request; other pages are released.
            await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }] })
            return this.options.browserInstanceIdProvider()
        }).catch((error) => {
            conn.close()
            throw error
        })
        // The identity only belongs to this connection if it is still the live one:
        // a close while the provider was answering means it may describe the old browser.
        if (this.conn !== conn || conn.closed) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed during connect', true, false)
        this.instanceId = instanceId
        return instanceId
    }

    /**
     * Explicit reconnect. Old tabs/refs are NOT re-adopted; the caller decides
     * from the returned instance id whether this is the same browser.
     */
    async reconnect(browserWsUrl?: string): Promise<BrowserInstanceId> {
        if (browserWsUrl) this.browserWsUrl = browserWsUrl
        const old = this.conn
        this.conn = undefined
        this.dropAllTabs()
        old?.close()
        this.instanceId = undefined
        return this.connect()
    }

    /** Called once per lost browser connection (not for an explicit close/reconnect). */
    onDisconnect(listener: () => void): () => void {
        this.disconnectListeners.add(listener)
        return () => this.disconnectListeners.delete(listener)
    }

    isConnected(): boolean {
        return this.conn !== undefined && !this.conn.closed && this.instanceId !== undefined
    }

    browserInstanceId(): BrowserInstanceId {
        if (!this.instanceId) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'driver is not connected', true, false)
        return this.instanceId
    }

    async close(): Promise<void> {
        const conn = this.conn
        this.conn = undefined
        this.dropAllTabs()
        conn?.close()
    }

    hasTab(tabId: TabId): boolean {
        return !!this.conn && !this.conn.closed && this.tabs.has(tabId)
    }

    /** For leak checks (A12): owned tabs and attached sessions. */
    debugCounts(): { tabs: number; sessions: number; windows: number } {
        return { tabs: this.tabs.size, sessions: this.sessions.size, windows: this.windows.size + this.pendingWindows }
    }

    /** JavaScript dialogs the driver dismissed on owned tabs (most recent last, bounded). */
    dialogReports(): DialogReport[] {
        return this.dialogs.map((report) => ({ ...report }))
    }

    /** Requests stopped by destination enforcement (most recent last, bounded). */
    blockedReports(): BlockedReport[] {
        return this.blocked.map((report) => ({ ...report }))
    }

    /** Pages opened by owned tabs. They are never adopted as owned tabs. */
    popupReports(): PopupReport[] {
        return [...this.popups.values()].map((report) => ({ ...report }))
    }

    // -----------------------------------------------------------------------
    // Tabs and navigation
    // -----------------------------------------------------------------------

    openTab(url: string, allowedOrigins: string[], opts: DriverOptions): Promise<DriverTabHandle> {
        return this.run(opts, async (op, conn) => {
            if (!allowedOrigins.includes(originOf(url))) throw originDenied('requested origin is not allowed')
            // Every owned tab (and popup) is a window, and windows are what cost browser memory.
            if (!this.windowAvailable()) {
                throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'agent window limit reached; close a page first', true, false)
            }
            {
                op.markDispatch()
                // Each owned tab gets its own background window: in a headful browser a
                // background tab inside the user's window is hidden, so it neither paints
                // (screenshots hang) nor reliably receives input, and activating it would
                // steal the tab the user is looking at. Opening the tab from a driver-owned
                // anchor tab instead (window.open) moves X input focus to that window
                // under the viewer's window-manager-less X server (spike, Chromium 153).
                const { targetId, sessionId } = await this.createOwnedTarget(conn)
                let tab: TabState | undefined
                try {
                    tab = this.registerTab(targetId, sessionId, allowedOrigins)
                    await this.setupSession(conn, sessionId, true)
                    await this.navigateInternal(conn, tab, url, allowedOrigins, op)
                    this.assertEnforced(tab)
                    return { tabId: tab.tabId, targetId }
                } catch (error) {
                    await this.discardTarget(conn, targetId, tab)
                    throw error
                }
            }
        })
    }

    /** Resolves once the browser reports the target destroyed (or after `ms`). */
    private targetDestroyed(targetId: string, ms = CLOSE_CONFIRM_MS): Promise<void> {
        if (!this.windows.has(targetId)) return Promise.resolve()
        return new Promise<void>((resolve) => {
            const waiters = this.destroyedWaiters.get(targetId) ?? new Set()
            this.destroyedWaiters.set(targetId, waiters)
            const done = () => {
                clearTimeout(timer)
                waiters.delete(done)
                resolve()
            }
            const timer = setTimeout(done, ms)
            waiters.add(done)
        })
    }

    private windowAvailable(): boolean {
        return this.windows.size + this.pendingWindows < (this.options.maxAgentWindows ?? DEFAULT_MAX_AGENT_WINDOWS)
    }

    adoptTab(tabId: TabId, targetId: string, allowedOrigins: string[], opts: DriverOptions): Promise<boolean> {
        return this.run(opts, async (_op, conn) => {
            const existing = this.tabs.get(tabId)
            if (existing) return existing.targetId === targetId
            const { targetInfos } = await conn.send('Target.getTargets', {}) as { targetInfos: Array<{ targetId: string; type: string; url: string }> }
            const target = targetInfos.find((info) => info.targetId === targetId && info.type === 'page')
            if (!target) return false
            const sessionId = await this.attachExplicitly(conn, targetId)
            this.windows.add(targetId)
            const tab = this.registerTab(targetId, sessionId, allowedOrigins, tabId)
            tab.mainUrl = target.url
            await this.setupSession(conn, sessionId, true)
            return true
        })
    }

    /**
     * Creates a background window and takes the session auto-attach gave it (paused,
     * so interception is on before anything loads). Falls back to an explicit attach
     * when none arrives: an about:blank target has made no request yet.
     */
    private async createOwnedTarget(conn: CdpConnection): Promise<{ targetId: string; sessionId: string }> {
        this.creating += 1
        this.pendingWindows += 1
        let reserved = true
        try {
            const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true })
            // The reservation moves to the live target in the same tick.
            this.pendingWindows -= 1
            reserved = false
            this.windows.add(targetId)
            const held = this.unclaimed.get(targetId)
            if (held) {
                this.unclaimed.delete(targetId)
                return { targetId, sessionId: held }
            }
            const claimed = await new Promise<string | undefined>((resolve) => {
                const timer = setTimeout(() => {
                    this.claimWaiters.delete(targetId)
                    resolve(undefined)
                }, CLAIM_MS)
                this.claimWaiters.set(targetId, (sessionId) => {
                    clearTimeout(timer)
                    resolve(sessionId)
                })
            })
            if (claimed) return { targetId, sessionId: claimed }
            return { targetId, sessionId: await this.attachExplicitly(conn, targetId) }
        } finally {
            if (reserved) this.pendingWindows -= 1
            this.creating -= 1
            if (this.creating === 0) {
                for (const [targetId, sessionId] of [...this.unclaimed]) {
                    this.unclaimed.delete(targetId)
                    void this.release(conn, sessionId)
                }
            }
        }
    }

    private async attachExplicitly(conn: CdpConnection, targetId: string): Promise<string> {
        this.attaching.add(targetId)
        try {
            const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
            return sessionId
        } finally {
            this.attaching.delete(targetId)
        }
    }

    /** Lets a paused page we do not own run, and stops watching it. */
    private async release(conn: CdpConnection, sessionId: string): Promise<void> {
        await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
        await conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
    }

    /** A command that establishes request interception (fault injection point). */
    private sendGuard(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId: string, kind: GuardedKind, depth = 0): Promise<unknown> {
        if (this.options.testHooks?.guardFailure?.(kind, method, depth)) return Promise.reject(new CdpProtocolError(method, -32000, 'injected failure'))
        return conn.send(method, params, sessionId)
    }

    /**
     * Turns request interception on for a descendant of an owned tab, then lets it run.
     * Fails closed: if interception (pages, frames) or recursive auto-attach cannot be
     * established, the target is never resumed — a popup is closed, a frame or worker
     * stays paused — and the owning tab refuses further work. A dedicated worker has no
     * Fetch domain; its requests pause in its parent's session, which is guarded.
     */
    private async guardSession(conn: CdpConnection, sessionId: string, tab: TabState, kind: GuardedKind, depth = 0, targetId?: string): Promise<boolean> {
        this.guarded.set(sessionId, tab)
        try {
            if (kind !== 'worker') await this.sendGuard(conn, 'Fetch.enable', { patterns: FETCH_PATTERNS }, sessionId, kind, depth)
            await this.sendGuard(conn, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId, kind, depth)
        } catch {
            this.onGuardFailed(conn, tab, kind === 'popup' ? targetId : undefined)
            return false
        }
        await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
        return true
    }

    /** An unguarded descendant is never resumed; a popup is closed (a paused page closes cleanly). */
    private onGuardFailed(conn: CdpConnection, tab: TabState, closeTargetId: string | undefined): void {
        tab.unenforced = true
        if (!closeTargetId) return
        const report = this.popups.get(closeTargetId)
        if (report) report.closed = true
        conn.send('Target.closeTarget', { targetId: closeTargetId }).catch(() => undefined)
    }

    /** After an input or navigation: a descendant it started could not be guarded (it never ran). */
    private assertEnforced(tab: TabState): void {
        if (tab.unenforced) throw unenforced(true)
    }

    /** The owned tab a page came from: the tab itself, one of its frames, or one of its popups. */
    private ownerTabOf(targetId: string): TabState | undefined {
        const direct = this.tabsByTarget.get(targetId) ?? this.popupTabs.get(targetId)
        if (direct) return direct
        for (const info of this.sessions.values()) if (info.targetId === targetId) return info.tab
        return undefined
    }

    /** A page target auto-attached at browser level (always paused when new). */
    private onPageAttached(conn: CdpConnection, sessionId: string, info: any): void {
        if (this.attaching.has(info.targetId)) return
        const waiter = this.claimWaiters.get(info.targetId)
        if (waiter) {
            this.claimWaiters.delete(info.targetId)
            waiter(sessionId)
            return
        }
        const openerTab = info.openerId ? this.ownerTabOf(info.openerId) : undefined
        if (openerTab && !this.tabsByTarget.has(info.targetId)) {
            const depth = (this.popupDepths.get(info.openerId) ?? 0) + 1
            this.popupDepths.set(info.targetId, depth)
            this.popupTabs.set(info.targetId, openerTab)
            this.popupSessions.set(sessionId, info.targetId)
            this.onTargetInfo(conn, info)
            if (!this.windowAvailable()) {
                // Over the window cap. It must still run (a same-site popup shares the opener's
                // renderer, which stays paused with it), but as a closed popup every request of
                // it is failed unsent; then it is closed.
                const report = this.popups.get(info.targetId)
                if (report) report.closed = true
                void this.guardSession(conn, sessionId, openerTab, 'popup', depth, info.targetId)
                    .then(() => conn.send('Target.closeTarget', { targetId: info.targetId }))
                    .catch(() => undefined)
                return
            }
            this.windows.add(info.targetId)
            void this.guardSession(conn, sessionId, openerTab, 'popup', depth, info.targetId)
            return
        }
        if (this.creating > 0 && !this.tabsByTarget.has(info.targetId)) {
            this.unclaimed.set(info.targetId, sessionId)
            return
        }
        void this.release(conn, sessionId)
    }

    private destinationAllowed(url: string, allowedOrigins: string[]): boolean {
        try {
            const parsed = new URL(url)
            return ['http:', 'https:'].includes(parsed.protocol) && allowedOrigins.includes(parsed.origin)
        } catch {
            return false
        }
    }

    /** A request stopped before it was sent: report it; a popup whose document was stopped is closed. */
    private onBlocked(conn: CdpConnection, tab: TabState, sessionId: string, params: any): void {
        this.blocked.push({ tabId: tab.tabId, origin: originOf(params.request.url) || 'opaque', resourceType: String(params.resourceType), atMs: Date.now() })
        if (this.blocked.length > MAX_POPUP_REPORTS) this.blocked.shift()
        if (params.resourceType !== 'Document') return
        if (params.frameId === tab.targetId && this.sessions.get(sessionId)?.isMain) tab.blockedMain += 1
        // A popup's first document request can pause in its own session or its opener's.
        const popupTarget = this.popupTabs.has(params.frameId) ? params.frameId as string : undefined
        if (popupTarget) {
            const report = this.popups.get(popupTarget)
            if (report) {
                report.closed = true
                report.origin = report.origin || originOf(params.request.url)
            }
            conn.send('Target.closeTarget', { targetId: popupTarget }).catch(() => undefined)
        }
    }

    /** Closes a target we created but will not hand out, and waits for it to be gone. */
    private async discardTarget(conn: CdpConnection, targetId: string, tab: TabState | undefined): Promise<void> {
        const gone = tab
            ? new Promise<void>((resolve) => {
                tab.goneListeners.add(resolve)
                setTimeout(resolve, CLOSE_CONFIRM_MS)
            })
            : Promise.resolve()
        if (!this.options.testHooks?.discardCloseFails?.()) await conn.send('Target.closeTarget', { targetId }).catch(() => undefined)
        await gone
        await this.targetDestroyed(targetId)
        if (tab) {
            this.closedTabs.delete(tab.tabId)
            this.forgetTab(tab)
        }
    }

    navigate(tabId: TabId, url: string, allowedOrigins: string[], opts: DriverOptions): Promise<{ url: string; documentGeneration: number }> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            const result = await this.navigateInternal(conn, tab, url, allowedOrigins, op)
            this.assertEnforced(tab)
            return result
        })
    }

    async currentOrigin(tabId: TabId): Promise<string> {
        const conn = this.requireConn()
        const tab = this.requireTab(tabId)
        const { frameTree } = await conn.send('Page.getFrameTree', {}, tab.sessionId).catch((error) => { throw this.mapError(error, false) })
        return frameOrigin(frameTree.frame)
    }

    closeTab(tabId: TabId, opts: DriverOptions): Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }> {
        if (!this.tabs.has(tabId) && this.closedTabs.has(tabId)) return Promise.resolve({ closed: true })
        return this.run(opts, (op, conn) => {
            const tab = this.requireTab(tabId, true)
            return new Promise<{ closed: boolean; beforeUnloadBlocked?: boolean }>((resolve, reject) => {
                const offDialog = conn.on('Page.javascriptDialogOpening', (params, sessionId) => {
                    if (sessionId !== tab.sessionId || params.type !== 'beforeunload') return
                    cleanup()
                    // Never accept on the user's behalf: dismiss = stay on page.
                    conn.send('Page.handleJavaScriptDialog', { accept: false }, tab.sessionId)
                        .catch(() => undefined)
                        .then(() => resolve({ closed: false, beforeUnloadBlocked: true }))
                })
                const onGone = () => {
                    cleanup()
                    // Report closed once the window is really gone (its reservation is released then).
                    void this.targetDestroyed(tab.targetId).then(() => resolve({ closed: true }))
                }
                const cleanup = () => {
                    offDialog()
                    tab.goneListeners.delete(onGone)
                }
                tab.goneListeners.add(onGone)
                op.markDispatch()
                // Page.close can fail transiently while the page is navigating/reloading.
                // Retry a few times (never Target.closeTarget: that would skip beforeunload);
                // a tab that disappears meanwhile resolves through onGone.
                const attemptClose = (attempt: number): void => {
                    conn.send('Page.close', {}, tab.sessionId).catch((error) => {
                        if (!this.tabs.has(tabId)) return
                        if (attempt < CLOSE_RETRIES && error instanceof CdpProtocolError) {
                            setTimeout(() => { if (this.tabs.has(tabId) && !op.aborted) attemptClose(attempt + 1) }, CLOSE_RETRY_MS)
                            return
                        }
                        cleanup()
                        reject(error)
                    })
                }
                attemptClose(1)
            })
        }, true)
    }

    // -----------------------------------------------------------------------
    // Observe
    // -----------------------------------------------------------------------

    observe(
        tabId: TabId,
        allowedOrigins: string[],
        opts: DriverOptions & { maxElements?: number; maxTextChars?: number; scopeRef?: ElementRef },
    ): Promise<Observation> {
        return this.run(opts, async (_op, conn) => {
            const tab = this.requireTab(tabId)
            tab.allowedOrigins = allowedOrigins
            let scope: { binding: RefBinding; objectId: string } | undefined
            if (opts.scopeRef) {
                if (!tab.snapshot) throw staleRef('no snapshot for scopeRef')
                const resolved = await this.resolveRef(conn, tab, opts.scopeRef, tab.snapshot.snapshotId)
                scope = { binding: resolved.binding, objectId: resolved.objectId }
            }
            const documentGeneration = tab.generation
            const frames = await this.collectFrames(conn, tab)
            const main = frames[0]
            if (!main || !allowedOrigins.includes(main.origin)) throw originDenied('top-level origin is not allowed')

            let remainingElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS
            let remainingText = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
            let truncated = false
            let counter = 0
            const snapshotId = newId('snap') as SnapshotId
            const refs = new Map<string, RefBinding>()
            const elements: ObservedElement[] = []
            const observedFrames: ObservedFrame[] = []
            const texts: string[] = []
            let title = ''

            for (const frame of frames) {
                const frameKey = this.frameKey(tab, frame.frameId)
                const allowed = !!frame.origin && allowedOrigins.includes(frame.origin)
                const observed: ObservedFrame = { frameKey, origin: frame.origin, allowed, outOfProcess: frame.outOfProcess }
                observedFrames.push(observed)
                if (!allowed) continue
                if (scope && frame.frameId !== scope.binding.frameId) continue
                const stamp = this.stampOf(tab, frame.frameId)
                let collected: { meta: CollectedFrame; backendNodeIds: number[] }
                try {
                    collected = await this.collectInFrame(conn, tab, frame, stamp, {
                        maxElements: Math.max(0, remainingElements),
                        maxTextChars: Math.max(0, remainingText),
                    }, scope && scope.binding.frameId === frame.frameId ? scope.binding : undefined)
                } catch (error) {
                    if (error instanceof BrowserRuntimeError && error.code === 'STALE_REF') throw error
                    // Frame went away mid-snapshot: report it without content.
                    truncated = true
                    continue
                }
                const { meta, backendNodeIds } = collected
                if (frame === main) title = meta.title
                truncated ||= meta.truncated
                remainingElements -= meta.elements.length
                remainingText -= meta.text.length
                observed.text = meta.text
                if (meta.text) texts.push(meta.text)
                meta.elements.forEach((element, index) => {
                    counter += 1
                    const ref = frame === main ? `@e${counter}` : `@${frameKey}:e${counter}`
                    refs.set(ref, {
                        frameId: frame.frameId,
                        sessionId: frame.sessionId,
                        stamp,
                        loaderId: frame.loaderId,
                        backendNodeId: backendNodeIds[index],
                        role: element.role,
                        name: element.name,
                        frameOrigin: frame.origin,
                    })
                    const observedElement: ObservedElement = {
                        ref: ref as ElementRef,
                        role: element.role,
                        name: element.name,
                        visible: element.visible,
                        frameOrigin: frame.origin,
                    }
                    if (element.value !== undefined) observedElement.value = element.value
                    if (element.disabled) observedElement.disabled = true
                    elements.push(observedElement)
                })
            }
            tab.snapshot = { snapshotId, refs }
            return {
                snapshotId,
                tabId,
                url: main.url,
                title,
                documentGeneration,
                elements,
                frames: observedFrames,
                truncated,
                text: texts.join('\n\n'),
            }
        })
    }

    // -----------------------------------------------------------------------
    // Screenshot
    // -----------------------------------------------------------------------

    screenshot(tabId: TabId, allowedOrigins: string[], opts: DriverOptions): Promise<ScreenshotResult> {
        return this.run(opts, async (_op, conn) => {
            const tab = this.requireTab(tabId)
            tab.allowedOrigins = allowedOrigins
            const before = tab.generation
            const frames = await this.collectFrames(conn, tab)
            for (const frame of frames) {
                if (!frame.origin || !allowedOrigins.includes(frame.origin)) {
                    throw originDenied('page contains a frame whose origin is not allowed or cannot be determined')
                }
            }
            const { data } = await conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, tab.sessionId)
            await this.options.testHooks?.afterCapture?.(tabId)
            const after = await this.collectFrames(conn, tab).catch(() => undefined)
            const unchanged = !!after
                && tab.generation === before
                && after.length === frames.length
                && after.every((frame, i) => frame.frameId === frames[i].frameId && frame.loaderId === frames[i].loaderId && frame.origin === frames[i].origin)
            if (!unchanged) {
                // The image is dropped here; it was never written anywhere.
                throw originDenied('frame tree changed during capture; image discarded', true)
            }
            return {
                tabId,
                mimeType: 'image/png',
                data,
                documentGeneration: before,
                targetId: tab.targetId,
                capturedAtMs: Date.now(),
            }
        })
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    click(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<void> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            const { binding, objectId } = await this.resolveRef(conn, tab, ref, snapshotId)
            const point = await this.prepareInput(conn, tab, binding, objectId, false)
            this.assertFresh(tab, binding, snapshotId)
            // Hover first and re-verify: pages may swap the node on pointermove, and
            // pressing without re-checking would click whatever took its place.
            // A hover is not treated as a write.
            await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, binding.sessionId)
            const settled = await this.prepareInput(conn, tab, binding, objectId, false)
            this.assertFresh(tab, binding, snapshotId)
            if (Math.abs(settled.x - point.x) > 1 || Math.abs(settled.y - point.y) > 1) {
                throw new BrowserRuntimeError('INVALID_REQUEST', 'element moved while the pointer arrived; not interacting', true, false)
            }
            await this.assertSameLabel(conn, binding, objectId)
            // The page ran its hover handlers: what the runtime classified/approved must still hold.
            const live = opts.expect ? await this.assertExpectation(conn, binding, objectId, opts.expect) : undefined
            this.assertFresh(tab, binding, snapshotId)
            if (live?.form) await this.armSubmitGuard(conn, tab, binding, objectId, live.form)
            op.markDispatch()
            const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
            await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, binding.sessionId)
            await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, binding.sessionId)
            // A submission's verdict: the page's (at submit/formdata) and then the request check's.
            const guard = live?.form ? tab.submitGuard : undefined
            if (guard) {
                // Any sign of a submission (a page report, or the request itself), then — if one is
                // under way — the request check's verdict. Page reports may be suppressed or lost.
                await this.submitGuardStatus(guard, GUARD_SETTLE_MS, ['armed'])
                await this.submitGuardStatus(guard, GUARD_VERDICT_MS, ['submitted', 'submitting'])
            }
            if (guard?.lastStatus === 'blocked') {
                throw new BrowserRuntimeError('APPROVAL_EXPIRED', 'the form submission changed after it was classified; it was stopped before it was sent', false, true)
            }
            this.assertEnforced(tab)
        }, true)
    }

    describeRef(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, opts: DriverOptions): Promise<ElementDescription> {
        return this.run(opts, async (_op, conn) => {
            const tab = this.requireTab(tabId)
            const { binding, objectId } = await this.resolveRef(conn, tab, ref, snapshotId)
            const { result } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: DESCRIBE_ELEMENT, objectId, returnByValue: true }, binding.sessionId)
            this.assertFresh(tab, binding, snapshotId)
            const context = result.value as DescribedElement
            return {
                ref,
                role: binding.role,
                name: binding.name,
                frameOrigin: binding.frameOrigin,
                pageUrl: context.pageUrl,
                ...(context.formAction ? { formAction: context.formAction } : {}),
                formValues: context.formValues,
                documentGeneration: documentIdentity(binding.frameId, binding.loaderId),
                identity: encodeIdentity(binding),
                currentRole: context.role,
                currentName: context.name,
                tag: context.tag,
                ...(context.linkUrl ? { linkUrl: context.linkUrl, linkTarget: context.linkTarget ?? '' } : {}),
                ...(context.form ? { form: { ...context.form, digest: formDigest(context.form) }, submitsForm: context.submitsForm === true } : {}),
            }
        })
    }

    restoreRef(tabId: TabId, snapshotId: SnapshotId, ref: ElementRef, identity: string, opts: DriverOptions): Promise<'present' | 'restored' | 'gone'> {
        return this.run(opts, async (_op, conn) => {
            const tab = this.requireTab(tabId)
            if (tab.snapshot?.snapshotId === snapshotId && tab.snapshot.refs.has(ref)) return 'present'
            // Never replace a snapshot the agent took after the restart.
            if (tab.snapshot) return 'gone'
            const stored = decodeIdentity(identity)
            if (!stored) return 'gone'
            for (const sessionId of tab.sessions) {
                const { frameTree } = await conn.send('Page.getFrameTree', {}, sessionId).catch(() => ({ frameTree: undefined }))
                const frame = frameTree ? findFrame(frameTree, stored.frameId) : undefined
                if (!frame) continue
                if (frame.loaderId !== stored.loaderId) return 'gone'
                // Role/name are not persisted (page text); a restored ref describes the node without them.
                const binding: RefBinding = { ...stored, role: '', name: '', sessionId, stamp: this.stampOf(tab, stored.frameId) }
                tab.snapshot = { snapshotId, refs: new Map([[ref, binding]]) }
                // The node itself must still exist in that document.
                try {
                    await this.resolveRef(conn, tab, ref, snapshotId)
                } catch {
                    tab.snapshot = undefined
                    return 'gone'
                }
                return 'restored'
            }
            return 'gone'
        })
    }

    fill(tabId: TabId, ref: ElementRef, snapshotId: SnapshotId, value: string, opts: DriverOptions): Promise<void> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            const { binding, objectId } = await this.resolveRef(conn, tab, ref, snapshotId, true)
            await this.prepareInput(conn, tab, binding, objectId, true)
            this.assertFresh(tab, binding, snapshotId)
            // Focus/select are not writes; verify the target really holds focus (a page may
            // move it on focus) before any text is typed.
            await conn.send('DOM.focus', { backendNodeId: binding.backendNodeId }, binding.sessionId)
            const { result: focus } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: SELECT_CONTENT, objectId, returnByValue: true }, binding.sessionId)
            if (focus.value !== true) throw new BrowserRuntimeError('INVALID_REQUEST', 'focus moved away from the element; not typing', true, false)
            await this.assertSameLabel(conn, binding, objectId)
            this.assertFresh(tab, binding, snapshotId)
            op.markDispatch()
            if (value) {
                await conn.send('Input.insertText', { text: value }, binding.sessionId)
            } else {
                const key = { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }
                await conn.send('Input.dispatchKeyEvent', { ...key, type: 'keyDown' }, binding.sessionId)
                await conn.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }, binding.sessionId)
            }
            this.assertEnforced(tab)
        }, true)
    }

    // -----------------------------------------------------------------------
    // waitFor
    // -----------------------------------------------------------------------

    waitFor(tabId: TabId, predicate: WaitPredicate, allowedOrigins: string[], opts: DriverOptions): Promise<void> {
        return this.run(opts, async (op, conn) => {
            const tab = this.requireTab(tabId)
            while (!op.aborted) {
                if (!this.tabs.has(tabId)) throw targetGone()
                if (await this.predicateHolds(conn, tab, predicate, allowedOrigins)) return
                await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
            }
        })
    }

    private async predicateHolds(conn: CdpConnection, tab: TabState, predicate: WaitPredicate, allowedOrigins: string[]): Promise<boolean> {
        if (predicate.kind === 'url') return tab.mainUrl.startsWith(predicate.urlPrefix)
        if (predicate.kind === 'ref') {
            if (!tab.snapshot) throw staleRef('no snapshot')
            const { state } = await this.resolveRef(conn, tab, predicate.ref, tab.snapshot.snapshotId)
            return state === 'ok'
        }
        const frames = await this.collectFrames(conn, tab)
        for (const frame of frames) {
            if (!frame.origin || !allowedOrigins.includes(frame.origin)) continue
            try {
                const contextId = await this.isolatedContext(conn, tab, frame.sessionId, frame.frameId, this.stampOf(tab, frame.frameId))
                const { result } = await conn.send('Runtime.callFunctionOn', {
                    functionDeclaration: FRAME_HAS_TEXT,
                    executionContextId: contextId,
                    arguments: [{ value: predicate.text }],
                    returnByValue: true,
                }, frame.sessionId)
                if (result?.value === true) return true
            } catch (error) {
                if (error instanceof CdpProtocolError) continue
                throw error
            }
        }
        return false
    }

    // -----------------------------------------------------------------------
    // Internals: operation wrapper
    // -----------------------------------------------------------------------

    /**
     * Runs one driver operation under its deadline, abort signal and the
     * connection lifetime. Rejects immediately on any of them; the body keeps
     * running in the background but `op.markDispatch()` refuses further
     * page-visible effects once aborted.
     */
    private run<T>(opts: DriverOptions, body: (op: OpContext, conn: CdpConnection) => Promise<T>, sideEffecting = false): Promise<T> {
        const op = new OpContext()
        return new Promise<T>((resolve, reject) => {
            let conn: CdpConnection
            try {
                conn = this.requireConn()
            } catch (error) {
                reject(error)
                return
            }
            let settled = false
            const cleanups: Array<() => void> = []
            const settle = (fn: () => void) => {
                if (settled) return
                settled = true
                for (const cleanup of cleanups) cleanup()
                fn()
            }
            const fail = (error: BrowserRuntimeError) => {
                op.abort(error)
                settle(() => reject(error))
            }
            if (opts.signal?.aborted) {
                fail(this.abortError(opts.signal.reason, false))
                return
            }
            const timer = setTimeout(() => {
                fail(new BrowserRuntimeError('OUTCOME_UNKNOWN', `driver operation timed out after ${opts.timeoutMs}ms`, false, op.dispatched))
            }, opts.timeoutMs)
            cleanups.push(() => clearTimeout(timer))
            if (opts.signal) {
                const signal = opts.signal
                const onAbort = () => fail(this.abortError(signal.reason, op.dispatched))
                signal.addEventListener('abort', onAbort, { once: true })
                cleanups.push(() => signal.removeEventListener('abort', onAbort))
            }
            cleanups.push(conn.onClose(() => {
                fail(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed', true, op.dispatched))
            }))
            body(op, conn).then(
                (value) => settle(() => resolve(value)),
                (error) => settle(() => reject(this.mapError(error, sideEffecting && op.dispatched))),
            )
        })
    }

    private abortError(reason: unknown, dispatched: boolean): BrowserRuntimeError {
        if (reason instanceof BrowserRuntimeError) return reason
        return new BrowserRuntimeError('OUTCOME_UNKNOWN', 'driver operation aborted', false, dispatched)
    }

    private mapError(error: unknown, dispatched: boolean): BrowserRuntimeError {
        if (error instanceof BrowserRuntimeError) {
            if (dispatched && !error.mayHaveSideEffects && error.code === 'RUNTIME_UNAVAILABLE') {
                return new BrowserRuntimeError(error.code, error.message, error.retryable, true)
            }
            return error
        }
        if (error instanceof CdpProtocolError) {
            if (/No target with given id|Session with given id not found|Target closed/i.test(error.message)) return targetGone()
            return new BrowserRuntimeError('OUTCOME_UNKNOWN', `browser command failed (${error.method})`, false, dispatched)
        }
        return new BrowserRuntimeError('OUTCOME_UNKNOWN', 'driver internal error', false, dispatched)
    }

    private requireConn(): CdpConnection {
        if (!this.conn || this.conn.closed) throw connectionClosedError()
        return this.conn
    }

    private requireTab(tabId: TabId, allowUnenforced = false): TabState {
        const tab = this.tabs.get(tabId)
        if (!tab) throw targetGone()
        if (tab.unenforced && !allowUnenforced) throw unenforced(false)
        return tab
    }

    // -----------------------------------------------------------------------
    // Internals: registry and events
    // -----------------------------------------------------------------------

    private registerTab(targetId: string, sessionId: string, allowedOrigins: string[], tabId = newId('tab') as TabId): TabState {
        const tab: TabState = {
            tabId,
            targetId,
            sessionId,
            sessions: new Set([sessionId]),
            allowedOrigins,
            generation: 0,
            blockedMain: 0,
            stamps: new Map(),
            frameKeys: new Map([[targetId, 'f0']]),
            nextFrameKey: 1,
            mainUrl: 'about:blank',
            worlds: new Map(),
            pendingSetups: new Set(),
            goneListeners: new Set(),
        }
        this.tabs.set(tab.tabId, tab)
        this.tabsByTarget.set(targetId, tab)
        this.sessions.set(sessionId, { tab, targetId, isMain: true })
        return tab
    }

    /** Removes every trace of a tab. Refs die with it. */
    private forgetTab(tab: TabState): void {
        if (this.tabs.get(tab.tabId) !== tab) return
        this.tabs.delete(tab.tabId)
        this.tabsByTarget.delete(tab.targetId)
        for (const sessionId of tab.sessions) {
            this.sessions.delete(sessionId)
            this.guarded.delete(sessionId)
        }
        tab.sessions.clear()
        tab.snapshot = undefined
        tab.worlds.clear()
        for (const listener of [...tab.goneListeners]) listener()
        tab.goneListeners.clear()
    }

    /** Lets a retried closeTab of an already-closed owned tab return the same result. */
    private rememberClosed(tabId: TabId): void {
        this.closedTabs.add(tabId)
        if (this.closedTabs.size > MAX_CLOSED_TABS) this.closedTabs.delete(this.closedTabs.values().next().value!)
    }

    private dropAllTabs(): void {
        for (const tab of [...this.tabs.values()]) this.forgetTab(tab)
        this.sessions.clear()
        this.guarded.clear()
        this.windows.clear()
        this.popupTabs.clear()
        this.popupSessions.clear()
        this.unclaimed.clear()
    }

    /** Page/frame session of an owned tab: interception first, then (if paused) let it run. */
    private async setupSession(conn: CdpConnection, sessionId: string, isMain: boolean): Promise<void> {
        const tab = this.sessions.get(sessionId)?.tab
        if (tab) this.guarded.set(sessionId, tab)
        // A paused target answers only these before it runs; Page/Emulation wait for the resume.
        const kind: GuardedKind = 'iframe'
        await Promise.all(isMain ? [
            conn.send('Fetch.enable', { patterns: FETCH_PATTERNS }, sessionId),
            conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId),
        ] : [
            this.sendGuard(conn, 'Fetch.enable', { patterns: FETCH_PATTERNS }, sessionId, kind),
            this.sendGuard(conn, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId, kind),
        ])
        await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
        const commands: Array<Promise<unknown>> = [conn.send('Page.enable', {}, sessionId)]
        if (isMain) commands.push(conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId))
        await Promise.all(commands)
    }

    private wire(conn: CdpConnection): void {
        const current = () => this.conn === conn
        conn.on('Target.attachedToTarget', (params, parentSessionId) => {
            if (!current()) return
            const childSessionId: string = params.sessionInfo?.sessionId ?? params.sessionId
            const targetInfo = params.targetInfo
            if (!childSessionId) return
            if (!parentSessionId) {
                this.onPageAttached(conn, childSessionId, targetInfo)
                return
            }
            const parent = this.sessions.get(parentSessionId)
            if (!parent) {
                // A frame or worker of a guarded popup/worker: checked, never addressable.
                const guardTab = this.guarded.get(parentSessionId)
                void (guardTab ? this.guardSession(conn, childSessionId, guardTab, targetInfo.type === 'iframe' ? 'iframe' : 'worker') : this.release(conn, childSessionId))
                return
            }
            if (targetInfo.type !== 'iframe') {
                // Workers are not addressable through this driver, but their requests are checked.
                void this.guardSession(conn, childSessionId, parent.tab, 'worker')
                return
            }
            const tab = parent.tab
            tab.sessions.add(childSessionId)
            this.sessions.set(childSessionId, { tab, targetId: targetInfo.targetId, isMain: false, parentSessionId })
            this.touch(tab, targetInfo.targetId)
            // A frame whose interception fails is never resumed (setupSession stops before that).
            const setup = this.setupSession(conn, childSessionId, false).catch(() => { tab.unenforced = true })
            tab.pendingSetups.add(setup)
            setup.finally(() => tab.pendingSetups.delete(setup))
        })
        conn.on('Target.detachedFromTarget', (params) => {
            if (!current()) return
            this.guarded.delete(params.sessionId)
            this.popupSessions.delete(params.sessionId)
            const info = this.sessions.get(params.sessionId)
            if (!info) return
            if (info.isMain) {
                this.rememberClosed(info.tab.tabId)
                this.forgetTab(info.tab)
                return
            }
            this.sessions.delete(params.sessionId)
            info.tab.sessions.delete(params.sessionId)
            this.touch(info.tab, info.targetId)
        })
        const onTargetEnded = (params: any) => {
            if (!current()) return
            const tab = this.tabsByTarget.get(params.targetId)
            if (tab) {
                this.rememberClosed(tab.tabId)
                this.forgetTab(tab)
            }
            const popup = this.popups.get(params.targetId)
            if (popup) popup.closed = true
            this.popupTabs.delete(params.targetId)
            this.popupDepths.delete(params.targetId)
            this.windows.delete(params.targetId)
            for (const done of [...this.destroyedWaiters.get(params.targetId) ?? []]) done()
            this.destroyedWaiters.delete(params.targetId)
        }
        conn.on('Target.targetDestroyed', onTargetEnded)
        conn.on('Target.targetCrashed', onTargetEnded)
        // A page dialog blocks the renderer: without an answer every later command on
        // the tab hangs. Dismiss it (never accept on the user's behalf — confirm() is
        // false, beforeunload stays on the page) and keep a report.
        conn.on('Page.javascriptDialogOpening', (params, sessionId) => {
            if (!current() || !sessionId) return
            const info = this.sessions.get(sessionId)
            if (!info) return
            this.dialogs.push({ tabId: info.tab.tabId, type: String(params.type), atMs: Date.now() })
            if (this.dialogs.length > MAX_POPUP_REPORTS) this.dialogs.shift()
            conn.send('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => undefined)
        })
        // Destination enforcement: every guarded session's navigations and data-carrying
        // requests pause here; anything not on the tab's allowed origins is failed unsent.
        conn.on('Fetch.requestPaused', (params, sessionId) => {
            if (!current() || !sessionId) return
            const tab = this.guarded.get(sessionId)
            // A popup closed over the cap may still have its first request paused in the opener's session.
            const closedPopup = this.popups.get(params.frameId)?.closed === true
            if (tab && !closedPopup && this.destinationAllowed(params.request.url, tab.allowedOrigins)) {
                let allowed = false
                try {
                    allowed = this.submissionAllowed(tab, params)
                } catch {
                    allowed = false
                }
                if (allowed) {
                    conn.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => undefined)
                    return
                }
                conn.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined)
                this.onBlocked(conn, tab, sessionId, params)
                return
            }
            conn.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined)
            if (tab) this.onBlocked(conn, tab, sessionId, params)
        })
        conn.on('Runtime.bindingCalled', (params, sessionId) => {
            if (!current() || !sessionId || params.name !== GUARD_BINDING) return
            this.onGuardReport(sessionId, String(params.payload))
        })
        conn.on('Target.targetCreated', (params) => current() && this.onTargetInfo(conn, params.targetInfo))
        conn.on('Target.targetInfoChanged', (params) => current() && this.onTargetInfo(conn, params.targetInfo))

        const frameEvent = (frameId: string, sessionId: string | undefined) => {
            const info = sessionId ? this.sessions.get(sessionId) : undefined
            if (info) this.touch(info.tab, frameId)
            return info
        }
        conn.on('Page.frameNavigated', (params, sessionId) => {
            if (!current()) return
            const info = frameEvent(params.frame.id, sessionId)
            if (info?.isMain && !params.frame.parentId) info.tab.mainUrl = params.frame.url
        })
        conn.on('Page.navigatedWithinDocument', (params, sessionId) => {
            if (!current()) return
            const info = sessionId ? this.sessions.get(sessionId) : undefined
            if (info?.isMain && params.frameId === info.tab.targetId) info.tab.mainUrl = params.url
        })
        conn.on('Page.frameAttached', (params, sessionId) => current() && frameEvent(params.frameId, sessionId))
        conn.on('Page.frameDetached', (params, sessionId) => current() && frameEvent(params.frameId, sessionId))
    }

    /** Pages opened by an owned tab: never adopted; closed if their origin is not allowed. */
    private onTargetInfo(conn: CdpConnection, info: any): void {
        if (info.type !== 'page' || !info.openerId || this.tabsByTarget.has(info.targetId)) return
        const opener = this.popupTabs.get(info.targetId) ?? this.ownerTabOf(info.openerId)
        if (!opener) return
        const origin = originOf(info.url)
        const report = this.popups.get(info.targetId) ?? { openerTabId: opener.tabId, targetId: info.targetId, origin, closed: false }
        report.origin = origin || report.origin
        this.popups.set(info.targetId, report)
        if (this.popups.size > MAX_POPUP_REPORTS) this.popups.delete(this.popups.keys().next().value!)
        const pending = !info.url || info.url === 'about:blank'
        if (!pending && !report.closed && !opener.allowedOrigins.includes(origin)) {
            report.closed = true
            conn.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined)
        }
    }

    private touch(tab: TabState, frameId: string): void {
        tab.generation += 1
        tab.stamps.set(frameId, tab.generation)
    }

    private stampOf(tab: TabState, frameId: string): number {
        let stamp = tab.stamps.get(frameId)
        if (stamp === undefined) {
            stamp = tab.generation
            tab.stamps.set(frameId, stamp)
        }
        return stamp
    }

    private frameKey(tab: TabState, frameId: string): string {
        let key = tab.frameKeys.get(frameId)
        if (!key) {
            key = `f${tab.nextFrameKey++}`
            tab.frameKeys.set(frameId, key)
        }
        return key
    }

    // -----------------------------------------------------------------------
    // Internals: navigation
    // -----------------------------------------------------------------------

    private async navigateInternal(
        conn: CdpConnection,
        tab: TabState,
        url: string,
        allowedOrigins: string[],
        op: OpContext,
    ): Promise<{ url: string; documentGeneration: number }> {
        if (!allowedOrigins.includes(originOf(url))) throw originDenied('requested origin is not allowed')
        tab.allowedOrigins = allowedOrigins
        let navigated = false
        let offs: Array<() => void> = []
        const loaded = new Promise<void>((resolve, reject) => {
            offs = [
                conn.on('Page.frameNavigated', (params, sessionId) => {
                    if (sessionId !== tab.sessionId || params.frame.parentId) return
                    navigated = true
                    if (!allowedOrigins.includes(frameOrigin(params.frame))) {
                        conn.send('Page.stopLoading', {}, tab.sessionId).catch(() => undefined)
                        reject(originDenied('navigation ended on an origin that is not allowed', false, true))
                    }
                }),
                conn.on('Page.loadEventFired', (_params, sessionId) => {
                    if (sessionId === tab.sessionId && navigated) resolve()
                }),
            ]
        })
        loaded.catch(() => undefined)
        const blockedBefore = tab.blockedMain
        try {
            op.markDispatch()
            const result = await conn.send('Page.navigate', { url }, tab.sessionId)
            // A redirect hop (the first request went to an allowed origin) was stopped unsent.
            if (tab.blockedMain !== blockedBefore) throw originDenied('navigation was stopped before reaching an origin that is not allowed', false, true)
            if (result.errorText) {
                throw new BrowserRuntimeError('INVALID_REQUEST', `navigation failed: ${result.errorText}`, true, true)
            }
            // A slow page must not keep the body alive after the caller gave up:
            // openTab then discards the half-opened target instead of leaking it.
            if (result.loaderId) await Promise.race([loaded, op.whenAborted])
        } finally {
            for (const off of offs) off()
        }
        const { frameTree } = await conn.send('Page.getFrameTree', {}, tab.sessionId)
        if (!allowedOrigins.includes(frameOrigin(frameTree.frame))) {
            await conn.send('Page.stopLoading', {}, tab.sessionId).catch(() => undefined)
            throw originDenied('navigation ended on an origin that is not allowed', false, true)
        }
        tab.mainUrl = frameTree.frame.url
        return { url: frameTree.frame.url, documentGeneration: tab.generation }
    }

    // -----------------------------------------------------------------------
    // Internals: frames, isolated worlds, refs
    // -----------------------------------------------------------------------

    /** Current frame list, main frame first. OOPIF frames are owned by their child session. */
    private async collectFrames(conn: CdpConnection, tab: TabState): Promise<LiveFrame[]> {
        while (tab.pendingSetups.size) await Promise.all([...tab.pendingSetups])
        const sessionIds = [...tab.sessions]
        const trees = await Promise.all(sessionIds.map(async (sessionId) => {
            const { frameTree } = await conn.send('Page.getFrameTree', {}, sessionId)
            return { sessionId, frameTree }
        }))
        const byId = new Map<string, LiveFrame & { owner: boolean }>()
        const parents = new Map<string, string>()
        const order: string[] = []
        for (const { sessionId, frameTree } of trees) {
            const info = this.sessions.get(sessionId)
            const walk = (node: any) => {
                // An OOPIF's own session may not name its parent; the parent session's tree does.
                for (const child of node.childFrames ?? []) parents.set(child.frame.id, node.frame.id)
                const frame = node.frame
                const owner = frame.id === info?.targetId
                const existing = byId.get(frame.id)
                if (!existing || (owner && !existing.owner)) {
                    if (!existing) order.push(frame.id)
                    byId.set(frame.id, {
                        frameId: frame.id,
                        loaderId: frame.loaderId,
                        url: frame.url,
                        origin: frameOrigin(frame),
                        sessionId,
                        outOfProcess: sessionId !== tab.sessionId,
                        owner,
                    })
                }
                for (const child of node.childFrames ?? []) walk(child)
            }
            walk(frameTree)
        }
        const mainIndex = order.indexOf(tab.targetId)
        if (mainIndex > 0) {
            order.splice(mainIndex, 1)
            order.unshift(tab.targetId)
        }
        return order.map((id) => {
            const { owner: _owner, ...frame } = byId.get(id)!
            const parentId = parents.get(id)
            return parentId ? { ...frame, parentId } : frame
        })
    }

    private async isolatedContext(conn: CdpConnection, tab: TabState, sessionId: string, frameId: string, stamp: number): Promise<number> {
        const key = `${sessionId}|${frameId}`
        const cached = tab.worlds.get(key)
        if (cached && cached.stamp === stamp) return cached.contextId
        const { executionContextId } = await conn.send('Page.createIsolatedWorld', { frameId, worldName: ISOLATED_WORLD, grantUniveralAccess: false }, sessionId)
        tab.worlds.set(key, { stamp, contextId: executionContextId })
        return executionContextId
    }

    private async collectInFrame(
        conn: CdpConnection,
        tab: TabState,
        frame: LiveFrame,
        stamp: number,
        limits: { maxElements: number; maxTextChars: number },
        scope: RefBinding | undefined,
    ): Promise<{ meta: CollectedFrame; backendNodeIds: number[] }> {
        const sessionId = frame.sessionId
        const contextId = await this.isolatedContext(conn, tab, sessionId, frame.frameId, stamp)
        const objectGroup = newId('abp-observe')
        try {
            const args: Array<Record<string, unknown>> = [{ value: limits }]
            if (scope) {
                const { object } = await conn.send('DOM.resolveNode', { backendNodeId: scope.backendNodeId, executionContextId: contextId, objectGroup }, sessionId)
                    .catch(() => { throw staleRef('scope element is gone') })
                args.push({ objectId: object.objectId })
            }
            const evaluated = await conn.send('Runtime.callFunctionOn', {
                functionDeclaration: COLLECT_FRAME,
                executionContextId: contextId,
                arguments: args,
                returnByValue: false,
                objectGroup,
            }, sessionId)
            if (evaluated.exceptionDetails || !evaluated.result?.objectId) throw new CdpProtocolError('collectFrame', 0, 'collector failed')
            const { result: props } = await conn.send('Runtime.getProperties', { objectId: evaluated.result.objectId, ownProperties: true }, sessionId)
            const json = props.find((p: any) => p.name === 'json')?.value?.value
            const nodesId = props.find((p: any) => p.name === 'nodes')?.value?.objectId
            const meta = JSON.parse(json) as CollectedFrame
            const { result: nodeProps } = await conn.send('Runtime.getProperties', { objectId: nodesId, ownProperties: true }, sessionId)
            const indexed = nodeProps
                .filter((p: any) => /^\d+$/.test(p.name) && p.value?.objectId)
                .sort((x: any, y: any) => Number(x.name) - Number(y.name))
            const backendNodeIds = await Promise.all(indexed.map(async (p: any) => {
                const { node } = await conn.send('DOM.describeNode', { objectId: p.value.objectId }, sessionId)
                return node.backendNodeId as number
            }))
            if (backendNodeIds.length !== meta.elements.length) throw new CdpProtocolError('collectFrame', 0, 'node count mismatch')
            return { meta, backendNodeIds }
        } finally {
            conn.send('Runtime.releaseObjectGroup', { objectGroup }, sessionId).catch(() => undefined)
        }
    }

    /** Synchronous checks against the live registry; no browser round-trip. */
    private assertFresh(tab: TabState, binding: RefBinding, snapshotId: SnapshotId): void {
        if (!this.tabs.has(tab.tabId)) throw targetGone()
        if (!tab.snapshot || tab.snapshot.snapshotId !== snapshotId) throw staleRef('snapshot superseded')
        if (!tab.sessions.has(binding.sessionId)) throw staleRef('frame session is gone')
        if (tab.stamps.get(binding.frameId) !== binding.stamp) throw staleRef('frame navigated or detached')
    }

    private async resolveRef(
        conn: CdpConnection,
        tab: TabState,
        ref: ElementRef | string,
        snapshotId: SnapshotId,
        forFill = false,
    ): Promise<{ binding: RefBinding; objectId: string; state: ElementState }> {
        if (!tab.snapshot || tab.snapshot.snapshotId !== snapshotId) throw staleRef('snapshot superseded')
        const binding = tab.snapshot.refs.get(ref)
        if (!binding) throw staleRef('unknown ref')
        this.assertFresh(tab, binding, snapshotId)
        const { frameTree } = await conn.send('Page.getFrameTree', {}, binding.sessionId)
            .catch(() => { throw staleRef('frame session is gone') })
        const frame = findFrame(frameTree, binding.frameId)
        if (!frame || frame.loaderId !== binding.loaderId) throw staleRef('document changed')
        if (!tab.allowedOrigins.includes(frameOrigin(frame))) throw originDenied('frame origin is no longer allowed')
        const contextId = await this.isolatedContext(conn, tab, binding.sessionId, binding.frameId, binding.stamp)
        const resolved = await conn.send('DOM.resolveNode', { backendNodeId: binding.backendNodeId, executionContextId: contextId }, binding.sessionId)
            .catch(() => { throw staleRef('element is gone') })
        const objectId: string = resolved.object.objectId
        const { result } = await conn.send('Runtime.callFunctionOn', {
            functionDeclaration: CHECK_ELEMENT,
            objectId,
            arguments: [{ value: forFill }],
            returnByValue: true,
        }, binding.sessionId)
        const state = result.value as ElementState
        if (state === 'detached') throw staleRef('element was removed from the document')
        this.assertFresh(tab, binding, snapshotId)
        return { binding, objectId, state }
    }

    /** Refuses unusable targets, scrolls into view, hit-tests, returns the dispatch point in the session's viewport. */
    private async prepareInput(conn: CdpConnection, tab: TabState, binding: RefBinding, objectId: string, forFill: boolean): Promise<{ x: number; y: number }> {
        const check = async () => {
            const { result } = await conn.send('Runtime.callFunctionOn', {
                functionDeclaration: CHECK_ELEMENT,
                objectId,
                arguments: [{ value: forFill }],
                returnByValue: true,
            }, binding.sessionId)
            const state = result.value as ElementState
            if (state === 'detached') throw staleRef('element was removed from the document')
            if (state !== 'ok') throw new BrowserRuntimeError('INVALID_REQUEST', `element is ${state}; not interacting`, false, false)
        }
        await check()
        await conn.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: binding.backendNodeId }, binding.sessionId)
        await check()
        const { result: hit } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: HIT_TEST, objectId, returnByValue: true }, binding.sessionId)
        if (hit.value !== true) throw new BrowserRuntimeError('INVALID_REQUEST', 'element is covered by another element; not interacting', true, false)
        await this.assertFrameChainUncovered(conn, tab, binding, objectId)
        const { quads } = await conn.send('DOM.getContentQuads', { backendNodeId: binding.backendNodeId }, binding.sessionId)
        const quad: number[] | undefined = quads?.[0]
        if (!quad) throw new BrowserRuntimeError('INVALID_REQUEST', 'element has no box; not interacting', false, false)
        return {
            x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
            y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
        }
    }

    /**
     * The same node can be relabelled in place ("Continue" becomes "Pay"): the ref
     * still resolves, so compare the role/name with the snapshot's right before
     * input. A restored ref has no snapshot label (not persisted) and is skipped;
     * its approval binds the label instead.
     */
    private async assertSameLabel(conn: CdpConnection, binding: RefBinding, objectId: string): Promise<void> {
        if (!binding.role && !binding.name) return
        const { result } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: LABEL_OF, objectId, returnByValue: true }, binding.sessionId)
        const label = result.value as { role: string; name: string } | undefined
        if (label?.role !== binding.role || label.name !== binding.name) throw staleRef('element label changed since the snapshot')
    }

    /** Re-describes the element and compares it with what the runtime classified/approved. */
    private async assertExpectation(conn: CdpConnection, binding: RefBinding, objectId: string, expected: DispatchExpectation): Promise<DescribedElement> {
        const { result } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: DESCRIBE_ELEMENT, objectId, returnByValue: true }, binding.sessionId)
        const live = result.value as DescribedElement
        const same = live.role === expected.role && live.name === expected.name
            && (live.linkUrl ?? undefined) === expected.linkUrl
            && (live.linkUrl ? (live.linkTarget ?? '') : undefined) === (expected.linkUrl ? (expected.linkTarget ?? '') : undefined)
            && (live.form ? formDigest(live.form) : undefined) === expected.formDigest
        if (!same) throw staleRef('the element or what it would submit changed while the pointer arrived')
        return live
    }

    private async armSubmitGuard(conn: CdpConnection, tab: TabState, binding: RefBinding, objectId: string, expected: FormSubmission): Promise<void> {
        // The guard reports through a binding exposed only in the driver's isolated world. Bindings
        // need the Runtime domain on (only for the guard's lifetime) and must be added after it is,
        // to reach an isolated world that already exists.
        await conn.send('Runtime.enable', {}, binding.sessionId)
        await conn.send('Runtime.addBinding', { name: GUARD_BINDING, executionContextName: ISOLATED_WORLD }, binding.sessionId)
        setTimeout(() => {
            if (tab.submitGuard?.sessionId !== binding.sessionId || Date.now() >= tab.submitGuard.untilMs) conn.send('Runtime.disable', {}, binding.sessionId).catch(() => undefined)
        }, SUBMIT_GUARD_MS + 100)
        const { result } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: SUBMIT_GUARD, objectId,
            arguments: [{ value: expected }, { value: SUBMIT_GUARD_MS }], returnByValue: true }, binding.sessionId)
        if (result.value !== true) throw staleRef('the element is no longer in a form')
        tab.submitGuard = { sessionId: binding.sessionId, frameId: binding.frameId, expected, untilMs: Date.now() + SUBMIT_GUARD_MS, lastStatus: 'armed', waiters: new Set() }
    }

    /**
     * The guard's verdict. It is reported synchronously from the page's submit/formdata
     * handling, so it is known once the click's input has been acknowledged; a request
     * that arrives first waits briefly (the page cannot be queried while its navigation
     * request is paused).
     */
    private async submitGuardStatus(guard: SubmitGuard, waitMs = 0, waitWhile: string[] = ['armed']): Promise<string> {
        const deadline = Date.now() + waitMs
        while (waitWhile.includes(guard.lastStatus) && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer)
                    guard.waiters.delete(done)
                    resolve()
                }
                const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
                guard.waiters.add(done)
            })
        }
        return guard.lastStatus
    }

    private settleGuard(guard: SubmitGuard, status: string): void {
        guard.lastStatus = status
        for (const done of [...guard.waiters]) done()
    }

    private onGuardReport(sessionId: string, status: string): void {
        if (this.options.testHooks?.dropGuardReports?.()) return
        const tab = this.sessions.get(sessionId)?.tab
        const guard = tab?.submitGuard
        // The request check's verdict is final; late page reports cannot undo it.
        if (!guard || guard.sessionId !== sessionId || ['blocked', 'sent'].includes(guard.lastStatus)) return
        this.settleGuard(guard, status)
    }

    /**
     * While a submission guard is armed (after a dispatch on a form element), the
     * submission candidate — the next document request of the form's frame, or of any
     * frame/popup of the tab when the form targets another browsing context — is judged
     * on the request itself: its method, URL with query and body must be exactly the
     * approved submission. The page's own events only ever tighten this (a 'blocked'
     * report rejects); a page that suppresses them, or reports that never arrive,
     * change nothing. Anything else — including a navigation the page substitutes, or a
     * request that cannot be verified — is not sent.
     */
    private submissionAllowed(tab: TabState, params: any): boolean {
        const guard = tab.submitGuard
        if (!guard || params.resourceType !== 'Document' || Date.now() > guard.untilMs) return true
        const selfTarget = ['', '_self'].includes(guard.expected.target)
        if (selfTarget && params.frameId !== guard.frameId) return guard.lastStatus !== 'blocked'
        tab.submitGuard = undefined
        const verdict = guard.lastStatus === 'blocked' ? 'mismatch' : verifySubmissionRequest(guard.expected, params.request)
        this.settleGuard(guard, verdict === 'match' ? 'sent' : 'blocked')
        return verdict === 'match'
    }

    /**
     * HIT_TEST only sees the element's own document. For an element inside an
     * iframe, every ancestor document must hit the iframe element itself at the
     * click point, so an overlay placed by a parent document (same-process or
     * OOPIF) is refused like an in-document one. Same-process ancestors are
     * climbed in the isolated world; at a process boundary the walk continues in
     * the embedding session through DOM.getFrameOwner. Anything that cannot be
     * verified (unknown parent, same-process cross-origin parent, too deep) is refused.
     */
    private async assertFrameChainUncovered(conn: CdpConnection, tab: TabState, binding: RefBinding, objectId: string): Promise<void> {
        if (binding.frameId === tab.targetId) return
        const covered = () => new BrowserRuntimeError('INVALID_REQUEST', 'element\'s frame is covered by a parent document; not interacting', true, false)
        const frames = await this.collectFrames(conn, tab)
        const parentOf = new Map(frames.map((frame) => [frame.frameId, frame.parentId]))
        let sessionId = binding.sessionId
        let frameId = binding.frameId
        let target = objectId
        let incoming: { x: number; y: number } | null = null
        for (let hop = 0; hop < MAX_FRAME_DEPTH; hop++) {
            const { result } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: CLIMB_FRAMES, objectId: target,
                arguments: [{ value: incoming }], returnByValue: true }, sessionId)
            const climb = result.value as { covered?: true; top?: true; unsupported?: true; point?: { x: number; y: number }; levels?: number } | undefined
            if (climb?.unsupported) {
                throw new BrowserRuntimeError('APPROVAL_REQUIRED', 'the element\'s frame is transformed or zoomed; its overlay check cannot be verified, hand this action to the user', false, false)
            }
            if (!climb || climb.covered) throw covered()
            if (climb.top) return
            // The climb stopped where the parent is in another process: that must be this session's root frame.
            let reached: string | undefined = frameId
            for (let level = 0; level < (climb.levels ?? 0) && reached; level++) reached = parentOf.get(reached)
            const info = this.sessions.get(sessionId)
            if (!info || info.isMain || reached !== info.targetId || !info.parentSessionId || !climb.point) throw covered()
            const parentSessionId: string = info.parentSessionId
            const owner = await conn.send('DOM.getFrameOwner', { frameId: info.targetId }, parentSessionId).catch(() => undefined)
            if (!owner?.backendNodeId) throw covered()
            let ownerFrame: { frameId: string; objectId: string } | undefined
            for (const frame of frames.filter((candidate) => candidate.sessionId === parentSessionId)) {
                const contextId = await this.isolatedContext(conn, tab, parentSessionId, frame.frameId, this.stampOf(tab, frame.frameId))
                const resolved = await conn.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: contextId }, parentSessionId).catch(() => undefined)
                if (!resolved?.object?.objectId) continue
                const { result: mine } = await conn.send('Runtime.callFunctionOn', { functionDeclaration: IN_THIS_DOCUMENT,
                    objectId: resolved.object.objectId, returnByValue: true }, parentSessionId)
                if (mine.value === true) {
                    ownerFrame = { frameId: frame.frameId, objectId: resolved.object.objectId }
                    break
                }
            }
            if (!ownerFrame) throw covered()
            sessionId = parentSessionId
            frameId = ownerFrame.frameId
            target = ownerFrame.objectId
            incoming = climb.point
        }
        throw covered()
    }
}

/** Stable number for a frame's current document (changes with its loaderId). */
function documentIdentity(frameId: string, loaderId: string): number {
    return Number.parseInt(createHash('sha256').update(`${frameId}\0${loaderId}`).digest('hex').slice(0, 12), 16)
}

/** Only structural ids: the identity is persisted, so it must not carry page text (names, labels). */
type StoredIdentity = Pick<RefBinding, 'frameId' | 'loaderId' | 'backendNodeId' | 'frameOrigin'>

function encodeIdentity(binding: RefBinding): string {
    const stored: StoredIdentity = { frameId: binding.frameId, loaderId: binding.loaderId, backendNodeId: binding.backendNodeId, frameOrigin: binding.frameOrigin }
    return Buffer.from(JSON.stringify(stored)).toString('base64url')
}

function decodeIdentity(identity: string): StoredIdentity | undefined {
    try {
        const value = JSON.parse(Buffer.from(identity, 'base64url').toString('utf8')) as StoredIdentity
        if (typeof value.frameId !== 'string' || typeof value.loaderId !== 'string' || !Number.isInteger(value.backendNodeId)) return undefined
        return value
    } catch {
        return undefined
    }
}

function findFrame(node: any, frameId: string): any | undefined {
    if (node.frame.id === frameId) return node.frame
    for (const child of node.childFrames ?? []) {
        const found = findFrame(child, frameId)
        if (found) return found
    }
    return undefined
}
