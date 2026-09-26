/**
 * Runtime viewer (D2): the Runtime is the RFB endpoint between the human
 * viewer and the browser container's x11vnc. Human input reaches the browser
 * only through here, and only while the viewer's capability owns the profile's
 * takeover lease.
 *
 * Per connection there are two independent RFB sessions: an RFB 3.8 server
 * for the viewer (security None; the one-time ticket authenticated the
 * WebSocket) and an RFB client of x11vnc (VNC authentication with the per-run
 * password, shared). Viewer messages are parsed and re-decided one by one:
 * display messages pass, input passes only under control. Server messages are
 * framed and length-checked by rfb.ts before they reach the viewer.
 *
 * Authorization boundary: the one-time ticket. It is issued only against a
 * live interactive capability (server-signed in production) for its profile,
 * is 256-bit random, valid for 30 s (never past the capability) and spent on
 * first use, and the connection stays bound to that capability (expiry and
 * revocation close it; input also needs its viewer to own the takeover lease).
 * The Origin check is defense in depth only: the Saycode machine tunnel's
 * relay rewrites Origin to a loopback origin, so behind the tunnel it says
 * nothing about the viewer's real page.
 *
 * Input authorization (review P0-1..3): every input message is bound to this
 * viewer's authorization epoch at its first byte, checked again when it is
 * complete and once more right before it is written upstream. Releases are
 * generated from what was actually written. Bytes already written cannot be
 * recalled, so a viewer that loses control after sending input releases what
 * it holds, closes (4002, reconnect with a new ticket) and keeps the profile
 * fenced for agents until x11vnc closes its side: x11vnc processes messages in
 * order and closes only after reading our EOF, so its close proves every
 * earlier byte was consumed. (A FramebufferUpdateRequest round-trip cannot
 * prove this: libvncserver merges requests and may answer an older one.)
 */
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import { extname, join, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { assertOperation } from './auth'
import { BrowserRuntimeError, VIEWER_LIMITS, type AuthContext, type InputOwner, type InteractiveCapability, type ProfileId, type TabId,
    type ViewerTicket, type ViewerTicketRequest } from './contracts'
import { ALLOWED_ENCODINGS, RfbProtocolError, StreamFramer, clientParser, keyEvent, pointerEvent, serverInitMessage, setEncodingsMessage, upstreamParser,
    type ClientMessage, type RfbSession, type ServerInit } from './rfb'

export const VIEWER_WEBSOCKET_PATH = '/v1/viewer/websockify'
const DESKTOP_NAME = 'Agent Browser'
const HANDSHAKE_TIMEOUT_MS = 10_000
const LIVENESS_CHECK_MS = 1_000
const MAX_CONNECTIONS = 16
/** A viewer frame may hold a whole 64 KiB cut text plus headers; nothing larger is ever needed. */
const MAX_WEBSOCKET_MESSAGE_BYTES = 256 * 1024
const MAX_VIEWER_BACKLOG_BYTES = 256 * 1024
const MAX_UPSTREAM_BACKLOG_BYTES = 1024 * 1024
const MAX_UPSTREAM_HEADER_BACKLOG_BYTES = 1024 * 1024
const MAX_HELD_SERVER_BYTES = 4 * 1024 * 1024
const WEBSOCKET_HIGH_WATER_BYTES = 8 * 1024 * 1024
const WEBSOCKET_LOW_WATER_BYTES = 1024 * 1024
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Close codes: protocol violation, upstream failure, capability expired/revoked. */
const CLOSE_POLICY = 1008
const CLOSE_UPSTREAM = 1011
const CLOSE_CAPABILITY = 4001
const CLOSE_CONTROL = 4002
const MAX_HELD_KEYS = 16
const FENCE_WARNING_MS = 10_000

export const VIEWER_ASSET_PREFIX = '/viewer/'
const VIEWER_ASSET_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg',
}
/** noVNC's pages use inline module scripts; everything else, the WebSocket included, is same-origin. */
const VIEWER_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    + "connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'"

