import type { ClientCredentials } from '../client/types';
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
    credentials: ClientCredentials,
    recordType: 'machine' | 'session',
): RecordEncryption {
    const encryption = tryResolveRecordEncryption(record, credentials, recordType);
    if (!encryption) throw new PawsAgentError('FORBIDDEN', 'Record key is outside the trusted process scope');
    return encryption;
}

export function tryResolveRecordEncryption(
    record: { id: string; dataEncryptionKey: string | null },
    credentials: ClientCredentials,
    recordType: 'machine' | 'session',
): RecordEncryption | null {
    if ('resolveRecordKey' in credentials) {
        const value = credentials.resolveRecordKey({ id: record.id, dataEncryptionKey: record.dataEncryptionKey, type: recordType });
        if (!value) return null;
        const variant = record.dataEncryptionKey ? 'dataKey' : 'legacy';
        if (value.key.length !== 32 || value.variant !== variant) {
            throw new PawsAgentError('DECRYPTION_FAILED', 'Trusted record key does not match the encryption variant');
        }
        return { key: new Uint8Array(value.key), variant };
    }
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
    const value = encryption.variant === 'dataKey'
        ? decryptWithDataKey(bytes, encryption.key)
        : decryptLegacy(bytes, encryption.key);
    if (value === null) throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt record field');
    return value;
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
