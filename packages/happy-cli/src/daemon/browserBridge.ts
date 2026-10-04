/**
 * Bridge between happy sessions and the Chrome extension controlling the
 * user's logged-in browser (specs/chrome-extension-bridge/).
 *
 * The extension's MV3 service worker connects over a WebSocket — loopback by
 * default, or a remote host when HAPPY_BROWSER_BRIDGE_HOST opts in
 * (browserBridgeServer.ts) — and answers JSON-RPC-style requests:
 *
 *   daemon → extension  { id, method, params }
 *   extension → daemon  { id, result } | { id, error: { code, message } }
 *   extension → daemon  { type: 'ping' }  → daemon replies { type: 'pong' }
 *                       (keepalive — WS traffic keeps the service worker alive)
 *
 * Pure of any specific socket library — the caller hands in a socket with
 * send/close/on, so this stays unit-testable (same pattern as PreviewWsProxy).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface BridgeSocket {
    send(data: string): void
    close(code?: number, reason?: string): void
    on(event: 'message', handler: (data: { toString(): string }) => void): void
    on(event: 'close', handler: () => void): void
}

export interface BridgeConnectionParams {
    token?: string
    profile?: string
    pairingId?: string
    viewerKey?: string
}

export class BridgeRequestError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message)
        this.name = 'BridgeRequestError'
    }
}

interface PendingRequest {
    resolve: (result: unknown) => void
    reject: (error: BridgeRequestError) => void
    timer: NodeJS.Timeout
}

interface Connection {
    profile: string
    pairingId?: string
    viewerKey?: string
    socket: BridgeSocket
    pending: Map<number, PendingRequest>
}

export type BrowserSetupPolicy = Record<string, { pairingId: string; profile: string } | null>

const DEFAULT_PROFILE = 'default'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const AUTH_FAILURE_WINDOW_MS = 60_000
const MAX_AUTH_FAILURE_SCOPES = 256
const VIEWER_ACTIVITY_INTERVAL_MS = 60_000
const LEGACY_VIEWER_SCOPE = 'legacy'
const VIEWER_KEY_RE = /^bv1_[A-Za-z0-9_-]{32}$/

export function deriveBrowserViewerBridgeToken(authToken: string, viewerKey: string): string {
    return createHmac('sha256', authToken)
        .update('browser-viewer-bridge-v1\0')
        .update(viewerKey)
        .digest('base64url')
}

/**
 * Credential for one trusted-setup pairing. Bound to the pairing id so a revoked
 * pairing's token is useless at any daemon: it never equals the plain viewer
 * credential that a home without this pairing's policy would check instead.
 */
export function deriveBrowserSetupPairingToken(authToken: string, viewerKey: string, pairingId: string): string {
    return createHmac('sha256', authToken)
        .update('browser-setup-pairing-v1\0')
        .update(viewerKey)
        .update('\0')
        .update(pairingId)
        .digest('base64url')
}

function connectionKey(viewerKey: string | undefined, profile: string): string {
    return `${viewerKey ?? LEGACY_VIEWER_SCOPE}\0${profile}`
}

function viewerScope(viewerKey: string | undefined): string {
    return viewerKey ?? LEGACY_VIEWER_SCOPE
}

/**
 * Constant-time token comparison.
 *
 * A plain `!==` was fine while the bridge only ever heard from loopback, but
 * HAPPY_BROWSER_BRIDGE_HOST (browserBridgeServer.ts) can now put it on a
 * network an attacker reaches — at which point the token is the only thing
 * standing between them and the user's browser, and a length/prefix-dependent
 * compare timing is a real (if slow) way to recover it.
 *
 * timingSafeEqual throws on a length mismatch rather than returning false, so
 * that has to be handled first — comparing against the expected token's own
 * length keeps that branch's timing independent of the *offered* token's
 * length too.
 */
function tokensMatch(offered: string, expected: string): boolean {
    const offeredBuf = Buffer.from(offered)
    const expectedBuf = Buffer.from(expected)
    if (offeredBuf.length !== expectedBuf.length) {
        // No real timing signal to protect here: this only tells an attacker
        // the token's length, which readOrCreateBrowserBridgeToken fixes at
        // 64 hex chars for every install anyway.
        return false
    }
    return timingSafeEqual(offeredBuf, expectedBuf)
}

export class BrowserBridge {
    private readonly authToken: string
    private readonly requestTimeoutMs: number
    private readonly onViewerActivity?: (viewerKey: string) => void
    private readonly byTarget = new Map<string, Connection>()
    private nextRequestId = 1
    private readonly lastAuthFailureByScope = new Map<string, number>()
    private readonly lastViewerActivityByScope = new Map<string, number>()
    private setupPolicy: BrowserSetupPolicy

