import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, INTERACTIVE_CAPABILITY_ISSUER, type AgentGrant, type GrantId, type MachineId, type PrincipalId, type ProfileId, type WorkspaceId } from './contracts'
import { mintAgentGrant, mintInteractiveCapability, signServerCapability, verifyToken, type ServerCapability, type VerifyPolicy } from './auth'

const keys = { agentKey: 'synthetic-agent-key', interactiveKey: 'synthetic-ui-key' }
const grant = (operations: AgentGrant['operations'] = ['getTask']): AgentGrant => ({
    kind: 'agent-grant', grantId: 'g1' as GrantId, principalId: 'p1' as never, workspaceId: 'w1' as never,
    machineId: 'm1' as never, agentSessionId: 'a1' as never, profileId: 'profile1' as ProfileId,
    allowedOrigins: ['https://fixture.test'], operations, taskSpaceIds: [], issuedAtMs: 10, expiresAtMs: 1000,
})

describe('signed credential kinds', () => {
    it('uses separate signing keys and rejects interactive operation escalation at mint and verify', () => {
        expect(() => mintAgentGrant(grant(['approve' as never]), keys, 20)).toThrowError(BrowserRuntimeError)
        const agentToken = mintAgentGrant(grant(), keys, 20)
        expect(() => verifyToken(agentToken, { ...keys, agentKey: 'wrong-key' }, 20)).toThrowError(BrowserRuntimeError)
        const interactiveToken = mintInteractiveCapability({ kind: 'interactive', capabilityId: 'c1', principalId: 'p1' as never, workspaceId: 'w1' as never, machineId: 'm1' as never, viewerSessionId: 'v1', profileId: 'profile1' as ProfileId, operations: ['approve'], issuedAtMs: 10, expiresAtMs: 1000 }, keys, 20)
        expect(() => verifyToken(interactiveToken, keys, 20, new Set(['c1']))).toThrowError(BrowserRuntimeError)
        expect(verifyToken(agentToken, keys, 20).credential.kind).toBe('agent-grant')
    })

    it('rejects expired and overlong grants', () => {
        expect(() => mintAgentGrant({ ...grant(), expiresAtMs: 10 + 3_600_000 + 1 }, keys, 20)).toThrowError(BrowserRuntimeError)
        const token = mintAgentGrant(grant(), keys, 20)
        expect(() => verifyToken(token, keys, 1000)).toThrowError(BrowserRuntimeError)
    })

    it('allows up to 30 seconds of issue-time clock skew and interactive stop operations', () => {
        const skewed = { ...grant(), issuedAtMs: 31_000, expiresAtMs: 3_631_000 }
        expect(() => mintAgentGrant(skewed, keys, 1_000)).not.toThrow()
        expect(() => mintAgentGrant({ ...skewed, issuedAtMs: 31_001 }, keys, 1_000))
            .toThrowError(BrowserRuntimeError)

        const capability = {
            kind: 'interactive' as const,
            capabilityId: 'stop-ui',
            principalId: 'p1' as never,
            workspaceId: 'w1' as never,
            machineId: 'm1' as never,
            viewerSessionId: 'viewer',
            profileId: 'profile1' as ProfileId,
            operations: ['approve', 'cancel', 'resume'] as const,
            issuedAtMs: 1_000,
            expiresAtMs: 10_000,
        }
        const token = mintInteractiveCapability({ ...capability, operations: [...capability.operations] }, keys, 1_000)
        expect(verifyToken(token, keys, 1_000).credential.operations).toEqual(['approve', 'cancel', 'resume'])
    })
})