/**
 * Serves the pinned noVNC client (the Runtime image copies the Debian novnc
 * package files; no CDN). `/viewer/` is vnc_lite.html. Returns false for
 * anything that is not a known file type inside `root` (symlinks resolved).
 */
export async function serveViewerAsset(root: string, pathname: string, res: ServerResponse): Promise<boolean> {
    let relative: string
    try {
        relative = decodeURIComponent(pathname.slice(VIEWER_ASSET_PREFIX.length)) || 'vnc_lite.html'
    } catch {
        return false
    }
    if (relative.includes('\0') || relative.startsWith('/') || relative.split(/[/\\]/).some((segment) => segment === '..' || segment === '.')) return false
    const type = VIEWER_ASSET_TYPES[extname(relative).toLowerCase()]
    if (!type) return false
    let file: string
    try {
        const base = await realpath(root)
        file = await realpath(join(base, relative))
        if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) return false
    } catch {
        return false
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': VIEWER_CSP })
    res.end(body)
    return true
}

export interface ViewerEndpoint { host: string; port: number }

/** The part of InputLeaseManager the viewer reads. */
export interface ViewerLeaseView {
    userControl(profileId: ProfileId): { tabs: Array<{ tabId: TabId; leaseEpoch: number; owner: Extract<InputOwner, { kind: 'user' }> }>; settling: boolean }
    subscribe(listener: () => void): () => void
    fenceProfile(profileId: ProfileId): () => void
}

export interface ViewerProxyOptions {
    leases: ViewerLeaseView
    /** x11vnc of the profile's browser container, on the profile network. */
    endpoint(profileId: ProfileId): ViewerEndpoint | undefined
    /** Per-run x11vnc password (VNC authentication, at most 8 characters). */
    vncPassword: string
    /** Expiry and revocation, checked again on every input and every second. */
    isCapabilityLive(capability: InteractiveCapability): boolean
    /** Tunnel origins allowed besides loopback origins (defense in depth; the ticket is the boundary). */
    allowedOrigins: readonly string[]
    now?: () => number
    log?: (line: string) => void
    /** Tests only: how to reach the endpoint. */
    connectUpstream?: (endpoint: ViewerEndpoint) => Socket
}

interface TicketEntry { capability: InteractiveCapability; profileId: ProfileId; expiresAtMs: number }

export class ViewerProxy {
    private readonly tickets = new Map<string, TicketEntry>()
    private readonly connections = new Set<ViewerConnection>()
    private readonly webSockets = new WebSocketServer({
        noServer: true, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES, perMessageDeflate: false,
        handleProtocols: (protocols) => protocols.has('binary') ? 'binary' : false,
    })
    private readonly now: () => number

    constructor(private readonly options: ViewerProxyOptions) {
        this.now = options.now ?? Date.now
    }

    /** `GET /v1/viewer/websockify?ticket=` upgrade. The ticket is spent even when the request is refused. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const refuse = (status: number, text: string) => {
            socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        }
        let ticket: string | null
        try {
            ticket = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ticket')
        } catch {
            return refuse(400, 'Bad Request')
        }
        const granted = ticket ? this.consumeTicket(ticket) : undefined
        if (!this.originAllowed(req)) return refuse(403, 'Forbidden')
        if (!granted) return refuse(401, 'Unauthorized')
        const endpoint = this.options.endpoint(granted.profileId)
        if (!endpoint || this.connections.size >= MAX_CONNECTIONS) return refuse(503, 'Service Unavailable')
        this.webSockets.handleUpgrade(req, socket, head, (ws) => {
            const connection = new ViewerConnection(ws, granted.capability, granted.profileId, endpoint, this.options,
                () => this.connections.delete(connection))
            this.connections.add(connection)
        })
    }

    /** Called synchronously by every revocation path, before the revocation is persisted. */
    revokeCapability(capabilityId: string): void {
        for (const connection of [...this.connections]) {
            if (connection.capabilityId === capabilityId) connection.close(CLOSE_CAPABILITY, 'capability revoked')
        }
    }

    async close(): Promise<void> {
        for (const connection of [...this.connections]) connection.close(1001, 'runtime stopping')
        await new Promise<void>((resolve) => this.webSockets.close(() => resolve()))
    }

