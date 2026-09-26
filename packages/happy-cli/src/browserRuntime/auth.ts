import { createHmac, createPublicKey, sign as signBytes, timingSafeEqual, verify as verifyBytes, type KeyObject } from 'node:crypto'
import { BrowserRuntimeError, INTERACTIVE_CAPABILITY_ISSUER, INTERACTIVE_OPERATIONS, POC_LIMITS, type AgentGrant, type AuthContext, type AuthMode, type Credential, type InteractiveCapability, type MachineId, type Operation, type PrincipalId, type ProfileId, type TaskSpaceId, type WorkspaceId } from './contracts'
import { canonicalJson } from './policy'

/** interactiveKey is the harness (abp1) key; production Runtimes have none. */
export interface AuthKeys { agentKey: string | Buffer; interactiveKey?: string | Buffer }
export interface TrustedIssuer { kid: string; publicKeyPem: string }
/** A server-signed (abp2) interactive capability payload. */
export type ServerCapability = InteractiveCapability & { aud: string; iss: string }
export interface VerifyPolicy {
    authMode: AuthMode
    /** This Runtime's identity; abp2 `aud` must equal machineId. Required in production. */
    machineId?: MachineId
    workspaceId?: WorkspaceId
    trustedIssuers?: readonly TrustedIssuer[]
    /** Configured profile owners. When set, a credential for an unlisted profile or another principal is refused. */
    profilePrincipals?: ReadonlyMap<ProfileId, PrincipalId>
}
const harnessPolicy: VerifyPolicy = { authMode: 'harness' }
const forbiddenAgentOperations = new Set<Operation>([...INTERACTIVE_OPERATIONS, 'listTasks'])
const interactiveCapabilityOperations = new Set<Operation>([
    ...INTERACTIVE_OPERATIONS,
    'cancel',
    'resume',
    'getTask',
    'subscribe',
    'listTasks',
])
const issuedAtClockSkewMs = 30_000

function sign(payload: Credential, key: string | Buffer): string {
    const body = Buffer.from(canonicalJson(payload)).toString('base64url')
    const mac = createHmac('sha256', key).update(`abp1.${body}`).digest('base64url')
    return `abp1.${body}.${mac}`
}

function validateCredential(credential: Credential, nowMs: number): void {
    const { issuedAtMs, expiresAtMs } = credential
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || issuedAtMs > nowMs + issuedAtClockSkewMs || expiresAtMs <= nowMs || expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > POC_LIMITS.maxGrantLifetimeMs) {
        throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential is expired or outside its lifetime')
    }
    if (credential.kind === 'agent-grant' && credential.operations.some((operation) => forbiddenAgentOperations.has(operation))) {
        throw new BrowserRuntimeError('UNAUTHORIZED', 'Agent grant contains an interactive operation')
    }
    if (credential.kind === 'interactive' && credential.operations.some((operation) => !interactiveCapabilityOperations.has(operation))) {
        throw new BrowserRuntimeError('UNAUTHORIZED', 'Interactive capability contains a non-interactive operation')
    }
}

function mint(credential: Credential, key: string | Buffer, nowMs: number): string {
    validateCredential(credential, nowMs)
    return sign(credential, key)
}

export function mintAgentGrant(grant: AgentGrant, keys: AuthKeys, nowMs: number): string { return mint(grant, keys.agentKey, nowMs) }
export function mintInteractiveCapability(capability: InteractiveCapability, keys: AuthKeys, nowMs: number): string {
    if (!keys.interactiveKey) throw new BrowserRuntimeError('UNAUTHORIZED', 'No harness interactive key is configured')
    return mint(capability, keys.interactiveKey, nowMs)
}

/**
 * Signs an abp2 capability the way the Saycode server does. The Runtime never
 * holds a private key; this exists for tests and the harness.
 */
export function signServerCapability(capability: ServerCapability, signer: { kid: string; privateKey: KeyObject | string }): string {
    const header = Buffer.from(canonicalJson({ alg: 'EdDSA', kid: signer.kid, typ: 'abp-cap' })).toString('base64url')
    const payload = Buffer.from(canonicalJson(capability)).toString('base64url')
    const signature = signBytes(null, Buffer.from(`abp2.${header}.${payload}`), signer.privateKey).toString('base64url')
    return `abp2.${header}.${payload}.${signature}`
}

function decodeJson<T>(part: string): T {
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T } catch { throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed credential') }
}

