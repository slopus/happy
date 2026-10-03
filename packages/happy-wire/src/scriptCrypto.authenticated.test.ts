/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R12 — script settings and
 * artifacts sealed by a customer key (or, for the agent tool, the machine's own).
 */
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  decryptScriptValue,
  encryptScriptValue,
  openScriptValueForMachine,
  scriptEncryptedValueSchema,
  type ScriptCryptoContext,
} from './scriptCrypto';

const company = nacl.box.keyPair();
const machine = nacl.box.keyPair();
const viewer = nacl.box.keyPair();
const context: ScriptCryptoContext = { projectId: 'project-1', resourceId: 'scr_1', purpose: 'configuration' };
const value = { entrypoint: 'run.ts', schedule: null };

const seal = (sender?: { publicKey: Uint8Array; secretKey: Uint8Array }, purpose: ScriptCryptoContext['purpose'] = 'configuration') => encryptScriptValue({
  value,
  context: { ...context, purpose },
  viewerPublicKey: viewer.publicKey,
  machinePublicKey: machine.publicKey,
  ...(sender ? { sender } : {}),
});

describe('script values sealed by a sender', () => {
  it('give the machine a v3 envelope and the viewer the same anonymous one as before', () => {
    const encrypted = seal(company);

    expect(scriptEncryptedValueSchema.safeParse(encrypted).success).toBe(true);
    expect(Buffer.from(encrypted.machineKeyEnvelope, 'base64')[0]).toBe(3);
    expect(Buffer.from(encrypted.viewerKeyEnvelope, 'base64')).toHaveLength(105);
    expect(decryptScriptValue({ encrypted, context, recipient: 'viewer', secretKey: viewer.secretKey })).toEqual(value);
    expect(openScriptValueForMachine({ encrypted, context, secretKey: machine.secretKey })).toEqual({
      ok: true, payload: value, authentication: { kind: 'authenticated', senderPublicKey: company.publicKey },
    });
  });

  it('still open anonymously sealed values, and say so', () => {
    expect(openScriptValueForMachine({ encrypted: seal(), context, secretKey: machine.secretKey }))
      .toEqual({ ok: true, payload: value, authentication: { kind: 'anonymous' } });
  });

  it('refuse another value under a genuine envelope', () => {
    const encrypted = seal(company);
    const viewerEnvelope = Buffer.from(encrypted.viewerKeyEnvelope, 'base64');
    const key = nacl.box.open(viewerEnvelope.subarray(57), viewerEnvelope.subarray(33, 57), viewerEnvelope.subarray(1, 33), viewer.secretKey)!;
    const nonce = nacl.randomBytes(24);
    const swapped = new TextEncoder().encode(JSON.stringify({ context, value: { entrypoint: 'steal.ts', schedule: null } }));
    const ciphertext = Buffer.from([2, ...nonce, ...nacl.secretbox(swapped, nonce, key)]).toString('base64');

    expect(openScriptValueForMachine({ encrypted: { ...encrypted, ciphertext }, context, secretKey: machine.secretKey }))
      .toEqual({ ok: false, reason: 'binding-mismatch' });
  });

  it('bind the purpose, so a sealed artifact does not pass as configuration', () => {
    const artifact = seal(company, 'artifact');

    expect(openScriptValueForMachine({ encrypted: artifact, context, secretKey: machine.secretKey }))
      .toEqual({ ok: false, reason: 'binding-mismatch' });
  });

  it('refuse a value sealed for another resource', () => {
    expect(openScriptValueForMachine({ encrypted: seal(company), context: { ...context, resourceId: 'scr_2' }, secretKey: machine.secretKey }))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('are never sealed by a sender for a log, which only the daemon writes', () => {
    expect(() => seal(company, 'log')).toThrow('SCRIPT_ENCRYPT_FAILED');
  });
});