    /**
     * Defense in depth, not an authorization boundary (the ticket is). Accepts
     * the configured tunnel origins, or any http loopback origin when the
     * Runtime itself is reached on a loopback Host (Desktop's local tunnel picks
     * its port at runtime). It refuses browser pages of other sites that reach
     * the Runtime port directly and DNS-rebound names (non-loopback Host). It
     * cannot tell pages apart behind the Saycode tunnel: the relay rewrites
     * Origin to loopback there, so every relayed viewer passes this check.
     */
    private originAllowed(req: IncomingMessage): boolean {
        const origin = req.headers.origin
        if (!origin) return false
        if (this.options.allowedOrigins.includes(origin)) return true
        const host = req.headers.host
        if (!host) return false
        try {
            const parsedOrigin = new URL(origin)
            return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname)
                && parsedOrigin.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsedOrigin.hostname) && parsedOrigin.origin === origin
        } catch {
            return false
        }
    }

    issueTicket(auth: AuthContext, req: ViewerTicketRequest): ViewerTicket {
        assertOperation(auth, 'viewerTicket', { profileId: req.profileId })
        const capability = auth.credential
        if (capability.kind !== 'interactive') throw new BrowserRuntimeError('SCOPE_DENIED', 'Viewer tickets need an interactive capability')
        if (!this.options.isCapabilityLive(capability)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has expired or been revoked')
        if (!this.options.endpoint(req.profileId)) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'No viewer is configured for profile')
        this.sweepTickets()
        if (this.tickets.size >= VIEWER_LIMITS.maxOutstandingTickets) throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Too many outstanding viewer tickets', true)
        const ticket = randomBytes(32).toString('base64url')
        const expiresAtMs = Math.min(this.now() + VIEWER_LIMITS.ticketTtlMs, capability.expiresAtMs)
        this.tickets.set(ticket, { capability, profileId: req.profileId, expiresAtMs })
        return { ticket, expiresAtMs }
    }

    /** One use only: the ticket is gone whether or not it is still valid. */
    consumeTicket(ticket: string): { capability: InteractiveCapability; profileId: ProfileId } | undefined {
        const entry = this.tickets.get(ticket)
        this.tickets.delete(ticket)
        if (!entry || entry.expiresAtMs <= this.now() || !this.options.isCapabilityLive(entry.capability)) return undefined
        return { capability: entry.capability, profileId: entry.profileId }
    }

    private sweepTickets(): void {
        const now = this.now()
        for (const [ticket, entry] of this.tickets) if (entry.expiresAtMs <= now) this.tickets.delete(ticket)
    }
}

interface UpstreamWrite {
    bytes: Buffer
    /** Input is revalidated against `authEpoch` right before it is written; display messages are not. */
    kind: 'display' | 'input'
    authEpoch: number
}

/** One viewer WebSocket and its own x11vnc session. */
class ViewerConnection {
    readonly capabilityId: string
    private readonly session: RfbSession = { width: 0, height: 0, bytesPerPixel: 0, encodings: new Set() }
    private readonly upstream: Socket
    private readonly upstreamFramer: StreamFramer
    private viewerFramer: StreamFramer | undefined
    private readonly earlyViewerBytes: Buffer[] = []
    private earlyViewerLength = 0
    private viewerReady = false
    private readonly heldForViewer: Buffer[] = []
    private heldForViewerLength = 0
    private upstreamOpen = false
    /** Writes waiting for the upstream to drain. */
    private readonly pendingUpstream: UpstreamWrite[] = []
    private pendingUpstreamLength = 0
    private upstreamPaused = false
    /** Bumped on every change of this viewer's control (gain, loss, new epoch). */
    private authEpoch = 0
    /** The lease (tab@epoch list) this viewer's input is bound to; undefined without control. */
    private boundControl: string | undefined
    /** authEpoch at the current viewer message's type byte. */
    private messageEpoch = -1
    /** Key-downs accepted from the viewer and not yet released: the cap on held keys. */
    private readonly acceptedKeys = new Set<number>()
    /** What x11vnc was actually sent; releases are generated from this, never from queued intent. */
    private readonly dispatchedKeys = new Set<number>()
    private dispatchedButtons = 0
    private dispatchedPointer = { x: 0, y: 0 }
    private inputDispatched = false
    private closing = false
    private releaseFence: (() => void) | undefined
    private readonly timers: NodeJS.Timeout[] = []
    private readonly unsubscribe: () => void
    private readonly log: (line: string) => void

