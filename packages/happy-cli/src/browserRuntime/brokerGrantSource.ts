/**
 * Happy-side client of the Runtime broker socket (D4).
 *
 * The session process (outside the claude sandbox) obtains its agent grant
 * from the broker with its per-session secret and renews it 5 minutes before
 * expiry; the broker re-checks registration and revocation on every request.
 * The daemon uses `brokerRequest` with its daemon token to register, bind and
 * revoke sessions. Secrets travel only in headers and are never logged.
 */
import { request } from 'node:http'
import { BrowserRuntimeError, type RuntimeErrorBody } from './contracts'

const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
/** A freshly spawned session may ask before the daemon bound its id. */
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000]

export interface BrokerReply { status: number; body: { ok?: boolean; result?: unknown; error?: RuntimeErrorBody } }

export function brokerRequest(socketPath: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown): Promise<BrokerReply> {
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, method, path, timeout: REQUEST_TIMEOUT_MS, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
            let raw = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => { raw += chunk })
            res.on('end', () => {
                try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as BrokerReply['body'] : {} }) } catch { reject(new Error('broker reply is not JSON')) }
            })
        })
        req.on('timeout', () => req.destroy(new Error('broker request timed out')))
        req.on('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
    })
}

export interface BrokerGrantSourceOptions {
    socketPath: string
    sessionSecret: string
    /** Read at request time: the Happy session id the daemon bound the registration to. */
    agentSessionId: () => string
    profileId: string
    now?: () => number
    retryDelaysMs?: readonly number[]
}

/** Returns a token getter for RuntimeClient. */
export function createBrokerGrantSource(options: BrokerGrantSourceOptions): () => Promise<string> {
    const now = options.now ?? Date.now
    const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    let current: { token: string; expiresAtMs: number } | undefined
    let pending: Promise<string> | undefined

    const fetchGrant = async (): Promise<string> => {
        for (let attempt = 0; ; attempt++) {
            let reply: BrokerReply | undefined
            try {
                reply = await brokerRequest(options.socketPath, 'POST', '/v1/agent-grants', { 'x-abp-session-secret': options.sessionSecret },
                    { schemaVersion: 1, agentSessionId: options.agentSessionId(), profileId: options.profileId })
            } catch {
                reply = undefined
            }
            const result = reply?.body.result as { token?: unknown; expiresAtMs?: unknown } | undefined
            if (reply?.status === 200 && typeof result?.token === 'string' && typeof result.expiresAtMs === 'number') {
                current = { token: result.token, expiresAtMs: result.expiresAtMs }
                return result.token
            }
            // Retry only what can resolve by itself: an unreachable broker or a not-yet-bound session.
            const retryable = !reply || reply.body.error?.retryable === true
            if (!retryable || attempt >= delays.length) {
                throw new BrowserRuntimeError('UNAUTHORIZED', `browser task grant is unavailable (${reply?.body.error?.code ?? 'broker unreachable'})`)
            }
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
        }
    }

    return async () => {
        if (current && now() < current.expiresAtMs - RENEW_BEFORE_EXPIRY_MS) return current.token
        pending ??= fetchGrant().catch((error: unknown) => {
            // A broker hiccup during renewal keeps the still-valid grant; a refusal (revoked) never does.
            const refused = error instanceof BrowserRuntimeError && !/broker unreachable|RUNTIME_UNAVAILABLE/.test(error.message)
            if (refused) current = undefined
            if (current && now() < current.expiresAtMs) return current.token
            throw error
        }).finally(() => { pending = undefined })
        return pending
    }
}
