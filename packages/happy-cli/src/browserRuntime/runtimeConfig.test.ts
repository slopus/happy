/** Runtime configuration validation and documented deployment defaults. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRuntimeConfig } from './runtimeConfig'

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
