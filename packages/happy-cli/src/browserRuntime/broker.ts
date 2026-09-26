/**
 * Agent grant broker (D4) and attention feed (D10) on a unix socket.
 *
 * Host path /run/abp/broker.sock, group abp-session, mode 0660: only the
 * Happy daemon and its session processes (user `agent`, outside the claude
 * sandbox) can connect. The agent HMAC key never leaves the Runtime.
 *
 *   GET  /v1/sessions           daemon token   → [{ registrationId, agentSessionId?, owner?, bootId?, createdAtMs, revoking }]
 *   POST /v1/sessions/register  daemon token   { owner?, bootId? } → { registrationId, sessionSecret }
 *   POST /v1/sessions/bind      daemon token   { registrationId, agentSessionId, owner? }
 *   POST /v1/sessions/revoke    daemon token   { agentSessionId } | { registrationId }
 *   POST /v1/agent-grants       session secret { agentSessionId, profileId } → { token, grantId, expiresAtMs }
 *   GET  /v1/attention?afterSeq=&waitMs=  daemon token → AttentionFeed
 *
 * The daemon registers at spawn (the Happy session id is not known yet) and
 * binds the registration once the session reports its id. Identity (principal,
 * workspace, machine, allowed profiles and origins) comes from the Runtime
 * config, never from a request. Registrations are persisted (secret hashes
 * only) so a Runtime restart does not strand running sessions.
 *
 * Revocation first persists a tombstone (`revoking`), then revokes each grant,
 * then drops the registration: interrupted at any point, issuance stays
 * blocked and the grant ids stay known until a retry or restart finishes it.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, chown, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'
import { mintAgentGrant } from './auth'
import type { AttentionOutbox } from './attention'
import { AGENT_OPERATIONS, BrowserRuntimeError, type AgentSessionId, type GrantId, type MachineId, type PrincipalId, type ProfileId, type WorkspaceId } from './contracts'
import { MAX_SUBSCRIBE_WAIT_MS, httpStatusFor } from './server'
import { sessionOwnerSchema, type SessionOwner } from './sessionRegistration'

/** Session processes renew 5 minutes before expiry. */
export const BROKER_GRANT_TTL_MS = 55 * 60_000
const REGISTRY_FILE = 'broker-sessions.json'
const MAX_BODY_BYTES = 16 * 1024

interface Registration {
    secretSha256: string
    owner?: SessionOwner
    /** Host boot id reported by the daemon at registration (the Runtime's own view may differ in a container). */
    bootId?: string
    agentSessionId?: string
    createdAtMs: number
    grantIds: string[]
    /**
     * Revocation started: no grant is issued any more, and the registration (with
     * its grant ids) stays until every grant is revoked. A crash or a failed
     * revokeGrant leaves it for the daemon's retry or the next start-up.
     */
    revoking?: true
}
interface RegistryFile { schemaVersion: 1; registrations: Record<string, Registration> }

export interface BrokerOptions {
    socketPath: string
    /** Already listening on `socketPath` (bound before the Runtime dropped root); otherwise the broker binds it. */
    server?: Server
    /** Registrations are persisted here (the Runtime state volume). */
    stateDir: string
    daemonTokenSha256: string
    identity: { machineId: MachineId; workspaceId: WorkspaceId }
    /** Profiles sessions may use, with their owning principal. */
    profiles: ReadonlyMap<ProfileId, PrincipalId>
    allowedOrigins: string[]
    agentKey: string | Buffer
    revokeGrant(grantId: GrantId): Promise<void>
    /** The bound agent session ended: cancel its tasks and reclaim its spaces (idempotent). */
    endSession?(agentSessionId: string): Promise<void>
    attention: AttentionOutbox
    socketGid?: number
    /** Delay before retrying a start-up revocation replay that failed. */
    recoveryRetryMs?: number
    now?: () => number
    log?: (line: string) => void
}

export interface Broker {
    close(): Promise<void>
    /** Grants of registrations being revoked; the task API must deny them until revocation completes. */
    revokingGrantIds(): ReadonlySet<string>
    /** Registrations whose revocation has not completed (readiness is false while any remain). */
    pendingRevocations(): number
}

