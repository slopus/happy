import axios from 'axios';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { encodeBase64, encodeBase64Url, getRandomBytes, authChallenge } from './encryption';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Generate or load a secret key for authentication
 */
export async function getOrCreateSecretKey(): Promise<Uint8Array> {
  const keyPath = join(homedir(), '.handy', 'access.key');

  if (existsSync(keyPath)) {
    const keyBase64 = readFileSync(keyPath, 'utf8').trim();
    return new Uint8Array(Buffer.from(keyBase64, 'base64'));
  }

  // Generate a new 32-byte secret key (256 bits)
  const secret = getRandomBytes(32);
  const keyBase64 = encodeBase64(secret);

  // Write to file with restricted permissions
  mkdirSync(join(homedir(), '.handy'), { recursive: true });
  writeFileSync(keyPath, keyBase64);
  await chmod(keyPath, 0o600); // Read/write for owner only

  return secret;
}

/**
 * Authenticate with the server and obtain an auth token
 * @param serverUrl - The URL of the server to authenticate with
 * @param secret - The secret key to use for authentication
 * @returns The authentication token
 */
export async function authGetToken(secret: Uint8Array): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret);

  const response = await axios.post(`https://handy-api.korshakov.org/v1/auth`, {
    challenge: encodeBase64(challenge),
    publicKey: encodeBase64(publicKey),
    signature: encodeBase64(signature)
  });

  if (!response.data.success || !response.data.token) {
    throw new Error('Authentication failed');
  }

  return response.data.token;
}

/**
 * Generate a URL for the mobile app to connect to the server
 * @param secret - The secret key to use for authentication
 * @returns The URL for the mobile app to connect to the server
 */
export function generateAppUrl(secret: Uint8Array): string {
  const secretBase64Url = encodeBase64Url(secret);
  return `handy://${secretBase64Url}`;
}