    constructor(private readonly ws: WebSocket, private readonly capability: InteractiveCapability, private readonly profileId: ProfileId,
        endpoint: ViewerEndpoint, private readonly options: ViewerProxyOptions, private readonly onClosed: () => void) {
        this.capabilityId = capability.capabilityId
        this.log = options.log ?? (() => undefined)
        this.upstream = options.connectUpstream?.(endpoint) ?? connectTcp({ host: endpoint.host, port: endpoint.port })
        this.upstream.setNoDelay(true)
        this.upstreamFramer = new StreamFramer(upstreamParser(this.session, {
            password: options.vncPassword,
            send: (bytes) => { this.upstream.write(bytes) },
            onServerInit: (init) => this.onUpstreamReady(init),
        }), (bytes) => this.toViewer(bytes), MAX_UPSTREAM_HEADER_BACKLOG_BYTES)
        this.upstream.on('data', (chunk: Buffer) => this.guard(CLOSE_UPSTREAM, 'browser display protocol error', () => this.upstreamFramer.push(chunk)))
        this.upstream.on('drain', () => this.flushUpstream())
        this.upstream.on('error', () => this.close(CLOSE_UPSTREAM, 'browser display unavailable'))
        this.upstream.on('close', () => this.onUpstreamClosed())
        ws.on('message', (data: Buffer, isBinary: boolean) => this.guard(CLOSE_POLICY, 'protocol error', () => this.fromViewer(data, isBinary)))
        ws.on('close', () => this.close())
        ws.on('error', () => this.close())
        const now = options.now ?? Date.now
        this.timers.push(
            setTimeout(() => { if (!this.viewerReady) this.close(CLOSE_POLICY, 'handshake timeout') }, HANDSHAKE_TIMEOUT_MS),
            setTimeout(() => this.close(CLOSE_CAPABILITY, 'capability expired'), Math.min(Math.max(0, capability.expiresAtMs - now()), 2 ** 31 - 1)),
            setInterval(() => this.refreshControl(), LIVENESS_CHECK_MS),
        )
        this.unsubscribe = options.leases.subscribe(() => this.refreshControl())
    }

