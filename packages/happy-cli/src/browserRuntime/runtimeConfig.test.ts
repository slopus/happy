import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRuntimeConfig } from './runtimeConfig'

const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const valid = () => ({
    authMode: 'production',
    machineId: 'machine-h',
    workspaceId: 'workspace-1',
    profiles: [{ profileId: 'profile-a', principalId: 'user-1' }],
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
    })

    it('defaults the space quota to 4 (never above maxAgentWindows) and idle reclamation to 15 minutes', () => {
        expect(parseRuntimeConfig(valid())).toMatchObject({ maxSpacesPerProfile: 4, spaceIdleReclaimMs: 900_000 })
        expect(parseRuntimeConfig({ ...valid(), maxAgentWindows: 2 }).maxSpacesPerProfile).toBe(2)
        expect(parseRuntimeConfig({ ...valid(), maxAgentWindows: 6, maxSpacesPerProfile: 6 }).maxSpacesPerProfile).toBe(6)
        expect(() => parseRuntimeConfig({ ...valid(), maxAgentWindows: 3, maxSpacesPerProfile: 4 })).toThrow(/maxSpacesPerProfile/)
        expect(() => parseRuntimeConfig({ ...valid(), spaceIdleReclaimMs: 1_000 })).toThrow(/spaceIdleReclaimMs/)
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
})