describe('server-signed interactive capabilities (abp2)', () => {
    const issuer = generateKeyPairSync('ed25519')
    const otherIssuer = generateKeyPairSync('ed25519')
    const trustedIssuers = [{ kid: 'k1', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    const production = {
        authMode: 'production' as const, machineId: 'm1' as MachineId, workspaceId: 'w1' as WorkspaceId, trustedIssuers,
        profilePrincipals: new Map([['profile1' as ProfileId, 'p1' as PrincipalId]]),
    }
    const now = 1_000_000
    const capability = (overrides: Partial<ServerCapability> = {}): ServerCapability => ({
        kind: 'interactive', capabilityId: 'c2', principalId: 'p1' as PrincipalId, workspaceId: 'w1' as WorkspaceId,
        machineId: 'm1' as MachineId, viewerSessionId: 'v1', profileId: 'profile1' as ProfileId,
        operations: ['approve', 'getTask'], issuedAtMs: now, expiresAtMs: now + 300_000,
        aud: 'm1', iss: INTERACTIVE_CAPABILITY_ISSUER, ...overrides,
    })
    const signWith = (value: ServerCapability, key = issuer.privateKey, kid = 'k1') => signServerCapability(value, { kid, privateKey: key })
    const rejects = (token: string, policy: VerifyPolicy = production) =>
        expect(() => verifyToken(token, keys, now, new Set(), policy)).toThrowError(BrowserRuntimeError)

    it('accepts a capability signed by a trusted issuer for this machine', () => {
        const auth = verifyToken(signWith(capability()), keys, now, new Set(), production)
        expect(auth.credential).toMatchObject({ kind: 'interactive', principalId: 'p1', operations: ['approve', 'getTask'] })
    })

    it('accepts the viewerTicket operation on a server capability but never on an agent grant (D2)', () => {
        const auth = verifyToken(signWith(capability({ operations: ['viewerTicket', 'takeOver'] })), keys, now, new Set(), production)
        expect(auth.credential.operations).toEqual(['viewerTicket', 'takeOver'])
        expect(() => mintAgentGrant({ ...grant(['viewerTicket']), issuedAtMs: now, expiresAtMs: now + 1000 }, keys, now)).toThrowError(BrowserRuntimeError)
    })

    it('rejects a forged signature under a trusted kid', () => {
        rejects(signWith(capability(), otherIssuer.privateKey))
    })

    it('rejects a payload changed after signing', () => {
        const [prefix, header, , signature] = signWith(capability()).split('.')
        const escalated = Buffer.from(JSON.stringify({ ...capability(), principalId: 'p2' })).toString('base64url')
        rejects([prefix, header, escalated, signature].join('.'))
    })

    it('rejects an unknown kid and a wrong header', () => {
        rejects(signWith(capability(), issuer.privateKey, 'k-unknown'))
        const token = signWith(capability())
        const [, , payload, signature] = token.split('.')
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1', typ: 'abp-cap' })).toString('base64url')
        rejects(`abp2.${header}.${payload}.${signature}`)
    })

    it('rejects an audience or machine that is not this machine', () => {
        rejects(signWith(capability({ aud: 'm2' })))
        rejects(signWith(capability({ machineId: 'm2' as MachineId })))
        rejects(signWith(capability({ workspaceId: 'w2' as WorkspaceId })))
    })

    it('rejects a wrong issuer, an expired capability and one living longer than 5 minutes', () => {
        rejects(signWith(capability({ iss: 'someone-else' })))
        rejects(signWith(capability({ expiresAtMs: now })))
        rejects(signWith(capability({ expiresAtMs: now + 300_001 })))
    })

    it('rejects a capability whose principal does not own the profile, or an unknown profile', () => {
        rejects(signWith(capability({ principalId: 'p2' as PrincipalId })))
        rejects(signWith(capability({ profileId: 'profile-unknown' as ProfileId })))
    })

    it('rejects abp1 interactive capabilities in production but keeps them in harness mode', () => {
        const legacy = mintInteractiveCapability({ kind: 'interactive', capabilityId: 'c1', principalId: 'p1' as PrincipalId,
            workspaceId: 'w1' as WorkspaceId, machineId: 'm1' as MachineId, viewerSessionId: 'v1', profileId: 'profile1' as ProfileId,
            operations: ['approve'], issuedAtMs: now, expiresAtMs: now + 1000 }, keys, now)
        rejects(legacy)
        expect(verifyToken(legacy, keys, now, new Set(), { authMode: 'harness' }).credential.kind).toBe('interactive')
    })

    it('keeps accepting internally minted abp1 agent grants in production, scoped to the configured principal', () => {
        const agentToken = mintAgentGrant({ ...grant(), issuedAtMs: now, expiresAtMs: now + 1000 }, keys, now)
        expect(verifyToken(agentToken, keys, now, new Set(), production).credential.kind).toBe('agent-grant')
        rejects(mintAgentGrant({ ...grant(), principalId: 'p2' as never, issuedAtMs: now, expiresAtMs: now + 1000 }, keys, now))
    })

    it('rejects an abp2 agent grant: only interactive capabilities are server-signed', () => {
        rejects(signWith({ ...capability(), kind: 'agent-grant' } as never))
    })

    it('rejects a revoked server capability', () => {
        expect(() => verifyToken(signWith(capability()), keys, now, new Set(['c2']), production)).toThrowError(BrowserRuntimeError)
    })
})
