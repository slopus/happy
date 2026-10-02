/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R13/R14 — which
 * client-sealed payloads a daemon acts on.
 */
import { describe, expect, it } from 'vitest'
import tweetnacl from 'tweetnacl'
import type { MachinePayloadOpening } from '@slopus/happy-wire'
import { judgePayload, type PayloadTrust } from './payloadTrust'

const customer = tweetnacl.box.keyPair().publicKey
const machineAutomation = tweetnacl.box.keyPair().publicKey
const stranger = tweetnacl.box.keyPair().publicKey
const payload = { prompt: 'p' }

const trust = (mode: 'compat' | 'strict', customerPublicKey: Uint8Array | null = customer): PayloadTrust => ({
  mode, customerPublicKey, machineAutomationPublicKey: machineAutomation,
})
const sealedBy = (senderPublicKey: Uint8Array): MachinePayloadOpening<typeof payload> => ({
  ok: true, payload, authentication: { kind: 'authenticated', senderPublicKey },
})
const anonymous: MachinePayloadOpening<typeof payload> = { ok: true, payload, authentication: { kind: 'anonymous' } }

describe('judgePayload', () => {
  it('runs a payload the customer key sealed, in either mode', () => {
    for (const mode of ['compat', 'strict'] as const) {
      expect(judgePayload({ trust: trust(mode), opening: sealedBy(customer) })).toEqual({ run: true, payload, authenticated: true })
    }
  })

  it('runs an anonymous payload in compat and says it was not authenticated', () => {
    expect(judgePayload({ trust: trust('compat'), opening: anonymous })).toEqual({ run: true, payload, authenticated: false })
  })

  it('refuses an anonymous payload in strict', () => {
    expect(judgePayload({ trust: trust('strict'), opening: anonymous })).toEqual({ run: false, code: 'PAYLOAD_SENDER_ANONYMOUS' })
  })

  it('refuses a sender it does not trust, even in compat', () => {
    for (const mode of ['compat', 'strict'] as const) {
      expect(judgePayload({ trust: trust(mode), opening: sealedBy(stranger) })).toEqual({ run: false, code: 'PAYLOAD_SENDER_UNTRUSTED' })
    }
  })

  it('trusts its own automation key only where a payload may come from this machine', () => {
    expect(judgePayload({ trust: trust('strict'), opening: sealedBy(machineAutomation) }))
      .toEqual({ run: false, code: 'PAYLOAD_SENDER_UNTRUSTED' })
    expect(judgePayload({ trust: trust('strict'), opening: sealedBy(machineAutomation), allowMachineSender: true }))
      .toEqual({ run: true, payload, authenticated: true })
  })

  it('trusts no customer key on legacy credentials', () => {
    expect(judgePayload({ trust: trust('compat', null), opening: sealedBy(customer) })).toEqual({ run: false, code: 'PAYLOAD_SENDER_UNTRUSTED' })
  })

  it('refuses a trusted sender whose sealed context does not match', () => {
    expect(judgePayload({ trust: trust('strict'), opening: sealedBy(customer), contextMatches: () => false }))
      .toEqual({ run: false, code: 'PAYLOAD_CONTEXT_MISMATCH' })
  })

  it('does not hold an anonymous payload to a context it could not have vouched for', () => {
    expect(judgePayload({ trust: trust('compat'), opening: anonymous, contextMatches: () => false }))
      .toEqual({ run: true, payload, authenticated: false })
  })

  it('names why a payload could not be opened', () => {
    expect(judgePayload({ trust: trust('compat'), opening: { ok: false, reason: 'malformed' } })).toEqual({ run: false, code: 'PAYLOAD_UNREADABLE' })
    expect(judgePayload({ trust: trust('compat'), opening: { ok: false, reason: 'unauthenticated' } })).toEqual({ run: false, code: 'PAYLOAD_FORGED' })
    expect(judgePayload({ trust: trust('compat'), opening: { ok: false, reason: 'binding-mismatch' } })).toEqual({ run: false, code: 'PAYLOAD_BINDING_MISMATCH' })
  })
})
