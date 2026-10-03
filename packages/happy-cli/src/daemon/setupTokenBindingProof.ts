/**
 * Server-signed proof that lets one new Claude spawn bind a managed setup-token
 * (specs/claude-setup-token-runtime/contract-result.md).
 *
 * The Studio server mints `claude-setup-token-binding-v1` with the same Ed25519
 * key it publishes for the org collector, under its own type and audience, so a
 * collector grant can never be replayed as a binding. The daemon trusts only the
 * origin in its own environment and the key at that origin's fixed path; the
 * renderer supplies the envelope but no key, origin or identity.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const SETUP_TOKEN_BINDING_TYPE = 'claude-setup-token-binding-v1'
export const STUDIO_PUBLIC_KEY_PATH = '/api/claude-collector/public-key'
// The Studio signer issues 60 s grants; anything longer is not one of ours.
const MAX_LIFETIME_MS = 60_000
const MAX_CLOCK_SKEW_MS = 60_000
const MAX_ENVELOPE = 4096
const MAX_KEY_RESPONSE = 16 * 1024
const KEY_CACHE_MS = 5 * 60_000
const ID = /^[A-Za-z0-9_-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CLAIM_KEYS = ['v', 'type', 'aud', 'keyId', 'companyId', 'groupScope', 'userId', 'machineId', 'managedAccountId',
  'credentialGeneration', 'nonce', 'issuedAt', 'expiresAt'] as const

export type SetupTokenBindingClaims = {
  v: 1; type: typeof SETUP_TOKEN_BINDING_TYPE; aud: string; keyId: string
  companyId: string; groupScope: string; userId: string; machineId: string
  managedAccountId: string; credentialGeneration: number; nonce: string; issuedAt: number; expiresAt: number
}
export type StudioPublicKey = { keyId: string; publicKeyBase64: string }

/** The daemon's own configuration; a bare https origin, or http on loopback for local development. */
export function readTrustedStudioOrigin(env: Record<string, string | undefined>): string | null {
  const raw = env.HAPPY_APLUS_STUDIO_ORIGIN
  if (!raw) return null
  try {
    const url = new URL(raw)
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.origin !== raw.replace(/\/$/, '')) return null
    return url.origin
  } catch { return null }
}

const keyIdOf = (spki: Buffer) => createHash('sha256').update(spki).digest('hex')
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1

/** Pure check of one envelope against a known key; every claim is compared, unknown claims are refused. */
export function verifySetupTokenBindingGrant(input: {
  envelope: string; publicKey: StudioPublicKey; origin: string; machineId: string; now: number
}): SetupTokenBindingClaims | null {
  try {
    const { envelope } = input
    if (!wellFormedEnvelope(envelope)) return null
    const [encoded, signature] = envelope.split('.') as [string, string]
    const spki = Buffer.from(input.publicKey.publicKeyBase64, 'base64')
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519' || keyIdOf(spki) !== input.publicKey.keyId
      || Buffer.from(signature, 'base64url').toString('base64url') !== signature
      || !verify(null, Buffer.from(encoded), key, Buffer.from(signature, 'base64url'))) return null
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)
      || Object.keys(claims).length !== CLAIM_KEYS.length || CLAIM_KEYS.some(name => !(name in claims))) return null
    const ok = claims.v === 1 && claims.type === SETUP_TOKEN_BINDING_TYPE
      && claims.aud === `${SETUP_TOKEN_BINDING_TYPE}@${input.origin}` && claims.keyId === input.publicKey.keyId
      && [claims.companyId, claims.groupScope, claims.userId, claims.machineId].every(value => typeof value === 'string' && ID.test(value))
      && claims.machineId === input.machineId
      && typeof claims.managedAccountId === 'string' && UUID.test(claims.managedAccountId)
      && typeof claims.nonce === 'string' && UUID.test(claims.nonce)
      && integer(claims.credentialGeneration) && integer(claims.issuedAt) && integer(claims.expiresAt)
      && Number(claims.expiresAt) > Number(claims.issuedAt) && Number(claims.expiresAt) - Number(claims.issuedAt) <= MAX_LIFETIME_MS
      && input.now >= Number(claims.issuedAt) - MAX_CLOCK_SKEW_MS && input.now < Number(claims.expiresAt)
    return ok ? claims as SetupTokenBindingClaims : null
  } catch { return null }
}

/** Reads at most `limit` bytes and cancels the stream beyond that, so a hostile body is never buffered. */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<string | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel().catch(() => {}); return null }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

const wellFormedEnvelope = (envelope: unknown): envelope is string =>
  typeof envelope === 'string' && envelope.length <= MAX_ENVELOPE && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(envelope)

async function fetchStudioPublicKey(origin: string, fetcher: typeof fetch): Promise<StudioPublicKey | null> {
  try {
    const response = await fetcher(`${origin}${STUDIO_PUBLIC_KEY_PATH}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' },
    })
    if (response.status !== 200 || !response.body) return null
    const text = await readBounded(response.body, MAX_KEY_RESPONSE)
    if (text === null) return null
    const value = JSON.parse(text) as Record<string, unknown>
    if (value?.version !== 1 || value.algorithm !== 'Ed25519' || typeof value.keyId !== 'string' || typeof value.publicKeyBase64 !== 'string') return null
    const spki = Buffer.from(value.publicKeyBase64, 'base64')
    if (createPublicKey({ key: spki, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519' || keyIdOf(spki) !== value.keyId) return null
    return { keyId: value.keyId, publicKeyBase64: value.publicKeyBase64 }
  } catch { return null }
}

/** Verifier bound to this daemon's trusted origin and machine. Replay is the caller's (durable) concern. */
export function createSetupTokenBindingVerifier(config: { origin: string; machineId: string; now?: () => number; fetch?: typeof fetch }) {
  const now = config.now ?? Date.now
  const fetcher = config.fetch ?? fetch
  let cached: { key: StudioPublicKey; fetchedAt: number } | null = null
  async function key(refresh = false) {
    if (!refresh && cached && now() - cached.fetchedAt < KEY_CACHE_MS) return cached.key
    const fetched = await fetchStudioPublicKey(config.origin, fetcher)
    cached = fetched ? { key: fetched, fetchedAt: now() } : null
    return fetched
  }
  return {
    async available() { return (await key()) !== null },
    async verify(envelope: string): Promise<SetupTokenBindingClaims | null> {
      // Size and shape first: a malformed envelope never triggers parsing or a key fetch.
      if (!wellFormedEnvelope(envelope)) return null
      let current = await key()
      if (!current) return null
      // A rotated signing key shows up as a different keyId; refetch once, never trust the envelope's key.
      const claimedKeyId = (() => { try { return JSON.parse(Buffer.from(envelope.split('.')[0] ?? '', 'base64url').toString('utf8'))?.keyId } catch { return null } })()
      if (claimedKeyId !== current.keyId) current = await key(true)
      if (!current) return null
      return verifySetupTokenBindingGrant({ envelope, publicKey: current, origin: config.origin, machineId: config.machineId, now: now() })
    },
  }
}
export type SetupTokenBindingVerifier = ReturnType<typeof createSetupTokenBindingVerifier>
