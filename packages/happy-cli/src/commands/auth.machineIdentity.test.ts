import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
  stopDaemon: vi.fn(async () => {}),
}))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: vi.fn(async () => ({ machineId: 'new' })) }))
vi.mock('node:readline', () => ({
  createInterface: () => ({ question: (_: string, answer: (value: string) => void) => answer('y'), close: () => {} }),
}))

import { configuration } from '@/configuration'
import { readMachineIdentity, writeCredentialsDataKey, writeMachineIdentity } from '@/persistence'
import { handleAuthCommand } from './auth'

describe('auth commands and the machine identity', () => {
  let home: string
  const original: Record<string, unknown> = {}
  const override = (key: string, value: string) => {
    original[key] = (configuration as unknown as Record<string, unknown>)[key]
    Object.defineProperty(configuration, key, { value, configurable: true })
  }
  const identity = { machineId: 'kept-machine', accountPublicKey: Buffer.alloc(32, 1).toString('base64') }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'happy-auth-identity-'))
    override('happyHomeDir', home)
    override('privateKeyFile', join(home, 'access.key'))
    override('settingsFile', join(home, 'settings.json'))
    await writeCredentialsDataKey({ token: 't', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(3) })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ machineId: 'kept-machine' }))
    writeMachineIdentity(identity)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) Object.defineProperty(configuration, key, { value, configurable: true })
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('logout removes credentials and settings but keeps the machine id and its key', async () => {
    await handleAuthCommand(['logout'])
    expect(existsSync(join(home, 'access.key'))).toBe(false)
    expect(existsSync(join(home, 'settings.json'))).toBe(false)
    expect(readMachineIdentity()).toEqual({ ...identity, machineKey: Buffer.alloc(32, 3).toString('base64') })
  })

  it('login --force forgets the machine identity so a new machine is registered', async () => {
    await handleAuthCommand(['login', '--force'])
    expect(readMachineIdentity()).toBeNull()
  })
})