    constructor(opts: { authToken: string; requestTimeoutMs?: number; onViewerActivity?: (viewerKey: string) => void; setupPolicy?: BrowserSetupPolicy }) {
        this.authToken = opts.authToken
        this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        this.onViewerActivity = opts.onViewerActivity
        this.setupPolicy = structuredClone(opts.setupPolicy ?? {})
    }

    /**
     * Register an extension connection. Returns false (and closes the socket)
     * when the token doesn't match. A reconnect for the same profile replaces
     * the previous connection — the extension is the source of truth for
     * "the live service worker".
     */
    handleConnection(socket: BridgeSocket, params: BridgeConnectionParams): boolean {
        if (params.viewerKey !== undefined && !VIEWER_KEY_RE.test(params.viewerKey)) {
            socket.close(4401, 'invalid viewer key')
            return false
        }
        const setupScope = Boolean(params.viewerKey && Object.hasOwn(this.setupPolicy, params.viewerKey))
        if (setupScope) {
            const allowed = this.setupPolicy[params.viewerKey!]
            if (!allowed || allowed.pairingId !== params.pairingId || allowed.profile !== params.profile) {
                socket.close(4403, 'browser setup permission revoked or mismatched')
                return false
            }
        }
        const expectedToken = setupScope
            ? deriveBrowserSetupPairingToken(this.authToken, params.viewerKey!, params.pairingId!)
            : params.viewerKey
                ? deriveBrowserViewerBridgeToken(this.authToken, params.viewerKey)
                : this.authToken
        if (!params.token || !tokensMatch(params.token, expectedToken)) {
            this.recordAuthFailure(viewerScope(params.viewerKey))
            socket.close(4401, 'invalid token')
            return false
        }
        this.lastAuthFailureByScope.delete(viewerScope(params.viewerKey))
        const profile = params.profile || DEFAULT_PROFILE
        const key = connectionKey(params.viewerKey, profile)

        const stale = this.byTarget.get(key)
        if (stale) {
            this.byTarget.delete(key)
            this.rejectAllPending(stale, new BridgeRequestError('EXTENSION_DISCONNECTED', 'replaced by a new connection'))
            stale.socket.close(4409, 'replaced by a new connection')
        }

        const connection: Connection = {
            profile,
            ...(params.pairingId ? { pairingId: params.pairingId } : {}),
            ...(params.viewerKey ? { viewerKey: params.viewerKey } : {}),
            socket,
            pending: new Map(),
        }
        this.byTarget.set(key, connection)

        socket.on('message', (data) => this.onMessage(connection, data.toString()))
        socket.on('close', () => {
            if (this.byTarget.get(key) === connection) {
                this.byTarget.delete(key)
            }
            if (
                connection.viewerKey
                && ![...this.byTarget.values()].some(({ viewerKey }) => viewerKey === connection.viewerKey)
            ) {
                this.lastViewerActivityByScope.delete(connection.viewerKey)
            }
            this.rejectAllPending(connection, new BridgeRequestError('EXTENSION_DISCONNECTED', 'extension disconnected'))
        })
        return true
    }

    /** Core-only durable setup grant. Disconnect before admitting a replacement generation. */
    setSetupPolicy(policy: BrowserSetupPolicy): void {
        this.setupPolicy = structuredClone(policy)
        for (const connection of this.byTarget.values()) {
            if (!connection.viewerKey || !Object.hasOwn(policy, connection.viewerKey)) continue
            const allowed = policy[connection.viewerKey]
            if (allowed?.pairingId === connection.pairingId && allowed?.profile === connection.profile) continue
            this.byTarget.delete(connectionKey(connection.viewerKey, connection.profile))
            this.rejectAllPending(connection, new BridgeRequestError('PERMISSION_REVOKED', 'browser control permission revoked'))
            connection.socket.close(4403, 'browser control permission revoked')
        }
    }

    getSetupPolicy(): BrowserSetupPolicy { return structuredClone(this.setupPolicy) }

    /** Connected extensions (introspection / status endpoint). */
    connections(viewerKey?: string): Array<{ profile: string; pairingId?: string; viewerKey?: string }> {
        return Array.from(this.byTarget.values())
            .filter((connection) => connection.viewerKey === viewerKey)
            .map(({ profile, pairingId, viewerKey }) => ({
                profile,
                ...(pairingId ? { pairingId } : {}),
                ...(viewerKey ? { viewerKey } : {}),
            }))
    }

