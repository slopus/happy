/**
 * Browser Runtime process (Agent Browser); `runtimeMain.ts` is the entry that runs it.
 *
 * Runs on the execution machine, independent of any Desktop/viewer/CLI
 * request: it owns the TaskStore writer lock, one CDP driver per profile, the
 * authenticated task API, the admin API, and (with a config file) the broker
 * socket that issues agent grants and serves the attention feed.
 *
 * Two modes:
 *  - harness (no ABP_CONFIG_FILE): the PoC E2E setup. Keys come from
 *    ABP_KEYS_FILE, the admin API is a TCP port with a bearer token.
 *  - config file (ABP_CONFIG_FILE, /etc/abp/runtime.json): identity, profile
 *    owners and trusted issuers come from the file. In authMode "production"
 *    interactive capabilities must be server-signed (abp2), the agent key is
 *    generated inside the state volume, admin is a unix socket only, and the
 *    writer flock taken by the container entrypoint must be held.
 *
 * Started as root (the production launcher, see privilegeDrop.ts), it only
 * reads the root-only config and binds the sockets, then drops to
 * ABP_RUNTIME_UID/GID before it touches the state volume or a browser.
 *
 * Environment:
 *   ABP_STATE_DIR            durable store directory (volume), required
 *   ABP_CONFIG_FILE          runtime config file (config mode)
 *   ABP_KEYS_FILE            JSON {agentKey, interactiveKey, adminToken} (harness; optional in config mode)
 *   ABP_PROFILES             JSON [{profileId, cdpHttpUrl, instanceUrl, vncAddress?}] (config mode: fills missing endpoints)
 *   ABP_RUNTIME_HOST/PORT    task API bind in harness mode (default 0.0.0.0:8787 in the container)
 *   ABP_ADMIN_PORT           harness admin API port (default 8788)
 *   ABP_WRITER_FLOCK         lock file the entrypoint holds with flock -F (set by the entrypoint)
 *   ABP_RUNTIME_UID/GID      identity to drop to when started as root (set by the image)
 *   ABP_MAX_AGENT_WINDOWS    agent windows per profile (harness; config: maxAgentWindows; default 4, at most the tab quota)
 *   ABP_SPACE_IDLE_RECLAIM_MS  close idle finished task spaces after this long (harness; config: spaceIdleReclaimMs; off in harness by default)
 *   ABP_SITE_POLICY          JSON sites[] (policy.parseSitePolicies), harness mode; config mode uses runtime.json sites[]
 *   ABP_VNC_PASSWORD_FILE    per-run x11vnc password (or ABP_VNC_PASSWORD); enables the viewer (D2). Read before dropping root.
 *   ABP_VIEWER_ORIGINS       comma-separated tunnel origins for the viewer (harness; config: viewerOrigins)
 *   ABP_VIEWER_ASSETS_DIR    pinned noVNC client served at /viewer/ (default /usr/share/novnc)
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { open, readFile, statfs } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { collectRuntimeMetrics, startAdminServer, type AdminServer } from './admin'
import { AttentionOutbox } from './attention'
import { verifyToken, type AuthKeys, type VerifyPolicy } from './auth'
import { listenOnSocket, startBroker, withRevokingGrants, type Broker } from './broker'
import { BrowserRuntimeError, POC_LIMITS, type BrowserInstanceId, type BrowserRuntimeApi, type ProfileId } from './contracts'
import { CdpDriver, DEFAULT_MAX_AGENT_WINDOWS } from './drivers/cdpDriver'
import { dropRoot, joinGroup, processPrivilegeOps, runtimeIdentity, type PrivilegeOps } from './privilegeDrop'
import { parseSitePolicies, type SitePolicy } from './policy'
import { BrowserRuntime } from './runtime'
import { loadRuntimeConfig, type RuntimeConfig } from './runtimeConfig'
import { startRuntimeServer } from './server'
import { TaskStore } from './taskStore'
import { ViewerProxy, type ViewerEndpoint } from './viewerProxy'
import { holdsWriterFlock } from './writerFlock'

interface ProfileConfig {
    profileId: ProfileId
    cdpHttpUrl: string
    instanceUrl: string
    /** x11vnc on the profile network (`host:port`); without it the profile has no viewer. */
    vncAddress?: string
}

