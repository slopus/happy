import { describe, expect, it } from 'vitest';
import { deriveContentKeyPair } from '../crypto/encryption';
import { BrowserCredentialProvider } from './browserCredentials';

describe('BrowserCredentialProvider', () => {
    it('round-trips credentials through injected storage without exposing them on the provider', async () => {
        const values = new Map<string, string>();
        const storage = {
            get: async (key: string) => values.get(key) ?? null,
            set: async (key: string, value: string) => { values.set(key, value); },
            remove: async (key: string) => { values.delete(key); },
        };
        const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
        const credentials = { token: 'private-token', secret, contentKeyPair: deriveContentKeyPair(secret) };
        const provider = new BrowserCredentialProvider(storage, 'test.credentials');

        await provider.setCredentials(credentials);
        expect(await provider.getCredentials()).toEqual(credentials);
        expect(JSON.stringify(provider)).not.toContain(credentials.token);
        await provider.clearCredentials();
        expect(await provider.getCredentials()).toBeNull();
    });
});
