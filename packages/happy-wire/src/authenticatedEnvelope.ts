import nacl from 'tweetnacl';
import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — a data key boxed
 * to a recipient by a sender the envelope names and authenticates.
 *
 * The anonymous envelopes before it (v1 automation and follow-up, v2 script
 * values) box the key with a throwaway sender key, so anyone who knows the
 * recipient's public key can make one, and the recipient cannot tell who did.
 * Here the sender's long-term X25519 key does the boxing: NaCl box is
 * Diffie-Hellman authenticated, so only the holder of that sender's secret
 * key, or of the recipient's, can produce a box that opens under the sender
 * key the envelope names. Which senders to trust is the recipient's decision.
 *
 * The box also carries a binding of the payload ciphertext and its kind. A
 * data key is no secret from every reader of the payload, so without it the
 * key from a genuine envelope would authorise any ciphertext made with it.
 *
 * Layout, 137 bytes: 0x03 | sender public key (32) | nonce (24) | box(key (32) | binding (32)).
 */
export const AUTHENTICATED_ENVELOPE_VERSION = 3;
export const AUTHENTICATED_ENVELOPE_BYTES = 1 + 32 + 24 + 64 + nacl.box.overheadLength;

export const AUTHENTICATED_ENVELOPE_KINDS = [
  'automation',
  'session-followup',
  'script-artifact',
  'script-configuration',
  'script-input',
] as const;
export type AuthenticatedEnvelopeKind = (typeof AUTHENTICATED_ENVELOPE_KINDS)[number];

export type AuthenticatedEnvelopeOpening =
  | { ok: true; key: Uint8Array; binding: Uint8Array; senderPublicKey: Uint8Array }
  /** malformed: not an authenticated envelope at all. unauthenticated: it does not open as from the sender it names. */
  | { ok: false; reason: 'malformed' | 'unauthenticated' };

const DOMAIN = new TextEncoder().encode('happy authenticated envelope v3');

