/**
 * Encryption utilities for session sharing
 */

import nacl from 'tweetnacl';

/**
 * Encrypt a session data key with a recipient's public key
 * 
 * Uses X25519-XSalsa20-Poly1305 encryption with ephemeral keys
 */
export function encryptDataKeyForRecipient(
    dataKey: Uint8Array,
    recipientPublicKey: Uint8Array
): Uint8Array {
    const ephemeralKeyPair = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    
    const encrypted = nacl.box(
        dataKey,
        nonce,
        recipientPublicKey,
        ephemeralKeyPair.secretKey
    );
    
    // Bundle: ephemeral public key (32) + nonce (24) + encrypted data
    const bundle = new Uint8Array(
        ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length
    );
    bundle.set(ephemeralKeyPair.publicKey, 0);
    bundle.set(nonce, ephemeralKeyPair.publicKey.length);
    bundle.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    
    return bundle;
}
