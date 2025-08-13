import { encodeBase64 } from './encryption';

/**
 * Generate a URL for web authentication
 * @param publicKey - The ephemeral public key to include in the URL
 * @returns The web authentication URL
 */
export function generateWebAuthUrl(publicKey: Uint8Array): string {
    const publicKeyBase64 = encodeBase64(publicKey, 'base64url');
    return `https://app.happy.engineering/terminal/connect#key=${publicKeyBase64}`;
}