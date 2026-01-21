import { beforeAll, describe, expect, it } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { decryptSecretValue, sealSecretsDeep } from './secretSettings';

describe('secretSettings', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it('sealSecretsDeep encrypts SecretString.value into SecretString.encryptedValue and drops SecretString.value', () => {
        const key = new Uint8Array(32).fill(7);
        const delta = {
            secrets: [
                { id: 'k1', name: 'Key', encryptedValue: { _isSecretValue: true, value: 'sk-test' } },
            ],
        };

        const sealed = sealSecretsDeep(delta, key);
        const item: any = (sealed as any).secrets[0];
        expect(item.encryptedValue?.value).toBeUndefined();
        expect(item.encryptedValue?.encryptedValue?.t).toBe('enc-v1');
        expect(typeof item.encryptedValue?.encryptedValue?.c).toBe('string');
        expect(item.encryptedValue.encryptedValue.c.length).toBeGreaterThan(0);
    });

    it('sealSecretsDeep does not encrypt objects without secret marker', () => {
        const key = new Uint8Array(32).fill(7);
        const delta = { value: 'not-a-secret', encryptedValue: undefined };
        // Without `_isSecretValue: true`, we must not seal it (avoids false positives across the app).
        const sealed = sealSecretsDeep(delta, key);
        expect((sealed as any).value).toBe('not-a-secret');
    });

    it('decryptSecretValue returns plaintext if value is present (does not mutate input)', () => {
        const key = new Uint8Array(32).fill(7);
        const input: any = { _isSecretValue: true, value: 'sk-plain', encryptedValue: undefined };
        const out = decryptSecretValue(input, key);
        expect(out).toBe('sk-plain');
        expect(input.value).toBe('sk-plain');
        expect(input.encryptedValue).toBeUndefined();
    });
});

