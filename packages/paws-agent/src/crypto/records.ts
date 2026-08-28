import type { PawsCredentials } from '../client/types';
import { PawsAgentError } from '../client/errors';
import {
    decodeBase64,
    decryptBoxBundle,
    decryptLegacy,
    decryptWithDataKey,
} from './encryption';

export type RecordEncryption = {
    key: Uint8Array;
    variant: 'legacy' | 'dataKey';
};

export function resolveRecordEncryption(
    record: { id: string; dataEncryptionKey: string | null },
    credentials: PawsCredentials,
    recordType: 'machine' | 'session',
): RecordEncryption {
    if (!record.dataEncryptionKey) {
        return { key: credentials.secret, variant: 'legacy' };
    }

    const encrypted = decodeBase64(record.dataEncryptionKey);
    const key = decryptBoxBundle(encrypted.slice(1), credentials.contentKeyPair.secretKey);
    if (!key) {
        throw new PawsAgentError('DECRYPTION_FAILED', `Unable to decrypt ${recordType} key`, {
            details: { recordType, recordId: record.id },
        });
    }
    return { key, variant: 'dataKey' };
}

export function decryptRecordField(
    encrypted: string | null,
    encryption: RecordEncryption,
): unknown | null {
    if (!encrypted) {
        return null;
    }
    const bytes = decodeBase64(encrypted);
    return encryption.variant === 'dataKey'
        ? decryptWithDataKey(bytes, encryption.key)
        : decryptLegacy(bytes, encryption.key);
}

export class RecordEncryptionStore {
    private readonly machines = new Map<string, RecordEncryption>();
    private readonly sessions = new Map<string, RecordEncryption>();

    setMachine(id: string, encryption: RecordEncryption): void {
        this.machines.set(id, encryption);
    }

    getMachine(id: string): RecordEncryption | undefined {
        return this.machines.get(id);
    }

    setSession(id: string, encryption: RecordEncryption): void {
        this.sessions.set(id, encryption);
    }

    getSession(id: string): RecordEncryption | undefined {
        return this.sessions.get(id);
    }

    clear(): void {
        this.machines.clear();
        this.sessions.clear();
    }
}
