/**
 * Setup @noble/ed25519 to work in React Native
 *
 * React Native doesn't have crypto.subtle available by default.
 * This configures the library to use expo-crypto for SHA-512 hashing.
 *
 * This file MUST be imported before any ed25519 operations are performed.
 */
import * as Crypto from 'expo-crypto';
import { hashes } from '@noble/ed25519';

// Configure @noble/ed25519 to use expo-crypto for SHA-512
hashes.sha512Async = async (message: Uint8Array): Promise<Uint8Array> => {
    const hash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA512, message as unknown as BufferSource);
    return new Uint8Array(hash);
};