function verifyHmacToken(parts: string[], keys: AuthKeys, policy: VerifyPolicy): Credential {
    if (parts.length !== 3) throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed credential')
    const credential = decodeJson<Credential>(parts[1])
    if (!credential || (credential.kind !== 'agent-grant' && credential.kind !== 'interactive')) throw new BrowserRuntimeError('UNAUTHORIZED', 'Unknown credential kind')
    if (credential.kind === 'interactive' && policy.authMode !== 'harness') throw new BrowserRuntimeError('UNAUTHORIZED', 'Interactive capabilities must be server-signed')
    const key = credential.kind === 'agent-grant' ? keys.agentKey : keys.interactiveKey
    if (!key) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential kind is not accepted')
    const expected = createHmac('sha256', key).update(`abp1.${parts[1]}`).digest()
    const actual = Buffer.from(parts[2], 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Invalid credential signature')
    return credential
}

const issuerKeys = new WeakMap<readonly TrustedIssuer[], Map<string, KeyObject>>()
function issuerKey(issuers: readonly TrustedIssuer[], kid: string): KeyObject | undefined {
    let keys = issuerKeys.get(issuers)
    if (!keys) {
        keys = new Map(issuers.map((issuer) => [issuer.kid, createPublicKey(issuer.publicKeyPem)]))
        issuerKeys.set(issuers, keys)
    }
    return keys.get(kid)
}

function verifyServerToken(parts: string[], policy: VerifyPolicy): Credential {
    if (parts.length !== 4) throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed credential')
    const header = decodeJson<{ alg?: unknown; kid?: unknown; typ?: unknown }>(parts[1])
    if (!header || header.alg !== 'EdDSA' || header.typ !== 'abp-cap' || typeof header.kid !== 'string') throw new BrowserRuntimeError('UNAUTHORIZED', 'Unsupported credential header')
    const key = issuerKey(policy.trustedIssuers ?? [], header.kid)
    if (!key || key.asymmetricKeyType !== 'ed25519') throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential issuer is not trusted')
    if (!verifyBytes(null, Buffer.from(`abp2.${parts[1]}.${parts[2]}`), key, Buffer.from(parts[3], 'base64url'))) throw new BrowserRuntimeError('UNAUTHORIZED', 'Invalid credential signature')
    const credential = decodeJson<ServerCapability>(parts[2])
    // Agent grants are minted by this Runtime only; the server signs interactive capabilities only.
    if (!credential || credential.kind !== 'interactive') throw new BrowserRuntimeError('UNAUTHORIZED', 'Server credentials must be interactive capabilities')
    if (credential.iss !== INTERACTIVE_CAPABILITY_ISSUER) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential issuer is not trusted')
    if (!policy.machineId || credential.aud !== policy.machineId) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential audience is not this machine')
    if (credential.expiresAtMs - credential.issuedAtMs > POC_LIMITS.maxInteractiveLifetimeMs) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential is expired or outside its lifetime')
    return credential
}

/** Configured identity binds every credential kind: machine, workspace, and the owner of the profile. */
function assertConfiguredScope(credential: Credential, policy: VerifyPolicy): void {
    if (policy.machineId && credential.machineId !== policy.machineId) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential is for another machine')
    if (policy.workspaceId && credential.workspaceId !== policy.workspaceId) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential is for another workspace')
    if (policy.profilePrincipals) {
        const owner = policy.profilePrincipals.get(credential.profileId)
        if (!owner || owner !== credential.principalId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Principal does not own the profile')
    }
}

export function verifyToken(token: string, keys: AuthKeys, nowMs: number, revoked: ReadonlySet<string> = new Set(), policy: VerifyPolicy = harnessPolicy): AuthContext {
    const parts = token.split('.')
    let credential: Credential
    if (parts[0] === 'abp1') credential = verifyHmacToken(parts, keys, policy)
    else if (parts[0] === 'abp2') credential = verifyServerToken(parts, policy)
    else throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed credential')
    validateCredential(credential, nowMs)
    assertConfiguredScope(credential, policy)
    const revocationId = credential.kind === 'agent-grant' ? credential.grantId : credential.capabilityId
    if (revoked.has(revocationId)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has been revoked')
    return { credential, verifiedAtMs: nowMs }
}

export function assertOperation(auth: AuthContext, operation: Operation, expected: { principalId?: string; workspaceId?: string; machineId?: string; profileId?: string; agentSessionId?: string; taskSpaceId?: TaskSpaceId }): void {
    const credential = auth.credential
    if (!credential.operations.includes(operation)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Operation is outside credential scope')
    for (const key of ['principalId', 'workspaceId', 'machineId', 'profileId'] as const) {
        if (expected[key] !== undefined && credential[key] !== expected[key]) throw new BrowserRuntimeError('SCOPE_DENIED', 'Credential scope does not match resource')
    }
    if (credential.kind === 'agent-grant') {
        if (expected.agentSessionId !== undefined && credential.agentSessionId !== expected.agentSessionId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent session does not own task')
        if (expected.taskSpaceId && credential.taskSpaceIds.length > 0 && !credential.taskSpaceIds.includes(expected.taskSpaceId)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space is outside grant scope')
    } else if (!interactiveCapabilityOperations.has(operation)) {
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Interactive capability cannot perform agent operation')
    }
}
