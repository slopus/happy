/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — a data key boxed by
 * a sender the envelope names and authenticates.
 */
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_ENVELOPE_BYTES,
  authenticatedEnvelopeBinding,
  openAuthenticatedEnvelope,
  sealAuthenticatedEnvelope,
} from './authenticatedEnvelope';

const machine = nacl.box.keyPair();
const company = nacl.box.keyPair();
const key = nacl.randomBytes(32);
const ciphertext = nacl.randomBytes(80);
const binding = authenticatedEnvelopeBinding({ kind: 'automation', ciphertext });

describe('sealAuthenticatedEnvelope / openAuthenticatedEnvelope', () => {
  it('opens to the key, the binding and the sender that sealed it', () => {
    const envelope = sealAuthenticatedEnvelope({ key, binding, recipientPublicKey: machine.publicKey, sender: company });

    expect(envelope).toHaveLength(AUTHENTICATED_ENVELOPE_BYTES);
    expect(envelope[0]).toBe(3);
    expect(envelope.subarray(1, 33)).toEqual(company.publicKey);
    expect(openAuthenticatedEnvelope({ envelope, recipientSecretKey: machine.secretKey })).toEqual({
      ok: true, key, binding, senderPublicKey: company.publicKey,
    });
  });

  it('refuses an envelope that names a sender whose secret key did not seal it', () => {
    // What a party that knows only the trusted public key can produce.
    const forger = nacl.box.keyPair();
    const envelope = sealAuthenticatedEnvelope({ key, binding, recipientPublicKey: machine.publicKey, sender: forger });
    envelope.set(company.publicKey, 1);

    expect(openAuthenticatedEnvelope({ envelope, recipientSecretKey: machine.secretKey })).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuses an envelope for another recipient or with any byte changed', () => {
    const envelope = sealAuthenticatedEnvelope({ key, binding, recipientPublicKey: machine.publicKey, sender: company });

    expect(openAuthenticatedEnvelope({ envelope, recipientSecretKey: nacl.box.keyPair().secretKey }))
      .toEqual({ ok: false, reason: 'unauthenticated' });
    for (const index of [33, 57, AUTHENTICATED_ENVELOPE_BYTES - 1]) {
      const changed = envelope.slice();
      changed[index] ^= 1;
      expect(openAuthenticatedEnvelope({ envelope: changed, recipientSecretKey: machine.secretKey }), `byte ${index}`)
        .toEqual({ ok: false, reason: 'unauthenticated' });
    }
  });

  it('tells an anonymous or malformed envelope apart from a forged one', () => {
    const anonymous = new Uint8Array(105);
    anonymous[0] = 1;
    const truncated = sealAuthenticatedEnvelope({ key, binding, recipientPublicKey: machine.publicKey, sender: company }).subarray(0, 100);

    expect(openAuthenticatedEnvelope({ envelope: anonymous, recipientSecretKey: machine.secretKey })).toEqual({ ok: false, reason: 'malformed' });
    expect(openAuthenticatedEnvelope({ envelope: truncated, recipientSecretKey: machine.secretKey })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses to seal keys of the wrong size', () => {
    expect(() => sealAuthenticatedEnvelope({ key: key.subarray(1), binding, recipientPublicKey: machine.publicKey, sender: company })).toThrow();
    expect(() => sealAuthenticatedEnvelope({ key, binding: binding.subarray(1), recipientPublicKey: machine.publicKey, sender: company })).toThrow();
    expect(() => sealAuthenticatedEnvelope({ key, binding, recipientPublicKey: machine.publicKey.subarray(1), sender: company })).toThrow();
  });
});

describe('authenticatedEnvelopeBinding', () => {
  it('is 32 bytes and changes with the kind and with every ciphertext byte', () => {
    expect(binding).toHaveLength(32);
    expect(authenticatedEnvelopeBinding({ kind: 'automation', ciphertext })).toEqual(binding);
    expect(authenticatedEnvelopeBinding({ kind: 'session-followup', ciphertext })).not.toEqual(binding);
    const changed = ciphertext.slice();
    changed[changed.length - 1] ^= 1;
    expect(authenticatedEnvelopeBinding({ kind: 'automation', ciphertext: changed })).not.toEqual(binding);
  });

  it('accepts only known kinds', () => {
    expect(() => authenticatedEnvelopeBinding({ kind: 'anything' as never, ciphertext })).toThrow();
  });
});
