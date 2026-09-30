import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeBase64 } from '@/api/encryption'
import { configuration } from '@/configuration'
import { buildMachineIdentity } from '@/machineIdentity'
import { readCredentials, readMachineIdentity, updateSettings, writeCredentialsDataKey, writeCredentialsLegacy, writeMachineIdentity } from '@/persistence'
import { authAndSetupMachineIfNeeded } from './auth'

const accountKey = new Uint8Array(32).fill(1)
const machineKey = new Uint8Array(32).fill(3)
const credentials = { token: 't', encryption: { type: 'dataKey' as const, publicKey: accountKey, machineKey } }

describe('authAndSetupMachineIfNeeded machine identity', () => {
  let home: string
  const original: Record<string, unknown> = {}
  const override = (key: string, value: string) => {
    original[key] = (configuration as unknown as Record<string, unknown>)[key]
    Object.defineProperty(configuration, key, { value, configurable: true })
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'happy-machine-identity-'))
    override('happyHomeDir', home)
    override('privateKeyFile', join(home, 'access.key'))
    override('settingsFile', join(home, 'settings.json'))
    await writeCredentialsDataKey({ token: 't', publicKey: accountKey, machineKey })
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) Object.defineProperty(configuration, key, { value, configurable: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('comes back as the recorded machine for the same account', async () => {
    writeMachineIdentity(buildMachineIdentity('machine-before-logout', credentials))
    const result = await authAndSetupMachineIfNeeded()
    expect(result.machineId).toBe('machine-before-logout')
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).machineId).toBe('machine-before-logout')
  })

  it('registers a new machine for another account and records it', async () => {
    writeMachineIdentity(buildMachineIdentity('other-account-machine', {
      ...credentials, encryption: { ...credentials.encryption, publicKey: new Uint8Array(32).fill(2) },
    }))
    const result = await authAndSetupMachineIfNeeded()
    expect(result.machineId).not.toBe('other-account-machine')
    expect(readMachineIdentity()).toMatchObject({ machineId: result.machineId, accountPublicKey: encodeBase64(accountKey) })
  })

  it('falls back to a new machine when the identity file is broken', async () => {
    writeFileSync(join(home, 'machine-identity.json'), '{not json')
    const result = await authAndSetupMachineIfNeeded()
    expect(result.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(readMachineIdentity()?.machineId).toBe(result.machineId)
  })

  it('provisions a returning legacy account with the machine key its server machine already has', async () => {
    const secret = new Uint8Array(32).fill(4)
    await writeCredentialsLegacy({ token: 't', secret })
    await updateSettings(async s => ({ ...s, accountPublicKey: encodeBase64(accountKey) }))
    writeMachineIdentity(buildMachineIdentity('legacy-machine', {
      token: 't', encryption: { type: 'legacy', secret, provisioned: { publicKey: accountKey, machineKey } },
    }))
    const result = await authAndSetupMachineIfNeeded()
    expect(result.machineId).toBe('legacy-machine')
    const saved = await readCredentials()
    const savedKey = saved?.encryption.type === 'dataKey' ? saved.encryption.machineKey : saved?.encryption.provisioned?.machineKey
    expect(savedKey).toEqual(machineKey)
  })

  it('keeps the recorded machine key while a returning legacy account is not provisioned yet', async () => {
    const secret = new Uint8Array(32).fill(4)
    await writeCredentialsLegacy({ token: 't', secret })
    const provisioned = buildMachineIdentity('legacy-machine', {
      token: 't', encryption: { type: 'legacy', secret, provisioned: { publicKey: accountKey, machineKey } },
    })
    writeMachineIdentity(provisioned)
    const result = await authAndSetupMachineIfNeeded()
    expect(result.machineId).toBe('legacy-machine')
    expect(readMachineIdentity()).toEqual(provisioned)
  })
})
