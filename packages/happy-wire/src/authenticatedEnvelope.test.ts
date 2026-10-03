/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — a data key boxed by
 * a sender the envelope names and authenticates.
 */
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_ENVELOPE_BYTES,
  authenticatedEnvelopesCapabilitySchema,
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

  // A wire contract: web and desktop mirror this function and pin the same vectors.
  it('matches the published vectors', () => {
    const vector = Uint8Array.from({ length: 40 }, (_, index) => index);
    const hex = (kind: Parameters<typeof authenticatedEnvelopeBinding>[0]['kind']) => (
      Buffer.from(authenticatedEnvelopeBinding({ kind, ciphertext: vector })).toString('hex')
    );
    expect(hex('automation')).toBe('0202c961ff20c8eadec9603986251c586a43d33a25d41fa235681b5aee652422');
    expect(hex('session-followup')).toBe('b2f841363adf8fcc70af6b95a63aeb6c2740c3f02ac85ff60eb9ca35422228cc');
    expect(hex('script-configuration')).toBe('6b5a689addb042fbbd96ffc30bfb26021fbc0b41c7a9857fc6003dde0cd24eb1');
    expect(hex('script-artifact')).toBe('65efca813263a355a04e93cd3c3680c908b57b7ead14bb544ce92e21fcde9057');
  });

  it('accepts only known kinds', () => {
    expect(() => authenticatedEnvelopeBinding({ kind: 'anything' as never, ciphertext })).toThrow();
  });
});

describe('authenticatedEnvelopesCapabilitySchema', () => {
  const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

  it('carries the automation key to seal to and the sender the daemon trusts', () => {
    const capability = { version: 1, automationPublicKey: key(1), trustedSenderPublicKey: key(2) };
    expect(authenticatedEnvelopesCapabilitySchema.parse(capability)).toEqual(capability);
  });

  // aplus-dev-studio specs/e2ee-machine-control-boundary R13 — a strict daemon refuses
  // anonymous payloads, so a client without the trusted key must not fall back to one.
  it('says whether the daemon refuses anonymous payloads', () => {
    const capability = { version: 1, automationPublicKey: key(1), trustedSenderPublicKey: key(2), required: true };
    expect(authenticatedEnvelopesCapabilitySchema.parse(capability)).toEqual(capability);
    expect(authenticatedEnvelopesCapabilitySchema.safeParse({ ...capability, required: 'yes' }).success).toBe(false);
  });

  it('rejects keys that are not 32 bytes and unknown versions', () => {
    expect(authenticatedEnvelopesCapabilitySchema.safeParse({ version: 1, automationPublicKey: Buffer.alloc(31).toString('base64'), trustedSenderPublicKey: key(2) }).success).toBe(false);
    expect(authenticatedEnvelopesCapabilitySchema.safeParse({ version: 2, automationPublicKey: key(1), trustedSenderPublicKey: key(2) }).success).toBe(false);
  });
});
