import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveContentKeyPair } from '../crypto/encryption';
import { FileCredentialProvider } from './nodeCredentials';

describe('FileCredentialProvider', () => {
    it('writes a compatible credential file with restrictive permissions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'paws-credentials-'));
        const path = join(directory, 'nested', 'agent.key');
        const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
        const credentials = { token: 'private-token', secret, contentKeyPair: deriveContentKeyPair(secret) };
        const provider = new FileCredentialProvider(path);

        await provider.setCredentials(credentials);

        expect(await provider.getCredentials()).toEqual(credentials);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
            token: 'private-token',
            secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        });
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await provider.clearCredentials();
        expect(await provider.getCredentials()).toBeNull();
    });
});