/** The credential denylist for the task API: the Runtime's revocations plus grants still being revoked. */
export function withRevokingGrants(revoked: ReadonlySet<string>, broker?: Pick<Broker, 'revokingGrantIds'>): ReadonlySet<string> {
    const revoking = broker?.revokingGrantIds()
    return revoking?.size ? new Set([...revoked, ...revoking]) : revoked
}

const id = z.string().min(1).max(256)
const schemas = {
    register: z.object({ schemaVersion: z.literal(1), owner: sessionOwnerSchema.optional(), bootId: z.string().min(1).max(256).optional() }).strict(),
    bind: z.object({ schemaVersion: z.literal(1), registrationId: id, agentSessionId: id, owner: sessionOwnerSchema.optional() }).strict(),
    revoke: z.union([
        z.object({ schemaVersion: z.literal(1), agentSessionId: id }).strict(),
        z.object({ schemaVersion: z.literal(1), registrationId: id }).strict(),
    ]),
    grant: z.object({ schemaVersion: z.literal(1), agentSessionId: id, profileId: id }).strict(),
    attention: z.object({ afterSeq: z.coerce.number().int().nonnegative(), waitMs: z.coerce.number().int().nonnegative().max(MAX_SUBSCRIBE_WAIT_MS).default(0) }),
}

const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest()

function header(req: IncomingMessage, name: string): string {
    const value = req.headers[name]
    return typeof value === 'string' ? value : ''
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    let raw = ''
    for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY_BYTES) throw new BrowserRuntimeError('INVALID_REQUEST', 'body too large')
    }
    try { return raw ? JSON.parse(raw) : {} } catch { throw new BrowserRuntimeError('INVALID_REQUEST', 'body is not valid JSON') }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new BrowserRuntimeError('INVALID_REQUEST', 'invalid broker request')
    return parsed.data
}

function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

