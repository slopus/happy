/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R9 — files that hold key
 * material are owner-only.
 *
 * access.key carries the machine key, its legacy backup the account secret, and
 * sessions.json every session's data key. They were written with the process
 * umask (typically 0644) under a 0755 ~/.happy, so any local account could read
 * them on a shared host.
 *
 * Separate file for the same reason as persistence.provision.test.ts: the
 * configuration singleton reads HAPPY_HOME_DIR when it is first imported, so the
 * env is fixed before the dynamic imports below. The home is deliberately not
 * created here — the first import must create it.
 */
import { describe, expect, it } from 'vitest'
import { chmodSync, lstatSync, mkdtempSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'happy-perms-'))
const home = join(root, 'happy-home')
process.env.HAPPY_HOME_DIR = home

const modeOf = (path: string) => statSync(path).mode & 0o777

describe.skipIf(process.platform === 'win32')('owner-only key material', () => {
    it('creates a missing happy home as 0700', async () => {
        const { configuration } = await import('./configuration')
        expect(configuration.happyHomeDir).toBe(home)
        expect(modeOf(home)).toBe(0o700)
    })

    it('writes access.key as 0600, also when it replaces a 0644 file', async () => {
        const { configuration } = await import('./configuration')
        const { writeCredentialsDataKey, writeCredentialsLegacy } = await import('./persistence')
        writeFileSync(configuration.privateKeyFile, '{}', { mode: 0o644 })
        chmodSync(configuration.privateKeyFile, 0o644)

        await writeCredentialsDataKey({ token: 't', publicKey: new Uint8Array(32), machineKey: new Uint8Array(32) })
        expect(modeOf(configuration.privateKeyFile)).toBe(0o600)

        chmodSync(configuration.privateKeyFile, 0o644)
        await writeCredentialsLegacy({ token: 't', secret: new Uint8Array(32) })
        expect(modeOf(configuration.privateKeyFile)).toBe(0o600)
    })

    it('keeps access.key 0600 when a machine key is provisioned into it', async () => {
        const { configuration } = await import('./configuration')
        const { readCredentials, provisionLegacyMachineKey, writeCredentialsLegacy } = await import('./persistence')
        await writeCredentialsLegacy({ token: 't', secret: new Uint8Array(32).fill(1) })
        chmodSync(configuration.privateKeyFile, 0o644)

        await provisionLegacyMachineKey((await readCredentials())!, Buffer.alloc(32, 2).toString('base64'))
        expect(modeOf(configuration.privateKeyFile)).toBe(0o600)
    })

    it('writes sessions.json as 0600', async () => {
        const { configuration } = await import('./configuration')
        const { persistSession } = await import('./persistence')
        persistSession('session-1', {
            encryptionKey: Buffer.alloc(32, 3).toString('base64'),
            encryptionVariant: 'dataKey',
            seq: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: { path: '/w', host: 'h' } as never,
            savedAt: 0,
        })
        expect(modeOf(configuration.sessionsFile)).toBe(0o600)
    })

    it('repairs an existing home and its key files, leaving absent ones absent', async () => {
        const { configuration } = await import('./configuration')
        const { hardenHappyHomePermissions } = await import('./persistence')
        const backup = `${configuration.privateKeyFile}.legacy-backup`
        writeFileSync(configuration.privateKeyFile, '{}')
        writeFileSync(backup, '{}')
        writeFileSync(configuration.sessionsFile, '{}')
        for (const path of [configuration.privateKeyFile, backup, configuration.sessionsFile]) chmodSync(path, 0o644)
        chmodSync(home, 0o755)

        hardenHappyHomePermissions()

        expect(modeOf(home)).toBe(0o700)
        expect(modeOf(configuration.privateKeyFile)).toBe(0o600)
        expect(modeOf(backup)).toBe(0o600)
        expect(modeOf(configuration.sessionsFile)).toBe(0o600)
    })

    it('does not follow a symlinked key file to change its target', async () => {
        const { configuration } = await import('./configuration')
        const { hardenHappyHomePermissions } = await import('./persistence')
        const elsewhere = join(root, 'elsewhere.json')
        writeFileSync(elsewhere, '{}')
        chmodSync(elsewhere, 0o644)
        const backup = `${configuration.privateKeyFile}.legacy-backup`
        try { lstatSync(backup); unlinkSync(backup) } catch { /* absent */ }
        symlinkSync(elsewhere, backup)

        hardenHappyHomePermissions()

        expect(modeOf(elsewhere)).toBe(0o644)
    })
})