interface KeysFile extends AuthKeys {
    adminToken: string
}

const RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000]
const SWEEP_INTERVAL_MS = 1_000
const RETENTION_INTERVAL_MS = 60 * 60_000
const SPACE_RECLAIM_INTERVAL_MS = 30_000
const DAY_MS = 24 * 60 * 60_000
const LOCK_HEARTBEAT_MS = 5_000

function requiredEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required`)
    return value
}

async function fetchJson(url: string, timeoutMs = 5_000): Promise<unknown> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', `${new URL(url).pathname} returned ${response.status}`, true)
    return response.json()
}

/** The browser's identity comes from its supervisor, never from CDP. */
function instanceIdProvider(profile: ProfileConfig): () => Promise<BrowserInstanceId> {
    return async () => {
        const body = await fetchJson(profile.instanceUrl) as { browserInstanceId?: unknown }
        if (typeof body.browserInstanceId !== 'string' || !body.browserInstanceId) {
            throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser instance id is unavailable', true)
        }
        return body.browserInstanceId as BrowserInstanceId
    }
}

async function browserWsUrl(profile: ProfileConfig): Promise<string> {
    const version = await fetchJson(new URL('/json/version', profile.cdpHttpUrl).toString()) as { webSocketDebuggerUrl?: unknown }
    if (typeof version.webSocketDebuggerUrl !== 'string') throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'no CDP endpoint', true)
    return version.webSocketDebuggerUrl
}

async function connectWithRetry(driver: CdpDriver, profile: ProfileConfig, log: (line: string) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await driver.reconnect(await browserWsUrl(profile))
            return
        } catch (error) {
            const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
            if (attempt % 10 === 0) log(`profile=${profile.profileId} browser connect failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`)
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }
}

const MIN_SECRET_LENGTH = 32
/** Longer than the store's 20 s heartbeat lease, so a dead writer's lock always expires first. */
const LOCK_WAIT_MS = 30_000
const LOCK_RETRY_MS = 1_000

async function openStoreWaitingForStaleLease(stateDir: string, log: (line: string) => void): Promise<TaskStore> {
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
        try {
            return await TaskStore.open(stateDir)
        } catch (error) {
            const liveWriter = error instanceof BrowserRuntimeError && /live writer/.test(error.message)
            if (!liveWriter || Date.now() >= deadline) throw error
            log('writer lock held by a recent heartbeat; waiting for it to expire')
            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
        }
    }
}

/** Every key must be present and long; an empty admin token would otherwise match an empty bearer. */
function loadKeys(path: string, required: ReadonlyArray<keyof KeysFile> = ['agentKey', 'interactiveKey', 'adminToken']): KeysFile {
    let parsed: Partial<KeysFile>
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<KeysFile>
    } catch {
        // Never echo the parse error: it can quote bytes of the key file.
        throw new Error('ABP_KEYS_FILE is unreadable or not JSON')
    }
    for (const name of ['agentKey', 'interactiveKey', 'adminToken'] as const) {
        const value = parsed[name]
        if (value === undefined && !required.includes(name)) continue
        if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) throw new Error(`ABP_KEYS_FILE ${name} is missing or shorter than ${MIN_SECRET_LENGTH} characters`)
    }
    return parsed as KeysFile
}

/** The agent HMAC key is created inside the state volume on first start and never leaves it. */
async function loadOrCreateAgentKey(stateDir: string): Promise<string> {
    const path = join(stateDir, 'agent.key')
    try {
        const handle = await open(path, 'wx', 0o600)
        try {
            await handle.writeFile(randomBytes(32).toString('hex'))
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('ABP agent key could not be created')
    }
    const key = (await readFile(path, 'utf8')).trim()
    if (key.length < MIN_SECRET_LENGTH) throw new Error('ABP agent key in the state volume is invalid')
    return key
}

/** Config profiles may leave endpoints to ABP_PROFILES (container names chosen by the launcher). */
function configProfiles(config: RuntimeConfig): ProfileConfig[] {
    const fromEnv = process.env.ABP_PROFILES ? JSON.parse(process.env.ABP_PROFILES) as ProfileConfig[] : []
    return config.profiles.map((profile) => {
        const endpoints = fromEnv.find((candidate) => candidate.profileId === profile.profileId)
        const cdpHttpUrl = profile.cdpHttpUrl ?? endpoints?.cdpHttpUrl
        const instanceUrl = profile.instanceUrl ?? endpoints?.instanceUrl
        if (!cdpHttpUrl || !instanceUrl) throw new Error(`ABP profile ${profile.profileId} has no browser endpoints`)
        const vncAddress = profile.vncAddress ?? endpoints?.vncAddress
        return { profileId: profile.profileId as ProfileId, cdpHttpUrl, instanceUrl, ...(vncAddress ? { vncAddress } : {}) }
    })
}

/** RFB passwords are at most 8 characters; the value is dropped from the environment once read. */
function loadVncPassword(): string | undefined {
    const file = process.env.ABP_VNC_PASSWORD_FILE
    let password: string | undefined
    try {
        password = file ? readFileSync(file, 'utf8').trim() : process.env.ABP_VNC_PASSWORD
    } catch {
        throw new Error('ABP_VNC_PASSWORD_FILE is unreadable')
    }
    delete process.env.ABP_VNC_PASSWORD
    if (!password) return undefined
    if (password.length > 8) throw new Error('ABP VNC password must be at most 8 characters')
    return password
}

function maxAgentWindows(config: RuntimeConfig | undefined): number {
    const raw = config ? String(config.maxAgentWindows) : process.env.ABP_MAX_AGENT_WINDOWS
    if (raw === undefined || raw === '') return DEFAULT_MAX_AGENT_WINDOWS
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > POC_LIMITS.maxActiveTabs) {
        throw new Error(`ABP maxAgentWindows must be an integer between 1 and ${POC_LIMITS.maxActiveTabs}`)
    }
    return value
}

/** Required: without a site policy nothing may be opened, so refuse to start instead. */
function loadSites(config: RuntimeConfig | undefined): SitePolicy[] {
    try {
        return parseSitePolicies(config ? config.sites : JSON.parse(requiredEnv('ABP_SITE_POLICY')))
    } catch {
        // Never echo the parser error: it can quote the configuration.
        throw new Error('ABP site policy (runtime.json sites[] or ABP_SITE_POLICY) is missing or invalid')
    }
}

function vncEndpoint(address: string): ViewerEndpoint {
    const separator = address.lastIndexOf(':')
    const port = Number(address.slice(separator + 1))
    if (separator <= 0 || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('ABP profile vncAddress must be host:port')
    return { host: address.slice(0, separator), port }
}

const MIN_FREE_DISK_BYTES = 256 * 1024 * 1024
const FENCE_ACK_SAMPLES = 100

export interface RuntimeProcessDeps {
    /** Identity syscalls of the root start (tests inject failures). */
    privilege?: PrivilegeOps
}

export async function runRuntime(deps: RuntimeProcessDeps = {}): Promise<void> {
    const privilege = deps.privilege ?? processPrivilegeOps
    const log = (line: string) => process.stderr.write(`[abp-runtime] ${new Date().toISOString()} ${line}\n`)
    const stateDir = requiredEnv('ABP_STATE_DIR')
    const config = process.env.ABP_CONFIG_FILE ? loadRuntimeConfig(process.env.ABP_CONFIG_FILE) : undefined
    const production = config?.authMode === 'production'
    // Secrets the runtime UID may not be able to read are read before dropping root.
    const vncPassword = loadVncPassword()
    const harnessKeys = process.env.ABP_KEYS_FILE ? loadKeys(process.env.ABP_KEYS_FILE, config ? ['agentKey'] : undefined) : undefined
    if (!config && !harnessKeys) throw new Error('ABP_KEYS_FILE is required without ABP_CONFIG_FILE')
    const adminOnSocket = production || !harnessKeys?.adminToken

    let boundBroker: Server | undefined
    let boundAdmin: Server | undefined
    if (privilege.getuid() === 0) {
        if (!config) throw new Error('ABP refuses to run as root without ABP_CONFIG_FILE')
        const target = runtimeIdentity(process.env)
        try {
            if (config.brokerSocketGid !== undefined) joinGroup(config.brokerSocketGid, privilege)
            if (config.daemonTokenSha256) {
                boundBroker = createServer()
                await listenOnSocket(boundBroker, config.brokerSocketPath, 0o660, config.brokerSocketGid)
            }
            if (adminOnSocket) {
                boundAdmin = createServer()
                await listenOnSocket(boundAdmin, config.adminSocketPath, 0o600)
            }
            await dropRoot(target, privilege)
        } catch (error) {
            // Nothing past this point has run (no state, browser or task API); release the sockets too.
            await Promise.all([boundBroker, boundAdmin].map((server) => server?.listening
                ? new Promise<void>((resolve) => server.close(() => resolve())) : undefined))
            throw error
        }
        log(`dropped root uid=${target.uid} gid=${target.gid}`)
    }
    // Production never accepts a harness interactive key or admin token.
    const keys: AuthKeys = production || !harnessKeys
        ? { agentKey: await loadOrCreateAgentKey(stateDir) }
        : harnessKeys
    const profiles = config ? configProfiles(config) : JSON.parse(requiredEnv('ABP_PROFILES')) as ProfileConfig[]
    const host = config?.runtimeHost ?? process.env.ABP_RUNTIME_HOST ?? '0.0.0.0'
    const port = config?.runtimePort ?? Number(process.env.ABP_RUNTIME_PORT ?? '8787')
    const windows = maxAgentWindows(config)
    const sites = loadSites(config)
    const adminPort = Number(process.env.ABP_ADMIN_PORT ?? '8788')
    const policy: VerifyPolicy = config
        ? { authMode: config.authMode, machineId: config.machineId, workspaceId: config.workspaceId, trustedIssuers: config.trustedIssuers, profilePrincipals: config.profilePrincipals }
        : { authMode: 'harness' }

    // D9: the entrypoint holds an exclusive kernel flock (flock -n -F) before node
    // starts. Production refuses to open the store or CDP without it.
    const flockPath = process.env.ABP_WRITER_FLOCK
    const flockHeld = flockPath ? await holdsWriterFlock(flockPath) : false
    if (production && !flockHeld) throw new Error('ABP writer flock is not held by this process (start through the image entrypoint)')
    if (!flockHeld) log('writer flock not verified; relying on the heartbeat lease only')

    // A second live Runtime on the same state dir is refused (writer lock). After a
    // crash the old lock's heartbeat is still fresh for up to its lease, so wait that
    // long before giving up instead of exiting while the previous writer is merely dead.
    const store = await openStoreWaitingForStaleLease(stateDir, log)
    // Attached and reconciled before the Runtime's own recovery commits anything.
    const attention = await AttentionOutbox.open(stateDir)
    attention.attach(store)
    await attention.reconcile()

    const drivers = new Map<ProfileId, CdpDriver>()
    for (const profile of profiles) {
        drivers.set(profile.profileId, new CdpDriver({ browserWsUrl: '', browserInstanceIdProvider: instanceIdProvider(profile), maxAgentWindows: windows }))
    }
    // Connect before recovery so it can compare browser instance ids.
    await Promise.all(profiles.map((profile) => connectWithRetry(drivers.get(profile.profileId)!, profile, log)))

    // Harness keeps the PoC space quota and no idle reclamation unless asked.
    const harnessIdleMs = process.env.ABP_SPACE_IDLE_RECLAIM_MS ? Number(process.env.ABP_SPACE_IDLE_RECLAIM_MS) : undefined
    const runtime = new BrowserRuntime({ store, drivers, sites,
        maxSpacesPerProfile: config?.maxSpacesPerProfile,
        spaceIdleReclaimMs: config?.spaceIdleReclaimMs ?? (Number.isFinite(harnessIdleMs) ? harnessIdleMs : undefined) })

    for (const profile of profiles) {
        const driver = drivers.get(profile.profileId)!
        // One recovery chain per profile: a close during reconnect must not start a
        // second chain that races the first over the same tasks.
        let recovering: Promise<void> | undefined
        const recover = (): Promise<void> => (async () => {
            log(`profile=${profile.profileId} browser disconnected`)
            await runtime.onDriverDisconnected(profile.profileId)
                .catch((error) => log(`disconnect handling failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
            do {
                await connectWithRetry(driver, profile, log)
            } while (!driver.isConnected())
            await runtime.onDriverReconnected(profile.profileId)
            log(`profile=${profile.profileId} browser reconnected`)
        })()
            .catch((error) => { log(`reconnect handling failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`) })
            .finally(() => { recovering = undefined })
        driver.onDisconnect(() => {
            recovering ??= recover()
        })
    }

    // Keeps the writer lock's heartbeat fresh; another Runtime may only take the
    // store over once this stops (the lease expires after 20 s without it).
    let heartbeatOkAtMs = Date.now()
    const heartbeat = setInterval(() => {
        void store.heartbeat()
            .then(() => { heartbeatOkAtMs = Date.now() })
            .catch((error) => log(`lock heartbeat failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref()

    let sweeping = false
    const sweep = setInterval(() => {
        // A slow sweep (journal fsync) must not overlap the next tick.
        if (sweeping) return
        sweeping = true
        void runtime.sweep(Date.now())
            .catch((error) => log(`sweep failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
            .finally(() => { sweeping = false })
    }, SWEEP_INTERVAL_MS)
    sweep.unref()

    // retentionDays (config mode): finished tasks older than that are deleted, at start
    // and hourly; an interrupted deletion is finished by the next run.
    let retention: NodeJS.Timeout | undefined
    if (config) {
        const retentionMs = config.retentionDays * DAY_MS
        let purging = false
        const purge = () => {
            if (purging) return
            purging = true
            void runtime.purgeExpiredTasks(retentionMs)
                .then((purged) => { if (purged.length) log(`retention deleted tasks=${purged.length}`) })
                .catch((error) => log(`retention failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
                .finally(() => { purging = false })
        }
        purge()
        retention = setInterval(purge, RETENTION_INTERVAL_MS)
        retention.unref()
    }

    // Task spaces of ended sessions (broker) and idle finished ones are closed; a pass is
    // also started right after a session ends. Blocked tabs are reported and retried.
    let reclaiming = false
    const reclaim = () => {
        if (reclaiming) return
        reclaiming = true
        void runtime.reclaimSpaces()
            .then((reports) => {
                for (const report of reports) {
                    if (report.closed || report.blockedTabs || report.failedTabs || report.retained)
                        log(`space reclaim space=${report.taskSpaceId} reason=${report.reason} closed=${report.closed} tabs=${report.closedTabs.length}`
                            + ` blocked=${report.blockedTabs?.length ?? 0} failed=${report.failedTabs?.length ?? 0} retained=${report.retained?.length ?? 0}`)
                }
            })
            .catch((error) => log(`space reclaim failed code=${(error as BrowserRuntimeError).code ?? 'ERROR'}`))
            .finally(() => { reclaiming = false })
    }
    reclaim()
    const reclaimTimer = setInterval(reclaim, SPACE_RECLAIM_INTERVAL_MS)
    reclaimTimer.unref()

    const fenceAcksMs: number[] = []
    // Records cancel fence ACK latency for metrics; every other operation goes straight to the Runtime.
    const api = new Proxy(runtime, {
        get(target, property) {
            if (property === 'cancel') {
                return async (...args: Parameters<BrowserRuntimeApi['cancel']>) => {
                    const result = await target.cancel(...args)
                    fenceAcksMs.push(result.fenceAckMs)
                    fenceAcksMs.splice(0, Math.max(0, fenceAcksMs.length - FENCE_ACK_SAMPLES))
                    return result
                }
            }
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
        },
    })

    // Before the task API: grants of revocations a crash interrupted must be denied
    // from the first request (the broker replays them in the background).
    let broker: Broker | undefined
    if (config?.daemonTokenSha256) {
        broker = await startBroker({
            socketPath: config.brokerSocketPath, socketGid: config.brokerSocketGid, server: boundBroker, stateDir,
            daemonTokenSha256: config.daemonTokenSha256,
            identity: { machineId: config.machineId, workspaceId: config.workspaceId },
            profiles: config.profilePrincipals,
            allowedOrigins: config.sites.map((site) => site.origin),
            agentKey: keys.agentKey,
            revokeGrant: (grantId) => runtime.revokeGrant(grantId),
            endSession: async (agentSessionId) => { await runtime.endSession(agentSessionId); reclaim() },
            attention,
            log,
        })
    }
    // D2: the Runtime is the only viewer endpoint; x11vnc is reachable on the profile networks only.
    const vncEndpoints = new Map(profiles.flatMap((profile) => profile.vncAddress ? [[profile.profileId, vncEndpoint(profile.vncAddress)] as const] : []))
    const viewer = vncPassword && vncEndpoints.size ? new ViewerProxy({
        leases: runtime.leases,
        endpoint: (profileId) => vncEndpoints.get(profileId),
        vncPassword,
        isCapabilityLive: (capability) => capability.expiresAtMs > Date.now() && !store.isRevoked(capability.capabilityId),
        allowedOrigins: config?.viewerOrigins ?? (process.env.ABP_VIEWER_ORIGINS ?? '').split(',').filter(Boolean),
        log,
    }) : undefined
    const viewerAssetsDir = process.env.ABP_VIEWER_ASSETS_DIR ?? '/usr/share/novnc'

    const startedAtMs = Date.now()
    const server = await startRuntimeServer({
        api,
        verifyToken: (bearer) => verifyToken(bearer, keys, Date.now(), withRevokingGrants(store.getRevocations(), broker), policy),
        host,
        port,
        health: () => ({
            pid: process.pid,
            startedAtMs,
            profiles: profiles.map((profile) => ({ profileId: profile.profileId, connected: drivers.get(profile.profileId)!.isConnected() })),
        }),
        ready: async () => {
            const disk = await statfs(stateDir).catch(() => undefined)
            return {
                browsers: profiles.every((profile) => drivers.get(profile.profileId)!.isConnected()),
                writerLock: Date.now() - heartbeatOkAtMs <= 3 * LOCK_HEARTBEAT_MS && (flockHeld || !production),
                disk: Boolean(disk && disk.bavail * disk.bsize >= MIN_FREE_DISK_BYTES),
                revocations: (broker?.pendingRevocations() ?? 0) === 0,
            }
        },
        log: (line: string) => log(line),
        ...(viewer ? { viewer } : {}),
        ...(existsSync(viewerAssetsDir) ? { viewerAssetsDir } : {}),
    })
    const admin: AdminServer = await startAdminServer({
        runtime, drivers,
        listen: boundAdmin ? { server: boundAdmin }
            : adminOnSocket || !harnessKeys?.adminToken ? { socketPath: config?.adminSocketPath ?? '/run/abp/admin.sock' }
                : { host, port: adminPort, adminToken: harnessKeys.adminToken },
        metrics: () => collectRuntimeMetrics({ store, drivers, stateDir, fenceAcksMs }),
        // Viewers of the capability stop synchronously, before the revocation is persisted (D2).
        revokeCapability: (capabilityId) => {
            viewer?.revokeCapability(capabilityId)
            return store.revoke(capabilityId)
        },
    })
    log(`listening api=${server.url} mode=${config?.authMode ?? 'harness'} admin=${admin.port ?? 'socket'} broker=${broker ? 'socket' : 'off'} flock=${flockHeld} profiles=${profiles.length} viewer=${viewer ? vncEndpoints.size : 'off'}`)

    const shutdown = async () => {
        clearInterval(sweep)
        clearInterval(retention)
        clearInterval(reclaimTimer)
        clearInterval(heartbeat)
        await server.close()
        await admin.close()
        await broker?.close()
        await attention.flush().catch(() => undefined)
        attention.close()
        for (const driver of drivers.values()) await driver.close()
        await store.close()
        process.exit(0)
    }
    process.once('SIGTERM', () => void shutdown())
    process.once('SIGINT', () => void shutdown())
}
