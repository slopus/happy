/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R20–R22 — a customer
 * attests a machine key after comparing fingerprints; clients trust only keys
 * an attestation or their own earlier verification vouches for.
 */
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  checkMachineKeyAttestation,
  machineKeyDigest,
  machineKeyFingerprint,
  machineKeyTrust,
  sealMachineKeyAttestation,
} from './machineKeyAttestation';

const machineKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const company = nacl.box.keyPair();
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

describe('machineKeyDigest / machineKeyFingerprint', () => {
  // Published values: web-ui and desktop compute the same digest and fingerprint.
  it('derives the published digest and fingerprint', () => {
    expect(hex(machineKeyDigest('machine-1', machineKey))).toBe(PUBLISHED_DIGEST_HEX);
    expect(machineKeyFingerprint('machine-1', machineKey)).toBe(PUBLISHED_FINGERPRINT);
  });

  it('names the machine as well as the key', () => {
    expect(machineKeyFingerprint('machine-1', machineKey)).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/);
    expect(machineKeyFingerprint('machine-2', machineKey)).not.toBe(machineKeyFingerprint('machine-1', machineKey));
    expect(machineKeyFingerprint('machine-1', nacl.randomBytes(32))).not.toBe(machineKeyFingerprint('machine-1', machineKey));
  });
});

describe('sealMachineKeyAttestation / checkMachineKeyAttestation', () => {
  const attestation = sealMachineKeyAttestation({ machineId: 'machine-1', machineKey, attester: company, attestedAt: 1_790_000_000_000 });

  it('verifies with the attesting key pair among the candidates', () => {
    expect(attestation[0]).toBe(1);
    expect(attestation.subarray(1, 33)).toEqual(company.publicKey);
    expect(checkMachineKeyAttestation({ attestation, machineId: 'machine-1', machineKey, candidates: [null, nacl.randomBytes(32), company.secretKey] }))
      .toEqual({ status: 'verified', attesterPublicKey: company.publicKey, attestedAt: 1_790_000_000_000 });
  });

  it('reports no attestation as unverified, and one by a key this client lacks as unverifiable', () => {
    expect(checkMachineKeyAttestation({ attestation: null, machineId: 'machine-1', machineKey, candidates: [company.secretKey] }))
      .toEqual({ status: 'unverified' });
    expect(checkMachineKeyAttestation({ attestation, machineId: 'machine-1', machineKey, candidates: [nacl.randomBytes(32)] }))
      .toEqual({ status: 'unverifiable', attesterPublicKey: company.publicKey });
  });

  it('refuses an attestation for another machine or another key', () => {
    expect(checkMachineKeyAttestation({ attestation, machineId: 'machine-2', machineKey, candidates: [company.secretKey] }))
      .toEqual({ status: 'mismatch' });
    expect(checkMachineKeyAttestation({ attestation, machineId: 'machine-1', machineKey: nacl.randomBytes(32), candidates: [company.secretKey] }))
      .toEqual({ status: 'mismatch' });
  });

  // What a server without the customer's secret key can make: a box under its own key
  // that names the customer's public key as the attester.
  it('refuses an attestation not boxed by the key it names', () => {
    const server = nacl.box.keyPair();
    const forged = sealMachineKeyAttestation({ machineId: 'machine-1', machineKey, attester: server, attestedAt: 1 });
    forged.set(company.publicKey, 1);
    expect(checkMachineKeyAttestation({ attestation: forged, machineId: 'machine-1', machineKey, candidates: [company.secretKey] }))
      .toEqual({ status: 'mismatch' });
  });

  it('refuses a changed byte, another version and a short attestation', () => {
    const changed = attestation.slice();
    changed[changed.length - 1] ^= 1;
    const otherVersion = attestation.slice();
    otherVersion[0] = 2;
    for (const value of [changed, otherVersion, attestation.subarray(0, 40)]) {
      expect(checkMachineKeyAttestation({ attestation: value, machineId: 'machine-1', machineKey, candidates: [company.secretKey] }))
        .toEqual({ status: 'mismatch' });
    }
  });
});

describe('machineKeyTrust', () => {
  const digest = 'current-digest';
  const verified = (attestedAt: number) => ({ status: 'verified', attesterPublicKey: company.publicKey, attestedAt } as const);

  it('uses and pins a verified key with the time it was attested', () => {
    expect(machineKeyTrust({ check: verified(100), digest, pinned: null })).toEqual({ use: true, state: 'verified', pin: { digest, attestedAt: 100 } });
  });

  it('never uses a key whose attestation does not match', () => {
    const pinned = { digest, attestedAt: 100 };
    expect(machineKeyTrust({ check: { status: 'mismatch' }, digest, pinned })).toEqual({ use: false, state: 'mismatch', pin: pinned });
  });

  it('keeps using the key this client verified before when the attestation is gone', () => {
    const pinned = { digest, attestedAt: 100 };
    expect(machineKeyTrust({ check: { status: 'unverified' }, digest, pinned })).toEqual({ use: true, state: 'verified', pin: pinned });
  });

  it('refuses another key for a machine this client verified before, unless a newer attestation vouches for it', () => {
    const pinned = { digest: 'earlier-digest', attestedAt: 100 };
    expect(machineKeyTrust({ check: { status: 'unverified' }, digest, pinned })).toEqual({ use: false, state: 'changed', pin: pinned });
    expect(machineKeyTrust({ check: { status: 'unverifiable', attesterPublicKey: company.publicKey }, digest, pinned }))
      .toEqual({ use: false, state: 'changed', pin: pinned });
    expect(machineKeyTrust({ check: verified(200), digest, pinned })).toEqual({ use: true, state: 'verified', pin: { digest, attestedAt: 200 } });
  });

  // The server keeps a key it knew under compat together with that key's genuine attestation.
  // After harden and a fresh attestation it serves the old pair again to roll the machine back.
  it('refuses an attestation no newer than the pinned one for another key', () => {
    const pinned = { digest: 'new-digest', attestedAt: 200 };
    for (const attestedAt of [100, 200]) {
      expect(machineKeyTrust({ check: verified(attestedAt), digest: 'old-digest', pinned }))
        .toEqual({ use: false, state: 'changed', pin: pinned });
    }
  });

  it('keeps the latest attestation time for the key it verified', () => {
    expect(machineKeyTrust({ check: verified(100), digest, pinned: { digest, attestedAt: 200 } }))
      .toEqual({ use: true, state: 'verified', pin: { digest, attestedAt: 200 } });
  });

  it('uses a never-verified key but says so', () => {
    expect(machineKeyTrust({ check: { status: 'unverified' }, digest, pinned: null })).toEqual({ use: true, state: 'unverified', pin: null });
  });
});

const PUBLISHED_DIGEST_HEX = '4b88b87610c4407b4b13b1931c4f6b86c2257ffc7923e9da659264a8953c77e3';
const PUBLISHED_FINGERPRINT = 'JOEL-Q5QQ-YRAH-WSYT-WGJR';
