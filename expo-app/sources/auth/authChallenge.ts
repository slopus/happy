import { getRandomBytes } from 'expo-crypto';
import { getPublicKeyAsync, signAsync } from '@noble/ed25519';

export async function authChallenge(secret: Uint8Array) {
    // secret is used as the 32-byte seed for Ed25519
    const publicKey = await getPublicKeyAsync(secret);
    const challenge = getRandomBytes(32);
    const signature = await signAsync(challenge, secret);
    return { challenge, signature, publicKey };
}