    /**
     * Stops the viewer. Queued writes are dropped; keys and buttons x11vnc
     * was sent are released; the upstream gets EOF. If input ever went out,
     * the profile stays fenced until x11vnc closes (it consumed everything).
     */
    close(code = 1000, reason = ''): void {
        if (this.closing) return
        this.closing = true
        for (const timer of this.timers) clearTimeout(timer)
        this.unsubscribe()
        this.pendingUpstream.length = 0
        this.pendingUpstreamLength = 0
        if (this.upstream.writable) {
            if (this.upstreamOpen) {
                for (const keysym of this.dispatchedKeys) this.upstream.write(keyEvent(false, keysym))
                if (this.dispatchedButtons) this.upstream.write(pointerEvent(0, this.dispatchedPointer.x, this.dispatchedPointer.y))
                if (this.inputDispatched) {
                    this.releaseFence = this.options.leases.fenceProfile(this.profileId)
                    const warning = setTimeout(() => this.log(`[viewer] profile=${this.profileId} still fenced: browser display has not closed`), FENCE_WARNING_MS)
                    warning.unref()
                    this.timers.push(warning)
                }
            }
            this.upstream.end()
        }
        // Keep reading (and discarding) so x11vnc's EOF, which lifts the fence, is observed.
        this.upstream.resume()
        // Without a fence nothing depends on x11vnc's close; do not wait long for it.
        if (!this.releaseFence) setTimeout(() => this.upstream.destroy(), 2_000).unref()
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason)
        this.log(`[viewer] profile=${this.profileId} closed code=${code}${reason ? ` reason=${reason}` : ''}${this.releaseFence ? ' fenced-until-display-closes' : ''}`)
        this.onClosed()
    }

    private onUpstreamClosed(): void {
        if (this.releaseFence) {
            for (const timer of this.timers) clearTimeout(timer)
            this.releaseFence()
            this.releaseFence = undefined
            this.log(`[viewer] profile=${this.profileId} browser display closed; fence released`)
        }
        this.close(CLOSE_UPSTREAM, 'browser display unavailable')
    }

    private guard(code: number, reason: string, action: () => void): void {
        if (this.closing) return
        try {
            action()
        } catch (error) {
            // Protocol error messages are ours and carry no payload bytes; anything else is reduced to its name.
            this.log(`[viewer] profile=${this.profileId} ${reason}: ${error instanceof RfbProtocolError ? error.message : error instanceof Error ? error.name : 'unknown'}`)
            this.close(code, reason)
        }
    }

    private fromViewer(data: Buffer, isBinary: boolean): void {
        if (!isBinary) throw new Error('text frame')
        if (this.viewerFramer) return this.viewerFramer.push(data)
        // The viewer may not speak before the Runtime has, but a bounded amount is tolerated.
        this.earlyViewerBytes.push(data)
        this.earlyViewerLength += data.length
        if (this.earlyViewerLength > MAX_VIEWER_BACKLOG_BYTES) throw new Error('viewer backlog')
    }

    private onUpstreamReady(init: ServerInit): void {
        this.upstreamOpen = true
        this.viewerFramer = new StreamFramer(clientParser({
            send: (bytes) => this.sendViewer(bytes),
            serverInit: serverInitMessage(init, DESKTOP_NAME),
            onReady: () => {
                this.viewerReady = true
                for (const bytes of this.heldForViewer.splice(0)) this.sendViewer(bytes)
            },
            onMessageStart: (type) => {
                if (type < 4 || type > 6) return
                this.refreshControl()
                this.messageEpoch = this.authEpoch
            },
            onMessage: (message) => this.onViewerMessage(message),
        }), () => undefined, MAX_VIEWER_BACKLOG_BYTES)
        for (const bytes of this.earlyViewerBytes.splice(0)) this.viewerFramer.push(bytes)
    }

    private onViewerMessage(message: ClientMessage): void {
        switch (message.kind) {
            case 'setPixelFormat':
                this.session.bytesPerPixel = message.bytesPerPixel
                return this.writeUpstream(message.bytes, 'display')
            case 'setEncodings': {
                const encodings = message.encodings.filter((encoding) => ALLOWED_ENCODINGS.has(encoding))
                for (const encoding of encodings) this.session.encodings.add(encoding)
                return this.writeUpstream(setEncodingsMessage(encodings), 'display')
            }
            case 'framebufferUpdateRequest':
                return this.writeUpstream(message.bytes, 'display')
            case 'key':
                if (!this.inputAuthorized()) return
                if (message.down) {
                    // Excess distinct key-downs are dropped: nothing is held for them.
                    if (!this.acceptedKeys.has(message.keysym) && this.acceptedKeys.size >= MAX_HELD_KEYS) return
                    this.acceptedKeys.add(message.keysym)
                } else {
                    this.acceptedKeys.delete(message.keysym)
                }
                return this.writeUpstream(message.bytes, 'input')
            case 'pointer':
            case 'cutText':
                if (!this.inputAuthorized()) return
                return this.writeUpstream(message.bytes, 'input')
        }
    }

    /** The message's authorization is the one at its first byte; it must be unchanged and still current now. */
    private inputAuthorized(): boolean {
        const startEpoch = this.messageEpoch
        this.messageEpoch = -1
        return this.refreshControl() && startEpoch === this.authEpoch
    }

    /**
     * Input is allowed while every user-owned tab of the profile belongs to
     * this capability's viewer, no takeover is settling and the capability is
     * live. Any change bumps the authorization epoch.
     */
    private refreshControl(): boolean {
        if (this.closing) return false
        if (!this.options.isCapabilityLive(this.capability)) {
            this.close(CLOSE_CAPABILITY, 'capability no longer valid')
            return false
        }
        const { tabs, settling } = this.options.leases.userControl(this.profileId)
        const mine = !settling && tabs.length > 0 && tabs.every(({ owner }) =>
            owner.principalId === this.capability.principalId && owner.viewerSessionId === this.capability.viewerSessionId)
        const control = mine ? tabs.map(({ tabId, leaseEpoch }) => `${tabId}@${leaseEpoch}`).sort().join(',') : undefined
        if (control !== this.boundControl) {
            const lost = this.boundControl !== undefined
            this.authEpoch += 1
            this.boundControl = control
            if (lost) this.onControlLost()
        }
        return control !== undefined && !this.closing
    }

    private onControlLost(): void {
        // Input queued under the old authorization never goes out.
        this.acceptedKeys.clear()
        for (let index = this.pendingUpstream.length - 1; index >= 0; index--) {
            if (this.pendingUpstream[index].kind !== 'input') continue
            this.pendingUpstreamLength -= this.pendingUpstream[index].bytes.length
            this.pendingUpstream.splice(index, 1)
        }
        // Input already written may still be on its way to x11vnc: release and prove consumption by closing.
        if (this.inputDispatched) this.close(CLOSE_CONTROL, 'control changed')
    }

    private writeUpstream(bytes: Buffer, kind: UpstreamWrite['kind']): void {
        if (this.closing || !this.upstream.writable) return
        const entry = { bytes, kind, authEpoch: this.authEpoch }
        if (this.pendingUpstream.length === 0 && !this.upstream.writableNeedDrain) return this.dispatch(entry)
        this.pendingUpstream.push(entry)
        this.pendingUpstreamLength += bytes.length
        if (this.pendingUpstreamLength > MAX_UPSTREAM_BACKLOG_BYTES) this.close(CLOSE_UPSTREAM, 'browser display too slow')
    }

    private flushUpstream(): void {
        while (!this.closing && this.pendingUpstream.length && !this.upstream.writableNeedDrain) {
            const entry = this.pendingUpstream.shift()!
            this.pendingUpstreamLength -= entry.bytes.length
            this.dispatch(entry)
        }
    }

    /** The last check before bytes leave the Runtime: input must still hold the authorization it was accepted under. */
    private dispatch(entry: UpstreamWrite): void {
        if (entry.kind === 'input' && !(this.refreshControl() && entry.authEpoch === this.authEpoch)) return
        this.upstream.write(entry.bytes)
        if (entry.kind !== 'input') return
        this.inputDispatched = true
        if (entry.bytes[0] === 4) {
            const keysym = entry.bytes.readUInt32BE(4)
            if (entry.bytes[1]) this.dispatchedKeys.add(keysym)
            else this.dispatchedKeys.delete(keysym)
        } else if (entry.bytes[0] === 5) {
            this.dispatchedButtons = entry.bytes[1]
            this.dispatchedPointer = { x: entry.bytes.readUInt16BE(2), y: entry.bytes.readUInt16BE(4) }
        }
    }

    /** Server messages wait for the viewer's handshake: x11vnc may send cut text or a bell right after ServerInit. */
    private toViewer(bytes: Buffer): void {
        if (this.viewerReady) return this.sendViewer(bytes)
        this.heldForViewer.push(bytes)
        this.heldForViewerLength += bytes.length
        if (this.heldForViewerLength > MAX_HELD_SERVER_BYTES) throw new Error('viewer handshake too slow')
    }

    private sendViewer(bytes: Buffer): void {
        if (this.ws.readyState !== WebSocket.OPEN) return
        this.ws.send(bytes, { binary: true }, () => {
            if (this.upstreamPaused && this.ws.bufferedAmount < WEBSOCKET_LOW_WATER_BYTES) {
                this.upstreamPaused = false
                this.upstream.resume()
            }
        })
        if (!this.upstreamPaused && this.ws.bufferedAmount > WEBSOCKET_HIGH_WATER_BYTES) {
            this.upstreamPaused = true
            this.upstream.pause()
        }
    }
}
