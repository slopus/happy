import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, INTERACTIVE_CAPABILITY_ISSUER, type AgentGrant, type GrantId, type MachineId, type PrincipalId, type ProfileId, type WorkspaceId } from './contracts'
import { mintAgentGrant, mintInteractiveCapability, signServerCapability, signSessionUserAttestation, verifySessionUserAttestation, verifyToken, type ServerCapability, type SessionUserAttestation, type VerifyPolicy } from './auth'

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

describe('profile assignment of agent grants', () => {
    const assignmentPolicy = (assignmentId: string): VerifyPolicy => ({ authMode: 'harness', profileAssignments: new Map([['profile1' as ProfileId, assignmentId]]) })
    const first = 'a'.repeat(32)
    const later = 'b'.repeat(32)

    it("accepts a grant only in its own assignment: an earlier one's, or one without any, fails even for the same owner", () => {
        const token = mintAgentGrant({ ...grant(), assignmentId: first }, keys, 20)
        expect(verifyToken(token, keys, 20, new Set(), assignmentPolicy(first)).credential).toMatchObject({ assignmentId: first })
        expect(() => verifyToken(token, keys, 20, new Set(), assignmentPolicy(later))).toThrow(/earlier assignment/)
        expect(() => verifyToken(mintAgentGrant(grant(), keys, 20), keys, 20, new Set(), assignmentPolicy(first))).toThrow(/earlier assignment/)
        // A grant for a profile without a configured assignment is refused too.
        expect(() => verifyToken(mintAgentGrant({ ...grant(), assignmentId: first, profileId: 'other' as ProfileId }, keys, 20), keys, 20, new Set(), assignmentPolicy(first)))
            .toThrow(/earlier assignment/)
        // Without configured assignments (harness) nothing changes.
        expect(verifyToken(token, keys, 20)).toBeTruthy()
    })

    it('does not bind interactive capabilities to the assignment (their owner and 5 minute lifetime are the check)', () => {
        const token = mintInteractiveCapability({ kind: 'interactive', capabilityId: 'c1', principalId: 'p1' as never, workspaceId: 'w1' as never, machineId: 'm1' as never,
            viewerSessionId: 'v1', profileId: 'profile1' as ProfileId, operations: ['approve'], issuedAtMs: 10, expiresAtMs: 1000 }, keys, 20)
        expect(verifyToken(token, keys, 20, new Set(), assignmentPolicy(later))).toBeTruthy()
    })
})

describe('session-user attestation (shared machines)', () => {
    const issuer = generateKeyPairSync('ed25519')
    const trustedIssuers = [{ kid: 'k1', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    const policy = { machineId: 'm1' as MachineId, workspaceId: 'w1' as WorkspaceId, trustedIssuers }
    const now = 1_000_000
    const claims = (overrides: Partial<SessionUserAttestation> = {}): SessionUserAttestation => ({
        kind: 'session-user', principalId: 'user-1' as PrincipalId, workspaceId: 'w1' as WorkspaceId, machineId: 'm1' as MachineId,
        aud: 'm1', iss: INTERACTIVE_CAPABILITY_ISSUER, issuedAtMs: now, expiresAtMs: now + 600_000, ...overrides,
    })
    const sign = (value: SessionUserAttestation, key = issuer.privateKey, kid = 'k1') => signSessionUserAttestation(value, { kid, privateKey: key })
    const rejects = (token: string) => expect(() => verifySessionUserAttestation(token, policy, now)).toThrowError(BrowserRuntimeError)

    it('returns the session user of an attestation a trusted issuer signed for this machine', () => {
        expect(verifySessionUserAttestation(sign(claims()), policy, now)).toEqual({ principalId: 'user-1', issuedAtMs: now })
    })

    it('rejects a forged signature, an unknown kid, a changed payload and another header type', () => {
        rejects(sign(claims(), generateKeyPairSync('ed25519').privateKey))
        rejects(sign(claims(), issuer.privateKey, 'k2'))
        const [prefix, header, , signature] = sign(claims()).split('.')
        rejects([prefix, header, Buffer.from(JSON.stringify(claims({ principalId: 'user-2' as PrincipalId }))).toString('base64url'), signature].join('.'))
        // A capability's header (typ abp-cap) is not an attestation, and an attestation is not a capability.
        const capabilityHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'k1', typ: 'abp-cap' })).toString('base64url')
        rejects(['abp2', capabilityHeader, sign(claims()).split('.')[2], signature].join('.'))
        expect(() => verifyToken(sign(claims()), { agentKey: 'k' }, now, new Set(), { authMode: 'production', ...policy })).toThrowError(BrowserRuntimeError)
    })

    it('rejects another machine, workspace, issuer or kind, and an expired or over-10-minute attestation', () => {
        rejects(sign(claims({ aud: 'm2' })))
        rejects(sign(claims({ machineId: 'm2' as MachineId })))
        rejects(sign(claims({ workspaceId: 'w2' as WorkspaceId })))
        rejects(sign(claims({ iss: 'someone' })))
        rejects(sign(claims({ kind: 'interactive' as never })))
        rejects(sign(claims({ expiresAtMs: now })))
        rejects(sign(claims({ expiresAtMs: now + 600_001 })))
        rejects(sign(claims({ issuedAtMs: now + 31_000, expiresAtMs: now + 60_000 })))
        rejects(sign(claims({ principalId: '' as PrincipalId })))
        rejects('abp1.x.y')
    })
})
