/**
 * NaCl box wire for organization-managed setup-token assignment payloads.
 * The API incarnation owns the recipient secret key; callers only receive the
 * public capability and relay the opaque sealed payload.
 */
import { createHash } from 'node:crypto'
import tweetnacl from 'tweetnacl'

const EPHEMERAL_BYTES = tweetnacl.box.publicKeyLength
const NONCE_BYTES = tweetnacl.box.nonceLength
const MIN_CIPHERTEXT_BYTES = tweetnacl.box.overheadLength
const MAX_CIPHERTEXT_BYTES = 1024 * 1024 + 16 * 1024
const MAX_TEXT_BYTES = 1024 * 1024

export const SETUP_TOKEN_ASSIGNMENT_VERSION = 1 as const
export const SETUP_TOKEN_SEALED_PAYLOAD_VERSION = 1 as const

export type SetupTokenAssignmentRecipient = {
  keyId: string
  publicKey: string
  secretKey: Uint8Array
}

export type SetupTokenSealedPayload = {
  version: 1
  keyId: string
  ciphertext: string
}

export type SetupTokenAssignmentContext = {
  version: 1
  scope: string
  userId: string
  machineId: string
  provider: 'claude'
  generation: number
  fingerprint: string
  leaseId: string
  expiresAt: number
  payload: string
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function canonicalBase64(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null
  const bytes = new Uint8Array(Buffer.from(value, 'base64'))
  return Buffer.from(bytes).toString('base64') === value ? bytes : null
}

function keyId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex')
}

export function createSetupTokenAssignmentRecipient(): SetupTokenAssignmentRecipient {
  const pair = tweetnacl.box.keyPair()
  return { keyId: keyId(pair.publicKey), publicKey: Buffer.from(pair.publicKey).toString('base64'), secretKey: pair.secretKey }
}

export function setupTokenRecipientCapability(recipient: SetupTokenAssignmentRecipient): { keyId: string; publicKey: string } {
  return { keyId: recipient.keyId, publicKey: recipient.publicKey }
}

export function sealSetupTokenAssignment(context: SetupTokenAssignmentContext, recipientPublicKey: string): SetupTokenSealedPayload {
  const publicKey = canonicalBase64(recipientPublicKey)
  if (!publicKey || publicKey.length !== tweetnacl.box.publicKeyLength) throw new Error('SETUP_TOKEN_RECIPIENT_INVALID')
  const ephemeral = tweetnacl.box.keyPair()
  const nonce = tweetnacl.randomBytes(NONCE_BYTES)
  const plaintext = new TextEncoder().encode(JSON.stringify(context))
  const ciphertext = tweetnacl.box(plaintext, nonce, publicKey, ephemeral.secretKey)
  const bundle = new Uint8Array(EPHEMERAL_BYTES + NONCE_BYTES + ciphertext.length)
  bundle.set(ephemeral.publicKey, 0)
  bundle.set(nonce, EPHEMERAL_BYTES)
  bundle.set(ciphertext, EPHEMERAL_BYTES + NONCE_BYTES)
  return { version: 1, keyId: keyId(publicKey), ciphertext: Buffer.from(bundle).toString('base64') }
}

export function openSetupTokenAssignment(
  sealed: unknown,
  recipient: Pick<SetupTokenAssignmentRecipient, 'keyId' | 'secretKey'>,
  now: number,
): SetupTokenAssignmentContext {
  if (!sealed || typeof sealed !== 'object' || Array.isArray(sealed)) throw new Error('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
  const envelope = sealed as Record<string, unknown>
  if (!exactKeys(envelope, ['version', 'keyId', 'ciphertext']) || envelope.version !== 1
    || envelope.keyId !== recipient.keyId || typeof envelope.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.keyId)
    || typeof envelope.ciphertext !== 'string') throw new Error('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
  if (recipient.secretKey.length !== tweetnacl.box.secretKeyLength) throw new Error('SETUP_TOKEN_RECIPIENT_INVALID')
  const bundle = canonicalBase64(envelope.ciphertext)
  if (!bundle || bundle.length < EPHEMERAL_BYTES + NONCE_BYTES + MIN_CIPHERTEXT_BYTES || bundle.length > EPHEMERAL_BYTES + NONCE_BYTES + MAX_CIPHERTEXT_BYTES) throw new Error('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
  const ephemeral = bundle.slice(0, EPHEMERAL_BYTES)
  const nonce = bundle.slice(EPHEMERAL_BYTES, EPHEMERAL_BYTES + NONCE_BYTES)
  const ciphertext = bundle.slice(EPHEMERAL_BYTES + NONCE_BYTES)
  const plaintext = tweetnacl.box.open(ciphertext, nonce, ephemeral, recipient.secretKey)
  if (!plaintext || plaintext.length > MAX_TEXT_BYTES) throw new Error('SETUP_TOKEN_SEALED_PAYLOAD_INVALID')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) } catch { throw new Error('SETUP_TOKEN_SEALED_PAYLOAD_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SETUP_TOKEN_SEALED_CONTEXT_INVALID')
  const context = value as Record<string, unknown>
  if (!exactKeys(context, ['version', 'scope', 'userId', 'machineId', 'provider', 'generation', 'fingerprint', 'leaseId', 'expiresAt', 'payload'])
    || context.version !== 1 || context.provider !== 'claude'
    || ![context.scope, context.userId, context.machineId, context.leaseId].every(item => typeof item === 'string' && item.length >= 1 && item.length <= 128)
    || !Number.isSafeInteger(context.generation) || Number(context.generation) < 1
    || typeof context.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(context.fingerprint)
    || !Number.isSafeInteger(context.expiresAt) || Number(context.expiresAt) < 0
    || typeof context.payload !== 'string' || Buffer.byteLength(context.payload, 'utf8') > MAX_TEXT_BYTES) throw new Error('SETUP_TOKEN_SEALED_CONTEXT_INVALID')
  const expiresAt = context.expiresAt as number
  if (!Number.isSafeInteger(now) || now >= expiresAt) throw new Error('SETUP_TOKEN_SEALED_PAYLOAD_EXPIRED')
  return context as SetupTokenAssignmentContext
}
