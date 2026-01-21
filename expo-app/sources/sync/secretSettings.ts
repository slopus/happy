import * as z from 'zod';

import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { deriveKey } from '@/encryption/deriveKey';
import { getRandomBytes } from '@/platform/cryptoRandom';
// Note: this module must remain safe for vitest/node (no react-native import).

/**
 * Field-level secret encryption for settings.
 *
 * Goal: even after decrypting the outer settings blob, sensitive values can remain encrypted-at-rest
 * in MMKV / JSON and only be decrypted just-in-time when needed.
 *
 * This is intentionally generic so we can reuse it for future secret settings.
 */

export const EncryptedStringSchema = z.object({
    t: z.literal('enc-v1'),
    c: z.string().min(1), // base64 payload (includes nonce)
});

export type EncryptedString = z.infer<typeof EncryptedStringSchema>;

// Standard secret container (plaintext input + encrypted-at-rest ciphertext).
// This is the ONLY supported secret shape for settings going forward.
export const SecretStringSchema = z.object({
    _isSecretValue: z.literal(true),
    value: z.string().min(1).optional(),
    encryptedValue: EncryptedStringSchema.optional(),
});

export type SecretString = z.infer<typeof SecretStringSchema>;

const SETTINGS_SECRETS_USAGE = 'Happy Settings Secrets';
const SETTINGS_SECRETS_PATH = ['settings', 'secrets', 'v1'] as const;

export async function deriveSettingsSecretsKey(masterSecret: Uint8Array): Promise<Uint8Array> {
    return await deriveKey(masterSecret, SETTINGS_SECRETS_USAGE, [...SETTINGS_SECRETS_PATH]);
}

export function encryptSecretString(value: string, key: Uint8Array): EncryptedString {
    const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
    const message = new TextEncoder().encode(value);
    const encrypted = sodium.crypto_secretbox_easy(message, nonce, key);
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce, 0);
    combined.set(encrypted, nonce.length);
    return { t: 'enc-v1', c: encodeBase64(combined, 'base64') };
}

export function decryptSecretString(valueEnc: EncryptedString, key: Uint8Array): string | null {
    try {
        const combined = decodeBase64(valueEnc.c, 'base64');
        if (combined.length < sodium.crypto_secretbox_NONCEBYTES) return null;
        const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        const boxed = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
        const opened = sodium.crypto_secretbox_open_easy(boxed, nonce, key);
        if (!opened) return null;
        return new TextDecoder().decode(opened);
    } catch {
        return null;
    }
}

/**
 * Secret settings registry
 *
 * Add new encrypted-at-rest settings by extending this registry. Aim: "single-line addition"
 * for new secret fields, and centralized sealing/decryption rules.
 */

// We intentionally do NOT maintain a per-setting registry. All secrets follow one convention.

/**
 * Generic helper for "secret string in settings" objects that may carry either:
 * - plaintext `value` (input/legacy; must never be persisted), or
 * - encrypted-at-rest `encryptedValue` (preferred persisted form).
 */
export function decryptSecretValue(
    input: SecretString | null | undefined,
    key: Uint8Array | null
): string | null {
    if (!input) return null;
    const plaintext = typeof input.value === 'string' ? input.value.trim() : '';
    if (plaintext) return plaintext;
    if (!key) return null;
    if (!input.encryptedValue) return null;
    return decryptSecretString(input.encryptedValue, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Seal plaintext secrets in an arbitrary object graph.
 *
 * Contract:
 * - Any object with `_isSecretValue: true` is treated as a secret container (`SecretStringSchema`).
 * - If it also contains a non-empty plaintext `value`, we encrypt it into `encryptedValue` and delete `value`.
 *
 * This is intentionally schema-independent so it works for any future secret fields as long as
 * they follow the same `{ value, encryptedValue }` convention.
 */
export function sealSecretsDeep<T>(input: T, key: Uint8Array | null): T {
    if (!key) return input;

    if (Array.isArray(input)) {
        // Fast path: avoid allocating a new array unless at least one element changes.
        let out: any[] | null = null;
        for (let i = 0; i < input.length; i++) {
            const item = (input as any)[i];
            const sealed = sealSecretsDeep(item, key);
            if (out) {
                out[i] = sealed;
                continue;
            }
            if (sealed !== item) {
                // First change: allocate and copy prefix.
                out = new Array(input.length);
                for (let j = 0; j < i; j++) out[j] = (input as any)[j];
                out[i] = sealed;
            }
        }
        return (out ? out : input) as any;
    }

    if (!isPlainObject(input)) return input;

    // If this object is a secret container, seal it.
    if ((input as any)._isSecretValue === true) {
        const value = typeof (input as any).value === 'string' ? String((input as any).value).trim() : '';
        if (value.length > 0) {
            const encryptedValue = encryptSecretString(value, key);
            const { value: _dropped, ...rest } = input as any;
            return { ...rest, encryptedValue } as any;
        }
        // No plaintext present; nothing to do.
        return input as any;
    }

    // Otherwise recurse through keys.
    let out: any = input;
    for (const [k, v] of Object.entries(input)) {
        const sealedChild = sealSecretsDeep(v, key);
        if (sealedChild !== v) {
            if (out === input) out = { ...(input as any) };
            out[k] = sealedChild;
        }
    }
    return out;
}

