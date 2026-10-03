import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SETUP_TOKEN_BINDING_TYPE,
  createSetupTokenBindingVerifier,
  readTrustedStudioOrigin,
  verifySetupTokenBindingGrant,
} from './setupTokenBindingProof'

// Synthetic keys only. The envelope format mirrors the Studio collector signer:
// base64url(JSON claims) "." base64url(Ed25519 signature over the first part).
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return { privateKey, publicKeyBase64: spki.toString('base64'), keyId: createHash('sha256').update(spki).digest('hex') }
}
function mint(privateKey: KeyObject, claims: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`
}
const ORIGIN = 'https://studio.example.test'
const NOW = 1_800_000_000_000
const key = keyPair()
function claims(overrides: Record<string, unknown> = {}) {
  return { v: 1, type: SETUP_TOKEN_BINDING_TYPE, aud: `${SETUP_TOKEN_BINDING_TYPE}@${ORIGIN}`, keyId: key.keyId,
    companyId: 'company-1', groupScope: 'company-1', userId: 'user-1', machineId: 'machine-1',
    managedAccountId: '0b6f2c1e-1111-4a2b-8c3d-000000000001', credentialGeneration: 2,
    nonce: '6a1f7d3e-2222-4b2b-8c3d-000000000009', issuedAt: NOW - 1_000, expiresAt: NOW + 59_000, ...overrides }
}
const verify = (envelope: string, overrides: Partial<Parameters<typeof verifySetupTokenBindingGrant>[0]> = {}) =>
  verifySetupTokenBindingGrant({ envelope, publicKey: { keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 }, origin: ORIGIN, machineId: 'machine-1', now: NOW, ...overrides })

describe('verifySetupTokenBindingGrant', () => {
  it('accepts a correctly signed, unexpired grant for this machine and audience', () => {
    expect(verify(mint(key.privateKey, claims()))).toEqual(claims())
  })

  it.each([
    ['collector type', { type: 'claude-collector-v1' }],
    ['collector audience', { aud: `claude-collector-v1@${ORIGIN}` }],
    ['another origin', { aud: `${SETUP_TOKEN_BINDING_TYPE}@https://evil.example.test` }],
    ['another machine', { machineId: 'machine-2' }],
    ['another key id', { keyId: 'f'.repeat(64) }],
    ['an expired grant', { expiresAt: NOW }],
    ['a grant issued in the future', { issuedAt: NOW + 120_000, expiresAt: NOW + 150_000 }],
    ['a lifetime above the 60 s server contract', { issuedAt: NOW - 1_000, expiresAt: NOW + 59_001 }],
    ['a non-integer generation', { credentialGeneration: 1.5 }],
    ['a non-uuid nonce', { nonce: 'n-1' }],
    ['a non-uuid account', { managedAccountId: 'acct' }],
    ['an unknown extra claim', { admin: true }],
    ['version 2', { v: 2 }],
  ])('rejects %s', (_label, overrides) => {
    expect(verify(mint(key.privateKey, claims(overrides)))).toBeNull()
  })

  it('accepts exactly the 60 s server lifetime', () => {
    expect(verify(mint(key.privateKey, claims({ issuedAt: NOW - 30_000, expiresAt: NOW + 30_000 })))).not.toBeNull()
  })

  it('rejects a tampered payload, another signer, and malformed envelopes', () => {
    const good = mint(key.privateKey, claims())
    const forgedPayload = Buffer.from(JSON.stringify(claims({ userId: 'user-2' }))).toString('base64url')
    expect(verify(`${forgedPayload}.${good.split('.')[1]}`)).toBeNull()
    expect(verify(mint(keyPair().privateKey, claims()))).toBeNull()
    for (const bad of ['', 'a', 'a.b.c', `${good}x!`, 'x'.repeat(5000)]) expect(verify(bad)).toBeNull()
  })
})

describe('readTrustedStudioOrigin', () => {
  it('accepts only a bare https origin (or http loopback) from the daemon environment', () => {
    expect(readTrustedStudioOrigin({ HAPPY_APLUS_STUDIO_ORIGIN: 'https://studio.example.test' })).toBe('https://studio.example.test')
    expect(readTrustedStudioOrigin({ HAPPY_APLUS_STUDIO_ORIGIN: 'http://127.0.0.1:3000' })).toBe('http://127.0.0.1:3000')
    for (const bad of [undefined, '', 'http://studio.example.test', 'https://u:p@studio.example.test', 'https://studio.example.test/api', 'ftp://x']) {
      expect(readTrustedStudioOrigin({ HAPPY_APLUS_STUDIO_ORIGIN: bad })).toBeNull()
    }
  })
})

