/** Runtime configuration validation and documented deployment defaults. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRuntimeConfig } from './runtimeConfig'
import { sharedProfileId } from './tenancy'

const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const ASSIGNMENT = '0123456789abcdef0123456789abcdef'
const valid = () => ({
    schemaVersion: 2,
    authMode: 'production',
    machineId: 'machine-h',
    workspaceId: 'workspace-1',
    profiles: [{ profileId: 'profile-a', principalId: 'user-1', assignmentId: ASSIGNMENT }],
    trustedIssuers: [{ kid: 'k1', publicKeyPem }],
    daemonTokenSha256: 'a'.repeat(64),
    sites: [{ origin: 'https://shop.example' }],
})

describe('parseRuntimeConfig', () => {
    it('accepts a production config and fills documented defaults', () => {
        const config = parseRuntimeConfig(valid())
        expect(config).toMatchObject({
            authMode: 'production', runtimePort: 8787, maxAgentWindows: 4, retentionDays: 7,
            brokerSocketPath: '/run/abp/broker.sock', adminSocketPath: '/run/abp/admin.sock',
        })
        expect(config.profilePrincipals.get('profile-a' as never)).toBe('user-1')
        expect(config.profileAssignments?.get('profile-a' as never)).toBe(ASSIGNMENT)
        expect(config.admissionHold).toBe(false)
        expect(parseRuntimeConfig({ ...valid(), admissionHold: true }).admissionHold).toBe(true)
    })

    it('allows one profile under assignments in dedicated tenancy (its broker ledger keys all profiles together)', () => {
        const second = { profileId: 'profile-b', principalId: 'user-2', assignmentId: 'b'.repeat(32) }
        expect(() => parseRuntimeConfig({ ...valid(), profiles: [...valid().profiles, second] })).toThrow(/one profile/)
    })

    it('defaults to dedicated tenancy, which keeps one profile', () => {
        expect(parseRuntimeConfig(valid()).tenancyMode).toBe('dedicated')
        expect(parseRuntimeConfig({ ...valid(), tenancyMode: 'dedicated' }).tenancyMode).toBe('dedicated')
        expect(() => parseRuntimeConfig({ ...valid(), tenancyMode: 'other' })).toThrow(/tenancyMode/)
    })

    it('accepts shared tenancy with zero to eight per-user profiles named after their owner', () => {
        const profile = (principalId: string, index: number) => ({ profileId: sharedProfileId(principalId), principalId, assignmentId: index.toString(16).padStart(32, '0') })
        const empty = parseRuntimeConfig({ ...valid(), tenancyMode: 'shared', profiles: [] })
        expect(empty.tenancyMode).toBe('shared')
        expect(empty.profilePrincipals.size).toBe(0)
        const eight = Array.from({ length: 8 }, (_, index) => profile(`user-${index}`, index))
        expect(parseRuntimeConfig({ ...valid(), tenancyMode: 'shared', profiles: eight }).profileAssignments?.size).toBe(8)
        expect(() => parseRuntimeConfig({ ...valid(), tenancyMode: 'shared', profiles: [...eight, profile('user-8', 8)] })).toThrow(/profiles/)
        // A profile id that is not its owner's: the broker maps a session user to a profile by this name.
        expect(() => parseRuntimeConfig({ ...valid(), tenancyMode: 'shared', profiles: [{ ...profile('user-1', 1), principalId: 'user-2' }] })).toThrow(/profileId/)
        expect(() => parseRuntimeConfig({ ...valid(), tenancyMode: 'shared', schemaVersion: 1, profiles: [] })).toThrow(/schemaVersion|shared/)
        expect(() => parseRuntimeConfig({ ...valid(), profiles: [] })).toThrow(/profiles/)
    })

    it('names a shared profile u- and the first 16 hex of the SHA-256 of its owner (vector shared with Studio)', () => {
        expect(sharedProfileId('user-1')).toBe('u-c6c289e49e9c05b2')
    })

    it('requires schema 2 with an assignment per profile in production, and keeps schema 1 for the harness only', () => {
        expect(() => parseRuntimeConfig({ ...valid(), schemaVersion: 1, profiles: [{ profileId: 'profile-a', principalId: 'user-1' }] })).toThrow(/schemaVersion/)
        expect(() => parseRuntimeConfig({ ...valid(), profiles: [{ profileId: 'profile-a', principalId: 'user-1' }] })).toThrow(/assignmentId/)
        expect(() => parseRuntimeConfig({ ...valid(), profiles: [{ profileId: 'profile-a', principalId: 'user-1', assignmentId: 'A'.repeat(32) }] })).toThrow(/assignmentId/)
        expect(() => parseRuntimeConfig({ ...valid(), schemaVersion: 3 })).toThrow(/schemaVersion/)
        const harness = parseRuntimeConfig({ authMode: 'harness', machineId: 'm', workspaceId: 'w', profiles: [{ profileId: 'p', principalId: 'u' }] })
        expect(harness.profileAssignments).toBeUndefined()
        expect(() => parseRuntimeConfig({ authMode: 'harness', machineId: 'm', workspaceId: 'w', admissionHold: true, profiles: [{ profileId: 'p', principalId: 'u' }] })).toThrow(/admissionHold/)
    })

    it('defaults the space quota to 4 (never above maxAgentWindows) and idle reclamation to 15 minutes', () => {
        expect(parseRuntimeConfig(valid())).toMatchObject({ maxSpacesPerProfile: 4, spaceIdleReclaimMs: 900_000 })
        expect(parseRuntimeConfig({ ...valid(), maxAgentWindows: 2 }).maxSpacesPerProfile).toBe(2)
        expect(parseRuntimeConfig({ ...valid(), maxAgentWindows: 6, maxSpacesPerProfile: 6 }).maxSpacesPerProfile).toBe(6)
        expect(() => parseRuntimeConfig({ ...valid(), maxAgentWindows: 3, maxSpacesPerProfile: 4 })).toThrow(/maxSpacesPerProfile/)
        expect(() => parseRuntimeConfig({ ...valid(), spaceIdleReclaimMs: 1_000 })).toThrow(/spaceIdleReclaimMs/)
    })

    it('configures logical-session orphan retention with a one-hour default', () => {
        expect(parseRuntimeConfig(valid()).brokerOrphanTtlMs).toBe(3_600_000)
        expect(parseRuntimeConfig({ ...valid(), brokerOrphanTtlMs: 120_000 }).brokerOrphanTtlMs).toBe(120_000)
        expect(() => parseRuntimeConfig({ ...valid(), brokerOrphanTtlMs: 0 })).toThrow(/brokerOrphanTtlMs/)
    })

    it('rejects unknown keys and duplicate profiles', () => {
        expect(() => parseRuntimeConfig({ ...valid(), adminToken: 'x' })).toThrow(/runtime config/)
        expect(() => parseRuntimeConfig({ ...valid(), profiles: [valid().profiles[0], valid().profiles[0]] })).toThrow(/duplicate profileId/)
    })

    it('requires a trusted issuer and a daemon token hash in production', () => {
        expect(() => parseRuntimeConfig({ ...valid(), trustedIssuers: [] })).toThrow(/trustedIssuers/)
        const { daemonTokenSha256: _omit, ...withoutToken } = valid()
        expect(() => parseRuntimeConfig(withoutToken)).toThrow(/daemonTokenSha256/)
    })

    it('rejects an issuer key that is not an Ed25519 public key without echoing it', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
        expect(() => parseRuntimeConfig({ ...valid(), trustedIssuers: [{ kid: 'k1', publicKeyPem: rsa }] })).toThrow(/Ed25519/)
        let message = ''
        try { parseRuntimeConfig({ ...valid(), trustedIssuers: [{ kid: 'k1', publicKeyPem: 'SECRET-LOOKING-GARBAGE' }] }) } catch (error) { message = (error as Error).message }
        expect(message).toMatch(/trustedIssuers/)
        expect(message).not.toContain('SECRET-LOOKING-GARBAGE')
    })

    it('rejects site origins that are not bare origins', () => {
        expect(() => parseRuntimeConfig({ ...valid(), sites: [{ origin: 'https://shop.example/path' }] })).toThrow(/origin/)
        expect(() => parseRuntimeConfig({ ...valid(), sites: [{ origin: 'https://*.shop.example' }] })).toThrow(/origin/)
    })

    it('accepts "*" as the all-sites policy origin, but not as a viewer origin', () => {
        expect(parseRuntimeConfig({ ...valid(), sites: [{ origin: '*' }, { origin: 'https://shop.example' }] }).sites.map((site) => site.origin))
            .toEqual(['*', 'https://shop.example'])
        expect(() => parseRuntimeConfig({ ...valid(), viewerOrigins: ['*'] })).toThrow(/viewerOrigins/)
    })

    it('accepts viewer settings: a profile x11vnc address and tunnel origins (D2)', () => {
        const config = parseRuntimeConfig({ ...valid(), profiles: [{ ...valid().profiles[0], vncAddress: 'abp-browser-a:5900' }],
            viewerOrigins: ['https://machine-h.tunnel.example'] })
        expect(config.profiles[0].vncAddress).toBe('abp-browser-a:5900')
        expect(config.viewerOrigins).toEqual(['https://machine-h.tunnel.example'])
        expect(parseRuntimeConfig(valid()).viewerOrigins).toEqual([])
        expect(() => parseRuntimeConfig({ ...valid(), viewerOrigins: ['https://tunnel.example/viewer'] })).toThrow(/viewerOrigins/)
        expect(() => parseRuntimeConfig({ ...valid(), profiles: [{ ...valid().profiles[0], vncAddress: 'http://browser:5900' }] })).toThrow(/vncAddress/)
    })

    it('accepts the Studio origins that may hand the console its capability', () => {
        expect(parseRuntimeConfig({ ...valid(), consoleHostOrigins: ['https://studio.example'] }).consoleHostOrigins).toEqual(['https://studio.example'])
        expect(parseRuntimeConfig(valid()).consoleHostOrigins).toEqual([])
        expect(() => parseRuntimeConfig({ ...valid(), consoleHostOrigins: ['https://studio.example/chats'] })).toThrow(/consoleHostOrigins/)
    })
})
