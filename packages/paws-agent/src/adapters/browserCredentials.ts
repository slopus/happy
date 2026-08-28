import type { CredentialProvider, PawsCredentials } from '../client/types';
import { decodeBase64, deriveContentKeyPair, encodeBase64 } from '../crypto/encryption';

export interface KeyValueStorage {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
}

export class BrowserCredentialProvider implements CredentialProvider {
    constructor(
        private readonly storage: KeyValueStorage,
        private readonly key = 'paws-agent.credentials',
    ) {}

    async getCredentials(): Promise<PawsCredentials | null> {
        try {
            const value = await this.storage.get(this.key);
            if (!value) return null;
            const parsed = JSON.parse(value) as { token?: unknown; secret?: unknown };
            if (typeof parsed.token !== 'string' || typeof parsed.secret !== 'string') return null;
            const secret = decodeBase64(parsed.secret);
            return { token: parsed.token, secret, contentKeyPair: deriveContentKeyPair(secret) };
        } catch {
            return null;
        }
    }

    async setCredentials(credentials: PawsCredentials): Promise<void> {
        await this.storage.set(this.key, JSON.stringify({
            token: credentials.token,
            secret: encodeBase64(credentials.secret),
        }));
    }

    clearCredentials(): Promise<void> {
        return this.storage.remove(this.key);
    }
}
