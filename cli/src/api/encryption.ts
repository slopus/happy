import { logger } from '@/ui/logger';
import { randomBytes } from 'node:crypto'
import tweetnacl from 'tweetnacl'

/**
 * Encode a Uint8Array to base64 string
 * @param buffer - The buffer to encode
 * @param variant - The encoding variant ('base64' or 'base64url')
 */
export function encodeBase64(buffer: Uint8Array, variant: 'base64' | 'base64url' = 'base64'): string {
  if (variant === 'base64url') {
    return encodeBase64Url(buffer);
  }
  return Buffer.from(buffer).toString('base64')
}

/**
 * Encode a Uint8Array to base64url string (URL-safe base64)
 * Base64URL uses '-' instead of '+', '_' instead of '/', and removes padding
 */
export function encodeBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

/**
 * Decode a base64 string to a Uint8Array
 * @param base64 - The base64 string to decode
 * @param variant - The encoding variant ('base64' or 'base64url')
 * @returns The decoded Uint8Array
 */
export function decodeBase64(base64: string, variant: 'base64' | 'base64url' = 'base64'): Uint8Array {
  if (variant === 'base64url') {
    // Convert base64url to base64
    const base64Standard = base64
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      + '='.repeat((4 - base64.length % 4) % 4);
    return new Uint8Array(Buffer.from(base64Standard, 'base64'));
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}



/**
 * Generate secure random bytes
 */
export function getRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size))
}

/**
 * Encrypt data using the secret key
 * @param data - The data to encrypt
 * @param secret - The secret key to use for encryption
 * @returns The encrypted data
 */
export function encrypt(data: any, secret: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
  const encrypted = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

/**
 * Decrypt data using the secret key
 * @param data - The data to decrypt
 * @param secret - The secret key to use for decryption
 * @returns The decrypted data
 */
export function decrypt(data: Uint8Array, secret: Uint8Array): any | null {
  const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
  const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
  const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
  if (!decrypted) {
    logger.debug('[ERROR] Decryption failed');
    return null;
  }
  return JSON.parse(new TextDecoder().decode(decrypted));
}

/**
 * Generate authentication challenge response
 */
export function authChallenge(secret: Uint8Array): {
  challenge: Uint8Array
  publicKey: Uint8Array
  signature: Uint8Array
} {
  const keypair = tweetnacl.sign.keyPair.fromSeed(secret);
  const challenge = getRandomBytes(32);
  const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

  return {
    challenge,
    publicKey: keypair.publicKey,
    signature
  };
}