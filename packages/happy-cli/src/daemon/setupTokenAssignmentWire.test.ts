import { describe, expect, it } from 'vitest'
import {
  createSetupTokenAssignmentRecipient,
  openSetupTokenAssignment,
  sealSetupTokenAssignment,
  setupTokenRecipientCapability,
  type SetupTokenAssignmentContext,
} from './setupTokenAssignmentWire'

const context = (overrides: Partial<SetupTokenAssignmentContext> = {}): SetupTokenAssignmentContext => ({
  version: 1,
  scope: 'company-1',
  userId: 'user-1',
  machineId: 'machine-1',
  provider: 'claude',
  generation: 4,
  fingerprint: 'a'.repeat(64),
  leaseId: 'lease-1',
  expiresAt: 2_000,
  payload: JSON.stringify({ version: 1, encrypted: false, accounts: [] }),
  ...overrides,
})

describe('setup-token assignment wire', () => {
  it('seals and opens with the per-incarnation recipient', () => {
    const recipient = createSetupTokenAssignmentRecipient()
    const sealed = sealSetupTokenAssignment(context(), recipient.publicKey)

    expect(openSetupTokenAssignment(sealed, recipient, 1_000)).toEqual(context())
    expect(setupTokenRecipientCapability(recipient)).toEqual({ keyId: recipient.keyId, publicKey: recipient.publicKey })
    expect(sealed.ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('rejects the wrong recipient, key id, and tampered ciphertext', () => {
    const recipient = createSetupTokenAssignmentRecipient()
    const other = createSetupTokenAssignmentRecipient()
    const sealed = sealSetupTokenAssignment(context(), recipient.publicKey)

    expect(() => openSetupTokenAssignment(sealed, other, 1_000)).toThrow('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
    expect(() => openSetupTokenAssignment({ ...sealed, keyId: other.keyId }, recipient, 1_000)).toThrow('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes[bytes.length - 1] ^= 1
    expect(() => openSetupTokenAssignment({ ...sealed, ciphertext: bytes.toString('base64') }, recipient, 1_000)).toThrow('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
  })

  it('rejects malformed context and expiry before returning plaintext', () => {
    const recipient = createSetupTokenAssignmentRecipient()
    const expired = sealSetupTokenAssignment(context({ expiresAt: 999 }), recipient.publicKey)
    expect(() => openSetupTokenAssignment(expired, recipient, 1_000)).toThrow('SETUP_TOKEN_SEALED_PAYLOAD_EXPIRED')

    const wrongProvider = sealSetupTokenAssignment(context({ provider: 'codex' as 'claude' }), recipient.publicKey)
    expect(() => openSetupTokenAssignment(wrongProvider, recipient, 1_000)).toThrow('SETUP_TOKEN_SEALED_CONTEXT_INVALID')
  })
})
