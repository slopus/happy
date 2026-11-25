/** Private in-memory keys for the explicitly scoped acceptance run. Never log these values. */
function decodeKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Private key must be canonical 32-byte base64');
    const key = new Uint8Array(Buffer.from(value, 'base64'));
    if (key.length !== 32 || Buffer.from(key).toString('base64') !== value) throw new Error('Private key must be canonical 32-byte base64');
    return key;
}

export function parseHarnessOwnerCredentials(raw, deriveContentKeyPair) {
    if (!raw || typeof raw.token !== 'string' || !raw.token.length) throw new Error('Private credentials require an authentication token');
    if (typeof raw.secret === 'string' && raw.secret.length) {
        const secret = decodeKey(raw.secret);
        return { mode: 'owner-secret', credentials: { token: raw.token, secret, contentKeyPair: deriveContentKeyPair(secret) } };
    }
    if (!raw.encryption || typeof raw.encryption !== 'object') throw new Error('Private credentials require an owner secret or CLI dataKey encryption');
    decodeKey(raw.encryption.publicKey);
    const machineKey = decodeKey(raw.encryption.machineKey);
    return { mode: 'dataKey-only', credentials: { token: raw.token }, machineKey };
}

export function resolveHarnessMachineEncryption(record, owner, resolveRecordEncryption) {
    if (owner.mode === 'owner-secret') return resolveRecordEncryption(record, owner.credentials, 'machine');
    if (!record.dataEncryptionKey) throw new Error('CLI dataKey credentials cannot open a legacy machine');
    return { key: new Uint8Array(owner.machineKey), variant: 'dataKey' };
}

export async function resolveHarnessSessionEncryption(record, { owner, knownSessions, readRetained, resolveRecordEncryption }) {
    if (!knownSessions.has(record.id)) throw new Error('Refusing to resolve a session key outside this run');
    if (owner.mode === 'owner-secret') return resolveRecordEncryption(record, owner.credentials, 'session');
    if (!readRetained) throw new Error('CLI dataKey credentials require an explicit --retained-sessions file');
    const retained = await readRetained();
    // Do not enumerate sessions or inspect retained metadata. Only this newly
    // created run-owned ID's key and variant are used, once when it is loaded.
    const entry = retained?.sessions?.[record.id];
    if (!entry || (entry.encryptionVariant !== 'legacy' && entry.encryptionVariant !== 'dataKey')) throw new Error('The new session has no retained encryption key');
    const variant = record.dataEncryptionKey ? 'dataKey' : 'legacy';
    if (entry.encryptionVariant !== variant) throw new Error('Retained session encryption variant does not match the server record');
    return { key: decodeKey(entry.encryptionKey), variant };
}