/** SHA-512 of the domain, the kind and the ciphertext, cut to 32 bytes. */
export function authenticatedEnvelopeBinding(input: { kind: AuthenticatedEnvelopeKind; ciphertext: Uint8Array }): Uint8Array {
  if (!(AUTHENTICATED_ENVELOPE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error('AUTHENTICATED_ENVELOPE_KIND_UNKNOWN');
  }
  const kind = new TextEncoder().encode(input.kind);
  const message = new Uint8Array(DOMAIN.length + 1 + kind.length + 1 + input.ciphertext.length);
  message.set(DOMAIN, 0);
  message.set(kind, DOMAIN.length + 1);
  message.set(input.ciphertext, DOMAIN.length + 1 + kind.length + 1);
  return nacl.hash(message).slice(0, 32);
}

export function sealAuthenticatedEnvelope(input: {
  key: Uint8Array;
  binding: Uint8Array;
  recipientPublicKey: Uint8Array;
  sender: { publicKey: Uint8Array; secretKey: Uint8Array };
}): Uint8Array {
  const { key, binding, recipientPublicKey, sender } = input;
  if (key.length !== 32 || binding.length !== 32 || recipientPublicKey.length !== 32
    || sender.publicKey.length !== 32 || sender.secretKey.length !== 32
    || !sameBytes(nacl.box.keyPair.fromSecretKey(sender.secretKey).publicKey, sender.publicKey)) {
    throw new Error('AUTHENTICATED_ENVELOPE_INVALID_INPUT');
  }
  const plaintext = new Uint8Array(64);
  plaintext.set(key, 0);
  plaintext.set(binding, 32);
  try {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const envelope = new Uint8Array(AUTHENTICATED_ENVELOPE_BYTES);
    envelope[0] = AUTHENTICATED_ENVELOPE_VERSION;
    envelope.set(sender.publicKey, 1);
    envelope.set(nonce, 33);
    envelope.set(nacl.box(plaintext, nonce, recipientPublicKey, sender.secretKey), 57);
    return envelope;
  } finally {
    plaintext.fill(0);
  }
}

export function openAuthenticatedEnvelope(input: {
  envelope: Uint8Array;
  recipientSecretKey: Uint8Array;
}): AuthenticatedEnvelopeOpening {
  const { envelope } = input;
  if (envelope.length !== AUTHENTICATED_ENVELOPE_BYTES || envelope[0] !== AUTHENTICATED_ENVELOPE_VERSION
    || input.recipientSecretKey.length !== 32) {
    return { ok: false, reason: 'malformed' };
  }
  const senderPublicKey = envelope.slice(1, 33);
  const opened = nacl.box.open(envelope.subarray(57), envelope.subarray(33, 57), senderPublicKey, input.recipientSecretKey);
  if (!opened || opened.length !== 64) return { ok: false, reason: 'unauthenticated' };
  try {
    return { ok: true, key: opened.slice(0, 32), binding: opened.slice(32), senderPublicKey };
  } finally {
    opened.fill(0);
  }
}

const publicKey32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

/**
 * What a daemon publishes in its machine metadata, which is encrypted with the
 * machine key, so a server without that key can neither read nor forge it.
 * A client seals with a sender only when this is present, only to
 * `automationPublicKey` (a different target key from the server is refused,
 * R15), and only with the secret key of `trustedSenderPublicKey`.
 */
export const authenticatedEnvelopesCapabilitySchema = z.object({
  version: z.literal(1),
  automationPublicKey: publicKey32,
  /** The account or company key the daemon's machine key is wrapped to. */
  trustedSenderPublicKey: publicKey32,
});
export type AuthenticatedEnvelopesCapability = z.infer<typeof authenticatedEnvelopesCapabilitySchema>;

/** How a daemon's copy of a payload was sealed: by a sender it can name, or by anyone. */
export type MachinePayloadAuthentication =
  | { kind: 'authenticated'; senderPublicKey: Uint8Array }
  | { kind: 'anonymous' };

export type MachinePayloadOpening<T> =
  | { ok: true; payload: T; authentication: MachinePayloadAuthentication }
  /** binding-mismatch: a genuine envelope presented with a ciphertext it was not sealed for. */
  | { ok: false; reason: 'malformed' | 'unauthenticated' | 'binding-mismatch' };

/**
 * Opens the data key of a machine envelope of either kind: a v3 one, whose
 * binding must match `ciphertext`, or the anonymous envelope of the payload's
 * family, which `openAnonymous` opens (version byte included).
 */
export function openMachineDataKey(input: {
  kind: AuthenticatedEnvelopeKind;
  envelope: Uint8Array;
  ciphertext: Uint8Array;
  recipientSecretKey: Uint8Array;
  openAnonymous: (envelope: Uint8Array) => Uint8Array | null;
}):
  | { ok: true; key: Uint8Array; authentication: MachinePayloadAuthentication }
  | { ok: false; reason: 'malformed' | 'unauthenticated' | 'binding-mismatch' } {
  if (input.envelope[0] === AUTHENTICATED_ENVELOPE_VERSION) {
    const opened = openAuthenticatedEnvelope({ envelope: input.envelope, recipientSecretKey: input.recipientSecretKey });
    if (!opened.ok) return opened;
    if (!sameBytes(opened.binding, authenticatedEnvelopeBinding({ kind: input.kind, ciphertext: input.ciphertext }))) {
      opened.key.fill(0);
      return { ok: false, reason: 'binding-mismatch' };
    }
    return { ok: true, key: opened.key, authentication: { kind: 'authenticated', senderPublicKey: opened.senderPublicKey } };
  }
  const key = input.openAnonymous(input.envelope);
  if (!key || key.length !== 32) return { ok: false, reason: 'malformed' };
  return { ok: true, key, authentication: { kind: 'anonymous' } };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}
