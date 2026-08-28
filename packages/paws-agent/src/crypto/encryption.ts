import { gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import {
    decode as decodeBase64Value,
    decodeURLSafe,
    encode as encodeBase64Value,
    encodeURLSafe,
} from '@stablelib/base64';
import tweetnacl from 'tweetnacl';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeBase64(buffer: Uint8Array): string {
    return encodeBase64Value(buffer);
}

export function decodeBase64(base64: string): Uint8Array {
    return decodeBase64Value(base64);
}

export function encodeBase64Url(buffer: Uint8Array): string {
    return encodeURLSafe(buffer).replaceAll('=', '');
}

export function decodeBase64Url(base64url: string): Uint8Array {
    const padded = base64url + '='.repeat((4 - base64url.length % 4) % 4);
    return decodeURLSafe(padded);
}

export function getRandomBytes(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new RangeError('Random byte size must be a non-negative safe integer');
    }

    const result = new Uint8Array(size);
    for (let offset = 0; offset < result.length; offset += 65_536) {
        globalThis.crypto.getRandomValues(result.subarray(offset, offset + 65_536));
    }
    return result;
}

export function hmac_sha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    return hmac(sha512, key, data);
}

export type KeyTreeState = {
    key: Uint8Array;
    chainCode: Uint8Array;
};

export function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): KeyTreeState {
    const value = hmac_sha512(textEncoder.encode(usage + ' Master Seed'), seed);
    return {
        key: value.slice(0, 32),
        chainCode: value.slice(32),
    };
}

export function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): KeyTreeState {
    const data = new Uint8Array([0x00, ...textEncoder.encode(index)]);
    const value = hmac_sha512(chainCode, data);
    return {
        key: value.slice(0, 32),
        chainCode: value.slice(32),
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
    // This label is a persisted protocol constant. Renaming it would change every derived key.
    const seed = deriveKey(secret, 'Happy EnCoder', ['content']);
    const boxSecretKey = sha512(seed).slice(0, 32);
    const keyPair = tweetnacl.box.keyPair.fromSecretKey(boxSecretKey);
    return { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey };
}

export function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(gcm.nonceLength);
    const encrypted = gcm(dataKey, nonce).encrypt(textEncoder.encode(JSON.stringify(data)));

    // Bundle: version(1) + nonce(12) + ciphertext + authTag(16).
    const bundle = new Uint8Array(1 + nonce.length + encrypted.length);
    bundle[0] = 0;
    bundle.set(nonce, 1);
    bundle.set(encrypted, 1 + nonce.length);
    return bundle;
}

export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): unknown | null {
    if (bundle.length < 1 + gcm.nonceLength + gcm.tagLength || bundle[0] !== 0) {
        return null;
    }

    try {
        const nonce = bundle.slice(1, 1 + gcm.nonceLength);
        const encrypted = bundle.slice(1 + gcm.nonceLength);
        return JSON.parse(textDecoder.decode(gcm(dataKey, nonce).decrypt(encrypted)));
    } catch {
        return null;
    }
}

export function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
    const encrypted = tweetnacl.secretbox(textEncoder.encode(JSON.stringify(data)), nonce, secret);
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
        return decrypted ? JSON.parse(textDecoder.decode(decrypted)) : null;
    } catch {
        return null;
    }
}

export function encrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: unknown): Uint8Array {
    return variant === 'legacy' ? encryptLegacy(data, key) : encryptWithDataKey(data, key);
}

export function decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): unknown | null {
    return variant === 'legacy' ? decryptLegacy(data, key) : decryptWithDataKey(data, key);
}

export function authChallenge(secret: Uint8Array): {
    challenge: Uint8Array;
    publicKey: Uint8Array;
    signature: Uint8Array;
} {
    const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(secret);
    const challenge = getRandomBytes(32);
    return {
        challenge,
        publicKey: signingKeyPair.publicKey,
        signature: tweetnacl.sign.detached(challenge, signingKeyPair.secretKey),
    };
}

export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = tweetnacl.box.keyPair();
    const nonce = getRandomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    const result = new Uint8Array(32 + 24 + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, 32);
    result.set(encrypted, 56);
    return result;
}

export function decryptBoxBundle(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < 32 + 24) {
        return null;
    }

    const decrypted = tweetnacl.box.open(
        bundle.slice(56),
        bundle.slice(32, 56),
        bundle.slice(0, 32),
        recipientSecretKey,
    );
    return decrypted ? new Uint8Array(decrypted) : null;
}