    /**
     * True when a connection attempt was rejected for a bad token recently.
     * A stale token (the daemon's token file was regenerated after an
     * extension paired) retries forever and fails silently otherwise —
     * connections() only reports successes, so nothing else distinguishes
     * this from "no extension has ever tried to connect".
     */
    hasRecentAuthFailure(viewerKey?: string): boolean {
        const scope = viewerScope(viewerKey)
        const failedAt = this.lastAuthFailureByScope.get(scope)
        if (failedAt === undefined) return false
        if (Date.now() - failedAt < AUTH_FAILURE_WINDOW_MS) return true
        this.lastAuthFailureByScope.delete(scope)
        return false
    }

    /**
     * Send a command to the extension and await its response. Targets the
     * given profile, or the only connected one when unspecified.
     *
     * Deliberately refuses to choose when several profiles are connected. The
     * previous behaviour (first-inserted wins) sent every command to whichever
     * Chrome profile happened to pair first — including one with no open
     * windows, which answers `capabilities` happily and then reports zero tabs
     * forever. A named error the caller can act on beats a silent wrong target.
     */
    request(
        method: string,
        params: unknown,
        opts: { timeoutMs?: number; profile?: string; viewerKey?: string } = {},
    ): Promise<unknown> {
        const connections = Array.from(this.byTarget.values())
            .filter((connection) => connection.viewerKey === opts.viewerKey)
        if (!opts.profile && connections.length > 1) {
            const names = connections.map(({ profile }) => profile).join(', ')
            return Promise.reject(new BridgeRequestError(
                'AMBIGUOUS_PROFILE',
                `${connections.length} Chrome profiles are connected (${names}) — pass profile to choose one`
            ))
        }
        const connection = opts.profile
            ? connections.find(({ profile }) => profile === opts.profile)
            : connections[0]
        if (!connection) {
            // Naming what *is* connected turns "nothing is connected" (false,
            // and unactionable, when the caller simply named the wrong
            // profile) into something the caller can correct on its own.
            const connected = connections.map(({ profile }) => profile)
            const detail = opts.profile && connected.length > 0
                ? `no Chrome extension is connected for profile "${opts.profile}" (connected: ${connected.join(', ')})`
                : 'no Chrome extension is connected to the bridge'
            return Promise.reject(new BridgeRequestError('NO_EXTENSION_CONNECTED', detail))
        }

        const id = this.nextRequestId++
        const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs
        if (connection.viewerKey) this.reportViewerActivity(connection.viewerKey)
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                connection.pending.delete(id)
                reject(new BridgeRequestError('TIMEOUT', `extension did not respond within ${timeoutMs}ms`))
            }, timeoutMs)
            connection.pending.set(id, { resolve, reject, timer })
            connection.socket.send(JSON.stringify({ id, method, params }))
        })
    }

    private recordAuthFailure(scope: string): void {
        const now = Date.now()
        this.lastAuthFailureByScope.delete(scope)
        for (const [key, failedAt] of this.lastAuthFailureByScope) {
            if (now - failedAt >= AUTH_FAILURE_WINDOW_MS) this.lastAuthFailureByScope.delete(key)
        }
        while (this.lastAuthFailureByScope.size >= MAX_AUTH_FAILURE_SCOPES) {
            const oldest = this.lastAuthFailureByScope.keys().next().value
            if (oldest === undefined) break
            this.lastAuthFailureByScope.delete(oldest)
        }
        this.lastAuthFailureByScope.set(scope, now)
    }

    private reportViewerActivity(viewerKey: string): void {
        const now = Date.now()
        const lastAt = this.lastViewerActivityByScope.get(viewerKey)
        if (lastAt !== undefined && now - lastAt < VIEWER_ACTIVITY_INTERVAL_MS) return
        this.lastViewerActivityByScope.set(viewerKey, now)
        this.onViewerActivity?.(viewerKey)
    }

    private onMessage(connection: Connection, raw: string): void {
        let message: any
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (message?.type === 'ping') {
            connection.socket.send(JSON.stringify({ type: 'pong' }))
            return
        }
        if (typeof message?.id !== 'number') return
        const pending = connection.pending.get(message.id)
        if (!pending) return
        connection.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) {
            pending.reject(new BridgeRequestError(
                typeof message.error.code === 'string' ? message.error.code : 'EXTENSION_ERROR',
                typeof message.error.message === 'string' ? message.error.message : 'extension reported an error'
            ))
        } else {
            pending.resolve(message.result)
        }
    }

    private rejectAllPending(connection: Connection, error: BridgeRequestError): void {
        for (const pending of connection.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        connection.pending.clear()
    }
}
