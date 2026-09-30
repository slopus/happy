import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tweetnacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the interactive selector, the QR output and the server's auth endpoint are faked;
// logout, doAuth, credential writing and machine setup run for real in a temp HAPPY home.
const server = vi.hoisted(() => ({ accountPublicKey: new Uint8Array(32), posts: 0 }))
vi.mock('ink', () => ({
  render: (element: { props: { onSelect: (method: string) => void } }) => {
    queueMicrotask(() => element.props.onSelect('mobile'))
    return { unmount: () => {} }
  },
}))
vi.mock('./qrcode', () => ({ displayQRCode: () => {} }))
vi.mock('axios', () => ({
  default: {
    post: vi.fn(async (_url: string, body: { publicKey: string }) => {
      server.posts++
      // The approving client boxes [0, account public key] to the CLI's ephemeral key (dataKey account).
      const recipient = new Uint8Array(Buffer.from(body.publicKey, 'base64'))
      const ephemeral = tweetnacl.box.keyPair()
      const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength)
      const payload = new Uint8Array([0, ...server.accountPublicKey])
      const boxed = tweetnacl.box(payload, nonce, recipient, ephemeral.secretKey)
      const bundle = new Uint8Array([...ephemeral.publicKey, ...nonce, ...boxed])
      return { data: { state: 'authorized', token: 'relogin-token', response: Buffer.from(bundle).toString('base64') } }
    }),
  },
}))
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
  stopDaemon: vi.fn(async () => {}),
}))
vi.mock('node:readline', () => ({
  createInterface: () => ({ question: (_: string, answer: (value: string) => void) => answer('y'), close: () => {} }),
}))

import { handleAuthCommand } from '@/commands/auth'
import { configuration } from '@/configuration'
import { readCredentials, writeCredentialsDataKey } from '@/persistence'
import { authAndSetupMachineIfNeeded } from './auth'

describe('dataKey account logout and login through the auth flow', () => {
  let home: string
  const original: Record<string, unknown> = {}
  const override = (key: string, value: string) => {
    original[key] = (configuration as unknown as Record<string, unknown>)[key]
    Object.defineProperty(configuration, key, { value, configurable: true })
  }
  const accountKey = new Uint8Array(32).fill(1)
  const machineKey = new Uint8Array(32).fill(3)

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'happy-relogin-'))
    override('happyHomeDir', home)
    override('privateKeyFile', join(home, 'access.key'))
    override('settingsFile', join(home, 'settings.json'))
    server.posts = 0
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'clear').mockImplementation(() => {})
    await writeCredentialsDataKey({ token: 'first-token', publicKey: accountKey, machineKey })
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) Object.defineProperty(configuration, key, { value, configurable: true })
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('comes back as the same machine with the same machine key for the same account', async () => {
    const first = await authAndSetupMachineIfNeeded()
    await handleAuthCommand(['logout'])
    expect(await readCredentials()).toBeNull()

    server.accountPublicKey = accountKey
    const again = await authAndSetupMachineIfNeeded()

    expect(server.posts).toBeGreaterThan(0)
    expect(again.machineId).toBe(first.machineId)
    const saved = await readCredentials()
    expect(saved?.token).toBe('relogin-token')
    expect(saved?.encryption.type === 'dataKey' && saved.encryption.machineKey).toEqual(machineKey)
  })

  it('registers a new machine with a new key when another account logs in', async () => {
    const first = await authAndSetupMachineIfNeeded()
    await handleAuthCommand(['logout'])

    server.accountPublicKey = new Uint8Array(32).fill(2)
    const again = await authAndSetupMachineIfNeeded()

    expect(again.machineId).not.toBe(first.machineId)
    const saved = await readCredentials()
    expect(saved?.encryption.type === 'dataKey' && saved.encryption.machineKey).not.toEqual(machineKey)
  })
})
