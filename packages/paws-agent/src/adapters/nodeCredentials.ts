import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CredentialProvider, PawsCredentials } from '../client/types';
import { decodeBase64, deriveContentKeyPair, encodeBase64 } from '../crypto/encryption';

export class FileCredentialProvider implements CredentialProvider {
    constructor(readonly credentialPath: string) {}

    async getCredentials(): Promise<PawsCredentials | null> {
        try {
            const parsed = JSON.parse(await readFile(this.credentialPath, 'utf8')) as {
                token?: unknown;
                secret?: unknown;
            };
            if (typeof parsed.token !== 'string' || typeof parsed.secret !== 'string') return null;
            const secret = decodeBase64(parsed.secret);
            return { token: parsed.token, secret, contentKeyPair: deriveContentKeyPair(secret) };
        } catch {
            return null;
        }
    }

    async setCredentials(credentials: PawsCredentials): Promise<void> {
        await mkdir(dirname(this.credentialPath), { recursive: true, mode: 0o700 });
        await writeFile(this.credentialPath, JSON.stringify({
            token: credentials.token,
            secret: encodeBase64(credentials.secret),
        }), { mode: 0o600 });
        await chmod(this.credentialPath, 0o600);
    }

    async clearCredentials(): Promise<void> {
        try {
            await unlink(this.credentialPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
}

export function createDefaultFileCredentialProvider(environment: NodeJS.ProcessEnv = process.env): FileCredentialProvider {
    const home = environment.PAWS_HOME_DIR
        ?? environment.HAPPY_HOME_DIR
        ?? join(homedir(), '.happy');
    return new FileCredentialProvider(join(home, 'agent.key'));
}
