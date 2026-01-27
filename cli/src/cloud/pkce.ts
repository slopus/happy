import { createHash, randomBytes } from 'node:crypto';

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

/**
 * Generate PKCE codes for OAuth flows.
 *
 * - verifier: 43-128 characters, base64url-ish
 * - challenge: SHA256(verifier), base64url
 */
export function generatePkceCodes(bytes: number = 32): PkceCodes {
  const verifier = randomBytes(bytes)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9\-._~]/g, '');

  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return { verifier, challenge };
}