export async function startBroker(options: BrokerOptions): Promise<Broker> {
    const now = options.now ?? Date.now
    const log = options.log ?? (() => {})
    const expectedDaemonToken = Buffer.from(options.daemonTokenSha256, 'hex')
    const registryPath = join(options.stateDir, REGISTRY_FILE)
    let registry: RegistryFile = { schemaVersion: 1, registrations: {} }
    try {
        registry = JSON.parse(await readFile(registryPath, 'utf8')) as RegistryFile
        if (registry.schemaVersion !== 1) throw new Error('schema')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BrowserRuntimeError('JOURNAL_UNAVAILABLE', 'Broker registry is unreadable')
    }
    let writeTail: Promise<void> = Promise.resolve()
    const persist = (): Promise<void> => {
        const snapshot = JSON.stringify(registry)
        writeTail = writeTail.catch(() => undefined).then(async () => {
            const temporary = join(options.stateDir, `.${randomUUID()}.broker.tmp`)
            try {
                const handle = await open(temporary, 'wx', 0o600)
                try { await handle.writeFile(snapshot); await handle.sync() } finally { await handle.close() }
                await rename(temporary, registryPath)
                const dir = await open(options.stateDir, 'r')
                try { await dir.sync() } finally { await dir.close() }
            } catch (error) {
                await rm(temporary, { force: true })
                throw error
            }
        })
        return writeTail
    }

    // Registry changes, grant issuance and revocation run one at a time, after the
    // request body is read: a revoke can never interleave with an issuance that
    // already looked its registration up.
    let exclusiveTail: Promise<unknown> = Promise.resolve()
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
        const run = exclusiveTail.then(work, work)
        exclusiveTail = run.catch(() => undefined)
        return run
    }

    const assertDaemon = (req: IncomingMessage): void => {
        const supplied = sha256(header(req, 'x-abp-daemon-token'))
        if (!header(req, 'x-abp-daemon-token') || !timingSafeEqual(supplied, expectedDaemonToken)) throw new BrowserRuntimeError('UNAUTHORIZED', 'daemon token required')
    }
    const findByAgentSession = (agentSessionId: string): [string, Registration] | undefined =>
        Object.entries(registry.registrations).find(([, registration]) => registration.agentSessionId === agentSessionId)

    /** Tombstone, revoke every grant, then forget the registration. Callers hold `exclusive`. */
    const finishRevocation = async (registrationId: string, registration: Registration): Promise<number> => {
        // Set before persisting, so this process issues nothing more even if the write fails;
        // written on every attempt, so no grant is revoked before the tombstone is on disk.
        registration.revoking = true
        await persist().catch(() => { throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'revocation could not be recorded', true) })
        for (const grantId of registration.grantIds) {
            await options.revokeGrant(grantId as GrantId)
                .catch(() => { throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'grant revocation is incomplete', true) })
        }
        // Still under the tombstone: a failure or crash here is retried like a grant revocation.
        if (registration.agentSessionId && options.endSession) {
            await options.endSession(registration.agentSessionId)
                .catch(() => { throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'session end is incomplete', true) })
        }
        delete registry.registrations[registrationId]
        await persist()
        log(`broker session revoked grants=${registration.grantIds.length}`)
        return registration.grantIds.length
    }

    const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
        'GET /v1/sessions': async (req) => {
            assertDaemon(req)
            return exclusive(async () => Object.entries(registry.registrations).map(([registrationId, registration]) => ({
                registrationId, agentSessionId: registration.agentSessionId, owner: registration.owner, bootId: registration.bootId,
                createdAtMs: registration.createdAtMs, revoking: registration.revoking === true,
            })))
        },
        'POST /v1/sessions/register': async (req) => {
            assertDaemon(req)
            const body = parse(schemas.register, await readJson(req))
            return exclusive(async () => {
                const registrationId = `reg-${randomUUID()}`
                const sessionSecret = randomBytes(32).toString('base64url')
                registry.registrations[registrationId] = { secretSha256: sha256(sessionSecret).toString('hex'), createdAtMs: now(), grantIds: [], ...(body.owner ? { owner: body.owner } : {}), ...(body.bootId ? { bootId: body.bootId } : {}) }
                await persist()
                return { registrationId, sessionSecret }
            })
        },
        'POST /v1/sessions/bind': async (req) => {
            assertDaemon(req)
            const body = parse(schemas.bind, await readJson(req))
            return exclusive(async () => {
                const registration = registry.registrations[body.registrationId]
                if (!registration || registration.revoking) throw new BrowserRuntimeError('SCOPE_DENIED', 'unknown registration')
                const other = findByAgentSession(body.agentSessionId)
                if ((registration.agentSessionId && registration.agentSessionId !== body.agentSessionId)
                    || (other && other[0] !== body.registrationId)) throw new BrowserRuntimeError('CONFLICT', 'registration or session is already bound')
                registration.agentSessionId = body.agentSessionId
                if (body.owner) registration.owner = body.owner
                await persist()
                return { bound: true }
            })
        },
        'POST /v1/sessions/revoke': async (req) => {
            assertDaemon(req)
            const body = parse(schemas.revoke, await readJson(req))
            return exclusive(async () => {
                const entry = 'registrationId' in body
                    ? (registry.registrations[body.registrationId] ? [body.registrationId, registry.registrations[body.registrationId]] as const : undefined)
                    : findByAgentSession(body.agentSessionId)
                if (!entry) return { revoked: false, grants: 0 }
                const grants = await finishRevocation(...entry)
                return { revoked: true, grants }
            })
        },
        'POST /v1/agent-grants': async (req) => {
            const secret = header(req, 'x-abp-session-secret')
            if (!secret) throw new BrowserRuntimeError('UNAUTHORIZED', 'session is not registered')
            const body = parse(schemas.grant, await readJson(req))
            return exclusive(async () => {
                // Looked up only now: the registration may have been revoked while the body arrived.
                const secretSha256 = sha256(secret).toString('hex')
                const entry = Object.entries(registry.registrations).find(([, registration]) => registration.secretSha256 === secretSha256)
                if (!entry || entry[1].revoking) throw new BrowserRuntimeError('UNAUTHORIZED', 'session is not registered')
                const [, registration] = entry
                if (!registration.agentSessionId) throw new BrowserRuntimeError('CONFLICT', 'session registration is not bound yet', true)
                if (registration.agentSessionId !== body.agentSessionId) throw new BrowserRuntimeError('SCOPE_DENIED', 'secret belongs to another session')
                const principalId = options.profiles.get(body.profileId as ProfileId)
                if (!principalId) throw new BrowserRuntimeError('SCOPE_DENIED', 'profile is not allowed')
                const issuedAtMs = now()
                const grantId = `grant-${randomUUID()}` as GrantId
                const expiresAtMs = issuedAtMs + BROKER_GRANT_TTL_MS
                const token = mintAgentGrant({
                    kind: 'agent-grant', grantId, principalId, workspaceId: options.identity.workspaceId, machineId: options.identity.machineId,
                    agentSessionId: body.agentSessionId as AgentSessionId, profileId: body.profileId as ProfileId,
                    allowedOrigins: [...options.allowedOrigins], operations: [...AGENT_OPERATIONS], taskSpaceIds: [], issuedAtMs, expiresAtMs,
                }, { agentKey: options.agentKey }, issuedAtMs)
                // Recorded before it is handed out, so a revoke always covers it.
                registration.grantIds.push(grantId)
                await persist()
                return { token, grantId, expiresAtMs }
            })
        },
        'GET /v1/attention': async (req, url) => {
            assertDaemon(req)
            const query = parse(schemas.attention, Object.fromEntries(url.searchParams))
            return options.attention.wait(query.afterSeq, query.waitMs)
        },
    }

    const server = options.server ?? createServer()
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://broker')
        const route = routes[`${req.method} ${url.pathname}`]
        if (!route) return send(res, 404, { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'not found', retryable: false, mayHaveSideEffects: false } })
        route(req, url).then((result) => send(res, 200, { ok: true, result }), (error: unknown) => {
            const body = error instanceof BrowserRuntimeError ? error.toBody()
                : { code: 'RUNTIME_UNAVAILABLE' as const, message: 'internal error', retryable: true, mayHaveSideEffects: false }
            // Path only: headers carry secrets.
            log(`broker ${req.method} ${url.pathname} -> ${body.code}`)
            send(res, error instanceof BrowserRuntimeError ? httpStatusFor(body.code) : 500, { ok: false, error: body })
        })
    })

    // Revocations a crash interrupted are replayed in the background. Their grants are
    // denied from the start (revokingGrantIds) and readiness stays false until done.
    let closed = false
    let recoveryTimer: NodeJS.Timeout | undefined
    const replayRevocations = async (): Promise<void> => {
        for (const [registrationId, registration] of Object.entries(registry.registrations)) {
            if (!registration.revoking || closed) continue
            await exclusive(() => registry.registrations[registrationId] === registration ? finishRevocation(registrationId, registration) : Promise.resolve(0))
                .catch(() => log('broker revocation recovery incomplete; retrying'))
        }
        if (!closed && Object.values(registry.registrations).some((registration) => registration.revoking)) {
            recoveryTimer = setTimeout(() => void replayRevocations(), options.recoveryRetryMs ?? 5_000)
            recoveryTimer.unref()
        }
    }
    if (!options.server) await listenOnSocket(server, options.socketPath, 0o660, options.socketGid)
    void replayRevocations()
    return {
        close: () => {
            closed = true
            clearTimeout(recoveryTimer)
            return new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
                .then(() => exclusiveTail.catch(() => undefined)).then(() => writeTail.catch(() => undefined))
        },
        revokingGrantIds: () => new Set(Object.values(registry.registrations).filter((registration) => registration.revoking).flatMap((registration) => registration.grantIds)),
        pendingRevocations: () => Object.values(registry.registrations).filter((registration) => registration.revoking).length,
    }
}

/**
 * Listen on a unix socket with exact permissions. A stale socket from a previous
 * run is removed; any other file type at the path is refused.
 */
export async function listenOnSocket(server: ReturnType<typeof createServer>, socketPath: string, mode: number, gid?: number): Promise<void> {
    await mkdir(join(socketPath, '..'), { recursive: true })
    try {
        if (!(await lstat(socketPath)).isSocket()) throw new Error(`ABP socket path is not a socket: ${socketPath}`)
        await rm(socketPath)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Created under a restrictive umask so there is no window with wider permissions.
    const previous = process.umask(0o777 & ~mode)
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(socketPath, () => { server.off('error', reject); resolve() })
        })
    } finally {
        process.umask(previous)
    }
    if (gid !== undefined) await chown(socketPath, -1, gid)
    await chmod(socketPath, mode)
}
