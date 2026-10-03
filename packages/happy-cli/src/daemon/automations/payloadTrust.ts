/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R13/R14 — which
 * client-sealed payloads (automations, session follow-ups, script settings and
 * artifacts) this daemon acts on.
 *
 * A payload sealed by a trusted sender runs in either mode. An anonymous one,
 * which anyone holding the machine's automation public key can make, runs only
 * in compat and is marked unauthenticated. A payload that claims a sender but
 * does not verify is refused in both modes: it is a forgery, not an old client.
 */
import type { MachinePayloadOpening } from '@slopus/happy-wire'

export interface PayloadTrust {
  mode: 'compat' | 'strict'
  /** The account or company key the machine key is wrapped to; null on legacy credentials, which have none of their own. */
  customerPublicKey: Uint8Array | null
  /** This daemon's automation key, a trusted sender for scripts its agent tool registers (R13). */
  machineAutomationPublicKey: Uint8Array
}

export type PayloadRefusalCode =
  | 'PAYLOAD_UNREADABLE'
  | 'PAYLOAD_FORGED'
  | 'PAYLOAD_BINDING_MISMATCH'
  | 'PAYLOAD_SENDER_UNTRUSTED'
  | 'PAYLOAD_SENDER_ANONYMOUS'
  | 'PAYLOAD_CONTEXT_MISMATCH'

export type PayloadVerdict<T> =
  | { run: true; payload: T; authenticated: boolean }
  | { run: false; code: PayloadRefusalCode }

const OPENING_REFUSALS = {
  malformed: 'PAYLOAD_UNREADABLE',
  unauthenticated: 'PAYLOAD_FORGED',
  'binding-mismatch': 'PAYLOAD_BINDING_MISMATCH',
} as const

export function judgePayload<T>(input: {
  trust: PayloadTrust
  opening: MachinePayloadOpening<T>
  /** Whether this kind of payload may come from the daemon's own automation key. */
  allowMachineSender?: boolean
  /** Checks what the sender vouched for (machine, project, session) against the record. */
  contextMatches?: (payload: T) => boolean
}): PayloadVerdict<T> {
  const { trust, opening } = input
  if (!opening.ok) return { run: false, code: OPENING_REFUSALS[opening.reason] }
  if (opening.authentication.kind === 'anonymous') {
    return trust.mode === 'strict'
      ? { run: false, code: 'PAYLOAD_SENDER_ANONYMOUS' }
      : { run: true, payload: opening.payload, authenticated: false }
  }
  const sender = opening.authentication.senderPublicKey
  const trusted = (trust.customerPublicKey !== null && sameKey(sender, trust.customerPublicKey))
    || (input.allowMachineSender === true && sameKey(sender, trust.machineAutomationPublicKey))
  if (!trusted) return { run: false, code: 'PAYLOAD_SENDER_UNTRUSTED' }
  if (input.contextMatches && !input.contextMatches(opening.payload)) return { run: false, code: 'PAYLOAD_CONTEXT_MISMATCH' }
  return { run: true, payload: opening.payload, authenticated: true }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!
  return difference === 0
}
