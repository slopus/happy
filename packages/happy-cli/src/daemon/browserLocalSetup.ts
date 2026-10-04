import { randomBytes } from 'node:crypto'
import { BrowserBridge, deriveBrowserViewerBridgeToken, type BrowserSetupPolicy } from './browserBridge'

const SCOPE = /^bv1_[A-Za-z0-9_-]{32}$/
const TTL = 5 * 60 * 1000
interface Operation { id: string; profile: string; expires: number; consumed: boolean }
export interface LocalBrowserSetupStatus {
    state: 'idle' | 'waiting' | 'connected' | 'revoked' | 'expired' | 'probe-failed'
    operationId?: string
    profile?: string
    extensionDirectory: string
    extensionId: string
    extensionVersion: string
    optionsUrl?: string
}

/** Trusted daemon service; native config never crosses the public progress DTO. */
export class BrowserLocalSetup {
    private readonly operations = new Map<string, Operation>()
    private serial: Promise<unknown> = Promise.resolve()
    constructor(private readonly options: {
        bridge: BrowserBridge
        readToken(): Promise<string>
        port: number
        extension(): { directory: string; id: string; version: string }
        persistPolicy(policy: BrowserSetupPolicy): Promise<void>
        now?: () => number
    }) {}

    private scope(key: string) { if (!SCOPE.test(key)) throw new Error('INVALID_SCOPE') }
    private now() { return this.options.now?.() ?? Date.now() }
    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const next = this.serial.then(work, work)
        this.serial = next.catch(() => {})
        return next
    }
    private metadata() {
        const extension = this.options.extension()
        return { extensionDirectory: extension.directory, extensionId: extension.id, extensionVersion: extension.version }
    }
    begin(viewerKey: string, profile: string): Promise<LocalBrowserSetupStatus & { operationId: string; optionsUrl: string }> {
        return this.exclusive(async () => {
            this.scope(viewerKey)
            if (!profile.trim() || profile.length > 128 || /[\x00-\x1f]/.test(profile)) throw new Error('INVALID_PROFILE')
            const metadata = this.metadata()
            const operation: Operation = { id: randomBytes(24).toString('base64url'), profile, expires: this.now() + TTL, consumed: false }
            const policy = this.options.bridge.getSetupPolicy()
            policy[viewerKey] = { pairingId: operation.id, profile }
            // Durable write precedes permission grant; a failed write cannot authorize control.
            await this.options.persistPolicy(policy)
            this.options.bridge.setSetupPolicy(policy)
            this.operations.set(viewerKey, operation)
            return { state: 'waiting', operationId: operation.id, profile, ...metadata,
                optionsUrl: `chrome-extension://${metadata.extensionId}/src/options.html?setup=${operation.id}` }
        })
    }
    consume(operationId: string): Promise<{ token: string; port: number; host: string; viewerKey: string; pairingId: string; profile: string }> {
        return this.exclusive(async () => {
            const entry = [...this.operations].find(([, op]) => op.id === operationId)
            if (!entry || entry[1].consumed || entry[1].expires <= this.now()) throw new Error('SETUP_EXPIRED')
            const [viewerKey, op] = entry
            const token = deriveBrowserViewerBridgeToken(await this.options.readToken(), viewerKey)
            op.consumed = true
            return { token, port: this.options.port, host: '127.0.0.1', viewerKey, pairingId: op.id, profile: op.profile }
        })
    }
    async status(viewerKey: string): Promise<LocalBrowserSetupStatus> {
        this.scope(viewerKey)
        const metadata = this.metadata()
        const policy = this.options.bridge.getSetupPolicy()
        const grant = policy[viewerKey]
        if (!grant) return { state: Object.hasOwn(policy, viewerKey) ? 'revoked' : 'idle', ...metadata }
        const base = { operationId: grant.pairingId, profile: grant.profile, ...metadata }
        const connection = this.options.bridge.connections(viewerKey).find(c => c.profile === grant.profile && c.pairingId === grant.pairingId)
        if (!connection) {
            const op = this.operations.get(viewerKey)
            return { state: op && op.expires <= this.now() ? 'expired' : 'waiting', ...base }
        }
        try {
            const result = await this.options.bridge.request('tabs_list', {}, { viewerKey, profile: grant.profile, timeoutMs: 5000 })
            // Account switches/revocation during the probe must not turn stale replies into success.
            const current = this.options.bridge.getSetupPolicy()[viewerKey]
            const stillConnected = this.options.bridge.connections(viewerKey).some(c => c.profile === grant.profile && c.pairingId === grant.pairingId)
            if (!current || current.pairingId !== grant.pairingId || !stillConnected) return { state: 'revoked', ...metadata }
            if (!result || typeof result !== 'object' || !Array.isArray((result as { tabs?: unknown }).tabs)) throw new Error('INVALID_PROBE')
            return { state: 'connected', ...base }
        } catch { return { state: 'probe-failed', ...base } }
    }
    revoke(viewerKey: string): Promise<LocalBrowserSetupStatus> {
        return this.exclusive(async () => {
            this.scope(viewerKey)
            const policy = this.options.bridge.getSetupPolicy()
            policy[viewerKey] = null
            // Immediately deny new/ongoing calls even if durable revocation fails.
            this.options.bridge.setSetupPolicy(policy)
            this.operations.delete(viewerKey)
            await this.options.persistPolicy(policy)
            return { state: 'revoked', ...this.metadata() }
        })
    }
}
