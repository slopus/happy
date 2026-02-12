import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

// --- Base64 encoding/decoding ---

export function encodeBase64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('base64');
}

export function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function encodeBase64Url(buffer: Uint8Array): string {
    return Buffer.from(buffer)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}

export function decodeBase64Url(base64url: string): Uint8Array {
    const base64 = base64url
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        + '='.repeat((4 - base64url.length % 4) % 4);
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function getRandomBytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
}

// --- HMAC-SHA512 ---

export function hmac_sha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hmac = createHmac('sha512', key);
    hmac.update(data);
    return new Uint8Array(hmac.digest());
}

// --- Key derivation tree ---

export type KeyTreeState = {
    key: Uint8Array;
    chainCode: Uint8Array;
};

export function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): KeyTreeState {
    const I = hmac_sha512(new TextEncoder().encode(usage + ' Master Seed'), seed);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32),
    };
}

export function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): KeyTreeState {
    const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
    const I = hmac_sha512(chainCode, data);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32),
    };
}

export function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    let state = deriveSecretKeyTreeRoot(master, usage);
    for (const index of path) {
        state = deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}

export function deriveContentKeyPair(secret: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const seed = deriveKey(secret, 'Happy EnCoder', ['content']);
    // libsodium's crypto_box_seed_keypair does SHA-512(seed)[0:32] internally
    const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest());
    const boxSecretKey = hashedSeed.slice(0, 32);
    const keyPair = tweetnacl.box.keyPair.fromSecretKey(boxSecretKey);
    return { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey };
}

// --- AES-256-GCM encryption ---

export function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Bundle: version(1) + nonce(12) + ciphertext + authTag(16)
    const bundle = new Uint8Array(1 + 12 + encrypted.length + 16);
    bundle[0] = 0; // version
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(encrypted), 13);
    bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
    return bundle;
}

export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): unknown | null {
    if (bundle.length < 1 + 12 + 16) return null; // minimum: version + nonce + authTag
    if (bundle[0] !== 0) return null; // only version 0

    const nonce = bundle.slice(1, 13);
    const authTag = bundle.slice(bundle.length - 16);
    const ciphertext = bundle.slice(13, bundle.length - 16);

    try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

// --- Legacy TweetNaCl secretbox encryption ---

export function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = tweetnacl.secretbox(plaintext, nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptLegacy(data: Uint8Array, secret: Uint8Array): unknown | null {
    try {
        const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
        const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
        const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
        if (!decrypted) return null;
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

// --- Encrypt/decrypt dispatcher ---

export function encrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: unknown): Uint8Array {
    if (variant === 'legacy') {
        return encryptLegacy(data, key);
    } else {
        return encryptWithDataKey(data, key);
    }
}

export function decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): unknown | null {
    if (variant === 'legacy') {
        return decryptLegacy(data, key);
    } else {
        return decryptWithDataKey(data, key);
    }
}

// --- Auth challenge (for token refresh) ---

export function authChallenge(secret: Uint8Array): {
    challenge: Uint8Array;
    publicKey: Uint8Array;
    signature: Uint8Array;
} {
    // Derive signing keypair from secret seed
    const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(secret);
    // Create random 32-byte challenge
    const challenge = getRandomBytes(32);
    // Sign the challenge
    const signature = tweetnacl.sign.detached(challenge, signingKeyPair.secretKey);
    return {
        challenge,
        publicKey: signingKeyPair.publicKey,
        signature,
    };
}

// --- NaCl box encryption (public key) ---

export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = tweetnacl.box.keyPair();
    const nonce = getRandomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);

    // Bundle: ephemeral pubkey(32) + nonce(24) + ciphertext
    const result = new Uint8Array(32 + 24 + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, 32);
    result.set(encrypted, 56);
    return result;
}

export function decryptBoxBundle(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < 32 + 24) return null;

    const ephemeralPublicKey = bundle.slice(0, 32);
    const nonce = bundle.slice(32, 56);
    const ciphertext = bundle.slice(56);

    const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
    return decrypted ? new Uint8Array(decrypted) : null;
}