describe('createSetupTokenBindingVerifier (real HTTP boundary)', () => {
  let server: Server | undefined
  afterEach(async () => { await new Promise(resolve => server ? server.close(resolve) : resolve(undefined)); server = undefined })
  async function serve(handler: (path: string) => { status?: number; headers?: Record<string, string>; body: string }) {
    const hits: string[] = []
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      const reply = handler(req.url ?? '')
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
      res.end(reply.body)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
  }
  const metadata = (k = key) => JSON.stringify({ version: 1, type: 'claude-collector-v1', algorithm: 'Ed25519', keyId: k.keyId, publicKeyBase64: k.publicKeyBase64, audience: 'ignored' })

  it('fetches the key from the fixed public-key path of the trusted origin and verifies', async () => {
    const { origin, hits } = await serve(() => ({ body: metadata() }))
    const verifier = createSetupTokenBindingVerifier({ origin, machineId: 'machine-1', now: () => NOW })
    const grant = mint(key.privateKey, claims({ aud: `${SETUP_TOKEN_BINDING_TYPE}@${origin}` }))
    expect(await verifier.verify(grant)).toMatchObject({ userId: 'user-1', credentialGeneration: 2 })
    expect(await verifier.verify(grant)).not.toBeNull()
    expect(hits).toEqual(['/api/claude-collector/public-key'])
    expect(await verifier.available()).toBe(true)
  })

  it('refetches once on a rotated key id and rejects a key whose id does not match its bytes', async () => {
    const rotated = keyPair()
    let current = key
    const { origin, hits } = await serve(() => ({ body: metadata(current) }))
    const verifier = createSetupTokenBindingVerifier({ origin, machineId: 'machine-1', now: () => NOW })
    expect(await verifier.available()).toBe(true)
    current = rotated
    const grant = mint(rotated.privateKey, claims({ aud: `${SETUP_TOKEN_BINDING_TYPE}@${origin}`, keyId: rotated.keyId }))
    expect(await verifier.verify(grant)).not.toBeNull()
    expect(hits).toHaveLength(2)

    const lying = await serve(() => ({ body: JSON.stringify({ ...JSON.parse(metadata()), keyId: rotated.keyId }) }))
    const strict = createSetupTokenBindingVerifier({ origin: lying.origin, machineId: 'machine-1', now: () => NOW })
    expect(await strict.available()).toBe(false)
  })

  it('rejects an oversized or malformed envelope before parsing it or fetching any key', async () => {
    const { origin, hits } = await serve(() => ({ body: metadata() }))
    const verifier = createSetupTokenBindingVerifier({ origin, machineId: 'machine-1', now: () => NOW })
    for (const bad of ['x'.repeat(4097) + '.y', 'no-dot', 'a.b.c', 'a!.b']) expect(await verifier.verify(bad)).toBeNull()
    expect(hits).toEqual([])
  })

  it('stops reading a streamed key response past the cap instead of buffering it', async () => {
    let written = 0
    let aborted = false
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // No content-length: a chunked stream that would run to 8 MiB if fully consumed.
      const chunk = Buffer.alloc(64 * 1024, 0x20)
      const pump = () => { while (written < 8 * 1024 * 1024) { written += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return } } res.end() }
      res.on('close', () => { aborted = written < 8 * 1024 * 1024 })
      pump()
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const verifier = createSetupTokenBindingVerifier({ origin, machineId: 'machine-1', now: () => NOW })
    expect(await verifier.available()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(aborted).toBe(true)
  })

  it.each([
    ['a redirect', () => ({ status: 302, headers: { location: 'https://evil.example.test/key' }, body: '' })],
    ['a server error', () => ({ status: 503, body: '{}' })],
    ['an oversized body', () => ({ body: 'x'.repeat(20_000) })],
    ['a non-Ed25519 algorithm', () => ({ body: JSON.stringify({ ...JSON.parse(metadata()), algorithm: 'RS256' }) })],
  ])('fails closed on %s', async (_label, reply) => {
    const { origin } = await serve(reply)
    const verifier = createSetupTokenBindingVerifier({ origin, machineId: 'machine-1', now: () => NOW })
    expect(await verifier.available()).toBe(false)
    expect(await verifier.verify(mint(key.privateKey, claims({ aud: `${SETUP_TOKEN_BINDING_TYPE}@${origin}` })))).toBeNull()
  })
})
