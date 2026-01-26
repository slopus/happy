import type { Credentials } from '@/persistence';

import { getRandomBytes, libsodiumEncryptForPublicKey } from '../encryption';

export type EncryptionContext = {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  dataEncryptionKey: Uint8Array | null;
};

export function resolveSessionEncryptionContext(credential: Credentials): EncryptionContext {
  // Resolve encryption key
  let dataEncryptionKey: Uint8Array | null = null;
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';

  if (credential.encryption.type === 'dataKey') {
    // Generate new encryption key
    encryptionKey = getRandomBytes(32);
    encryptionVariant = 'dataKey';

    // Derive and encrypt data encryption key
    // const contentDataKey = await deriveKey(this.secret, 'Happy EnCoder', ['content']);
    // const publicKey = libsodiumPublicKeyFromSecretKey(contentDataKey);
    let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, credential.encryption.publicKey);
    dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
    dataEncryptionKey.set([0], 0); // Version byte
    dataEncryptionKey.set(encryptedDataKey, 1); // Data key
  } else {
    encryptionKey = credential.encryption.secret;
    encryptionVariant = 'legacy';
  }

  return { encryptionKey, encryptionVariant, dataEncryptionKey };
}

export function resolveMachineEncryptionContext(credential: Credentials): EncryptionContext {
  // Resolve encryption key
  let dataEncryptionKey: Uint8Array | null = null;
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';

  if (credential.encryption.type === 'dataKey') {
    // Encrypt data encryption key
    encryptionVariant = 'dataKey';
    encryptionKey = credential.encryption.machineKey;
    let encryptedDataKey = libsodiumEncryptForPublicKey(
      credential.encryption.machineKey,
      credential.encryption.publicKey
    );
    dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
    dataEncryptionKey.set([0], 0); // Version byte
    dataEncryptionKey.set(encryptedDataKey, 1); // Data key
  } else {
    // Legacy encryption
    encryptionKey = credential.encryption.secret;
    encryptionVariant = 'legacy';
  }

  return { encryptionKey, encryptionVariant, dataEncryptionKey };
}

