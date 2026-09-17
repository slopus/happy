import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { decryptLegacy, encodeBase64, encryptLegacy } from '../crypto/encryption';
import { restorePawsCredentialsWithSecret } from './secretKeyAccount';

describe('restorePawsCredentialsWithSecret', () => {
    it('keeps credentials usable after a Node Buffer recovery input is cleared', async () => {
        // This catches Buffer#slice sharing its backing store with the returned credentials.
        const recoverySecret = Buffer.from([
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
            0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
            0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
        ]);
        const encryptedMetadata = encryptLegacy({ session: 'still-readable' }, recoverySecret);
        const signing = tweetnacl.sign.keyPair.fromSeed(recoverySecret);

        const credentials = await restorePawsCredentialsWithSecret({
            serverUrl: 'https://paws.example.test/',
            secret: recoverySecret,
            fetch: async (_url, init) => {
                const body = JSON.parse(String(init?.body)) as { publicKey: string; challenge: string; signature: string };
                expect(tweetnacl.sign.detached.verify(
                    Buffer.from(body.challenge, 'base64'),
                    Buffer.from(body.signature, 'base64'),
                    signing.publicKey,
                )).toBe(true);
                expect(body.publicKey).toBe(encodeBase64(signing.publicKey));
                return new Response(JSON.stringify({ token: 'restored-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
        });

        recoverySecret.fill(0);

        expect(credentials.token).toBe('restored-token');
        expect(decryptLegacy(encryptedMetadata, credentials.secret)).toEqual({ session: 'still-readable' });
    });
});
