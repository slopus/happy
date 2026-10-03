import nacl from 'tweetnacl';
import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R20–R22 — a customer's
 * statement that a machine key belongs to its machine.
 *
 * A client trusts a machine key envelope because it opens with the customer's
 * account or company key. Those envelopes are anonymous boxes, though, so the
 * server can seal a key of its own to the real company public key, and the
 * client would use it. An attestation closes that: after a person compares the
 * fingerprint `happy datakey status` prints on the machine with the one the
 * client shows, the client boxes `{machineId, keyDigest, attestedAt}` from the
 * customer key pair to itself. Only a holder of that secret key can make or
 * open such a box, so the server can store the attestation but not forge one.
 *
 * Layout: 0x01 | attester public key (32) | nonce (24) | box(JSON statement).
 * Hashing is tweetnacl's SHA-512, as in the v3 envelope binding, so every
 * client computes the same digest synchronously.
 */
export const MACHINE_KEY_ATTESTATION_VERSION = 1;

const DIGEST_DOMAIN = new TextEncoder().encode('happy machine key fingerprint v1');
const HEADER_BYTES = 1 + nacl.box.publicKeyLength + nacl.box.nonceLength;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const statementSchema = z.object({
  v: z.literal(MACHINE_KEY_ATTESTATION_VERSION),
  machineId: z.string().min(1).max(256),
  keyDigest: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  attestedAt: z.number().int().nonnegative(),
}).strict();

/** SHA-512 over the domain, the machine id and the key, first 32 bytes: the key bound to its machine. */
export function machineKeyDigest(machineId: string, machineKey: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(machineId);
  const input = new Uint8Array(DIGEST_DOMAIN.length + 1 + id.length + 1 + machineKey.length);
  input.set(DIGEST_DOMAIN, 0);
  input.set(id, DIGEST_DOMAIN.length + 1);
  input.set(machineKey, DIGEST_DOMAIN.length + 1 + id.length + 1);
  return nacl.hash(input).subarray(0, 32);
}

/** What a person compares: the digest's first 100 bits, RFC 4648 base32, five groups of four. */
export function machineKeyFingerprint(machineId: string, machineKey: Uint8Array): string {
  const digest = machineKeyDigest(machineId, machineKey);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest.subarray(0, 13)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Boxes the statement from the attester key pair to itself. */
export function sealMachineKeyAttestation(input: {
  machineId: string;
  machineKey: Uint8Array;
  attester: { publicKey: Uint8Array; secretKey: Uint8Array };
  attestedAt: number;
}): Uint8Array {
  const statement = {
    v: MACHINE_KEY_ATTESTATION_VERSION,
    machineId: input.machineId,
    keyDigest: toBase64(machineKeyDigest(input.machineId, input.machineKey)),
    attestedAt: input.attestedAt,
  };
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(new TextEncoder().encode(JSON.stringify(statement)), nonce, input.attester.publicKey, input.attester.secretKey);
  const out = new Uint8Array(HEADER_BYTES + boxed.length);
  out[0] = MACHINE_KEY_ATTESTATION_VERSION;
  out.set(input.attester.publicKey, 1);
  out.set(nonce, 1 + nacl.box.publicKeyLength);
  out.set(boxed, HEADER_BYTES);
  return out;
}

export type MachineKeyAttestationCheck =
  /** Opened by a key this client holds, for this machine and this key. */
  | { status: 'verified'; attesterPublicKey: Uint8Array; attestedAt: number }
  /** No attestation is stored. */
  | { status: 'unverified' }
  /** Made by a key this client does not hold, so it cannot tell either way. */
  | { status: 'unverifiable'; attesterPublicKey: Uint8Array }
  /** Malformed, not boxed by the key it names, or for another machine or key. */
  | { status: 'mismatch' };

export function checkMachineKeyAttestation(input: {
  attestation: Uint8Array | null | undefined;
  machineId: string;
  machineKey: Uint8Array;
  /** The account secret key and every company key generation this client holds. */
  candidates: ReadonlyArray<Uint8Array | null | undefined>;
}): MachineKeyAttestationCheck {
  const attestation = input.attestation;
  if (!attestation || attestation.length === 0) return { status: 'unverified' };
  if (attestation.length <= HEADER_BYTES + nacl.box.overheadLength || attestation[0] !== MACHINE_KEY_ATTESTATION_VERSION) {
    return { status: 'mismatch' };
  }
  const attesterPublicKey = attestation.slice(1, 1 + nacl.box.publicKeyLength);
  const secretKey = input.candidates.find((candidate): candidate is Uint8Array => !!candidate
    && candidate.length === nacl.box.secretKeyLength
    && nacl.verify(nacl.box.keyPair.fromSecretKey(candidate).publicKey, attesterPublicKey));
  if (!secretKey) return { status: 'unverifiable', attesterPublicKey };
  const nonce = attestation.subarray(1 + nacl.box.publicKeyLength, HEADER_BYTES);
  const opened = nacl.box.open(attestation.subarray(HEADER_BYTES), nonce, attesterPublicKey, secretKey);
  if (!opened) return { status: 'mismatch' };
  let statement: z.infer<typeof statementSchema>;
  try {
    statement = statementSchema.parse(JSON.parse(new TextDecoder().decode(opened)));
  } catch {
    return { status: 'mismatch' };
  }
  const expected = toBase64(machineKeyDigest(input.machineId, input.machineKey));
  if (statement.machineId !== input.machineId || statement.keyDigest !== expected) return { status: 'mismatch' };
  return { status: 'verified', attesterPublicKey, attestedAt: statement.attestedAt };
}

/**
 * R22 — whether a client uses the machine key, and what it remembers. A client
 * pins the digest of a key it verified. It keeps using that key when the
 * attestation later disappears, and refuses any other key for the machine
 * until a new attestation verifies it. A never-verified key is used but
 * reported as unverified.
 */
export function machineKeyTrust(input: {
  check: MachineKeyAttestationCheck;
  /** `machineKeyDigest` of the key the envelope opened to, base64. */
  digest: string;
  pinnedDigest: string | null;
}): { use: boolean; state: 'verified' | 'unverified' | 'changed' | 'mismatch'; pin: string | null } {
  if (input.check.status === 'verified') return { use: true, state: 'verified', pin: input.digest };
  if (input.check.status === 'mismatch') return { use: false, state: 'mismatch', pin: input.pinnedDigest };
  if (input.pinnedDigest === input.digest) return { use: true, state: 'verified', pin: input.digest };
  if (input.pinnedDigest) return { use: false, state: 'changed', pin: input.pinnedDigest };
  return { use: true, state: 'unverified', pin: null };
}
