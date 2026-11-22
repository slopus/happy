import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { GoalProjectConversationIndexEntrySchema, type GoalProjectConversationCandidate, type GoalProjectConversationIndexEntry } from '@slopus/happy-wire';
import { decrypt, encrypt } from '@/api/encryption';
import type { ProjectConversationRawHeader } from './projectConversationCatalog';

export type ProjectConversationIndexEncryption = { encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' };
export const PROJECT_CONVERSATION_INDEX_BYTES = 16 * 1024 * 1024;
const FILE_BYTES = PROJECT_CONVERSATION_INDEX_BYTES + 4096;
const documentSchema = z.object({ version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), entries: z.array(GoalProjectConversationIndexEntrySchema).max(20000) });
type Classification = GoalProjectConversationCandidate | null;

export function projectConversationIndexScope(serverUrl: string, machineId: string, encryption: ProjectConversationIndexEncryption) {
    const identity = createHash('sha256').update(encryption.encryptionKey).digest('hex');
    return createHash('sha256').update(JSON.stringify(['project-conversation-index-v1', new URL(serverUrl).origin, machineId, identity])).digest('hex');
}

/** Rebuildable metadata classifications, encrypted with the existing machine key.
 * Serial writes and snapshot generations prevent old reads from undoing newer
 * metadata versions or deletions. Missing evidence always remains opaque. */
export function createProjectConversationIndex(options: {
    serverUrl: string; machineId: string; path?: string; encryption?: ProjectConversationIndexEncryption;
}) {
    const supported = !!options.path && !!options.encryption && options.encryption.encryptionKey.length === 32;
    const identityEncryption = options.encryption && { ...options.encryption, encryptionKey: Uint8Array.from(options.encryption.encryptionKey) };
    const scope = identityEncryption ? projectConversationIndexScope(options.serverUrl, options.machineId, identityEncryption) : '';
    // Keep persisted cache ciphertext in a separate cryptographic domain from
    // machine RPC/state messages, while retaining the stable owner scope.
    const encryption = identityEncryption && { ...identityEncryption, encryptionKey: new Uint8Array(createHmac('sha256', identityEncryption.encryptionKey)
        .update(JSON.stringify(['project-conversation-index-v1', scope])).digest()) };
    let records = new Map<string, GoalProjectConversationIndexEntry>();
    let loaded = false, disposed = false, persisted: string | undefined;
    let currentGeneration = 0, currentVersions = new Map<string, number>();
    let queue: Promise<unknown> = Promise.resolve();
    const active = () => { if (disposed) throw new Error('Conversation index runtime is disposed'); };
    const serial = <T>(body: () => Promise<T>) => {
        const task = queue.then(async () => { active(); return body(); });
        queue = task.catch(() => {});
        return task;
    };
    const load = async () => {
        if (loaded) return;
        loaded = true;
        if (!supported) return;
        try {
            const handle = await open(options.path!, constants.O_RDONLY | constants.O_NOFOLLOW);
            let bytes: Buffer;
            try {
                const info = await handle.stat();
                if (!info.isFile() || info.size > FILE_BYTES) throw new Error('Invalid conversation index size');
                const buffer = Buffer.alloc(Math.min(FILE_BYTES + 1, info.size + 1));
                let size = 0;
                while (size < buffer.length) {
                    const read = await handle.read(buffer, size, buffer.length - size, size);
                    if (!read.bytesRead) break;
                    size += read.bytesRead;
                }
                if (size > FILE_BYTES || size > info.size) throw new Error('Conversation index changed during read');
                bytes = buffer.subarray(0, size);
            } finally { await handle.close(); }
            const value = decrypt(encryption!.encryptionKey, encryption!.encryptionVariant, bytes);
            if (Buffer.byteLength(JSON.stringify(value)) > PROJECT_CONVERSATION_INDEX_BYTES) throw new Error('Conversation index is too large');
            const parsed = documentSchema.parse(value);
            if (parsed.scope !== scope || new Set(parsed.entries.map(entry => entry.id)).size !== parsed.entries.length) throw new Error('Conversation index scope is invalid');
            active();
            records = new Map(parsed.entries.map(entry => [entry.id, entry]));
            persisted = JSON.stringify(parsed);
        } catch { records = new Map(); persisted = undefined; }
    };
    const save = async (next: Map<string, GoalProjectConversationIndexEntry>) => {
        active();
        if (next.size > 20000) throw new Error('Conversation index record limit exceeded');
        const value = { version: 1 as const, scope, entries: [...next.values()] }, plaintext = JSON.stringify(value);
        if (Buffer.byteLength(plaintext) > PROJECT_CONVERSATION_INDEX_BYTES) throw new Error('Conversation index byte limit exceeded');
        if (!supported || plaintext === persisted) { records = next; return; }
        const directory = dirname(options.path!), temporary = options.path! + '.' + randomUUID() + '.tmp';
        try {
            const bytes = Buffer.from(encrypt(encryption!.encryptionKey, encryption!.encryptionVariant, value));
            if (bytes.length > FILE_BYTES) throw new Error('Conversation index file limit exceeded');
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            active();
            await rename(temporary, options.path!);
            records = next; persisted = plaintext;
        } catch {
            records = new Map(); persisted = undefined;
            throw new Error('Conversation index could not be saved');
        } finally { await unlink(temporary).catch(() => {}); }
    };
    const versions = (rows: ReadonlyArray<Readonly<ProjectConversationRawHeader>>) => {
        if (rows.length > 20000) throw new Error('Conversation index record limit exceeded');
        const result = new Map<string, number>();
        for (const row of rows) {
            if (!row.id || result.has(row.id) || !Number.isSafeInteger(row.metadataVersion) || row.metadataVersion! < 0) throw new Error('Invalid conversation index catalog');
            result.set(row.id, row.metadataVersion!);
        }
        return result;
    };
    return {
        supported,
        dispose() { disposed = true; records.clear(); },
        classify(rows: ReadonlyArray<Readonly<ProjectConversationRawHeader>>, resolve: (row: Readonly<ProjectConversationRawHeader>) => Classification | undefined, generation: number) {
            return serial(async () => {
                await load(); active();
                const observed = versions(rows), result = new Map<string, Classification>(), next = new Map<string, GoalProjectConversationIndexEntry>();
                for (const row of rows) {
                    const cached = records.get(row.id);
                    let candidate = cached && cached.metadataVersion === row.metadataVersion ? cached.candidate : undefined;
                    if (candidate === undefined) { try { candidate = resolve(row); } catch { /* Unknown keys or malformed metadata stay opaque. */ } }
                    if (candidate === undefined) continue;
                    const entry = GoalProjectConversationIndexEntrySchema.safeParse({ id: row.id, metadataVersion: row.metadataVersion, candidate });
                    if (!entry.success) continue;
                    result.set(row.id, entry.data.candidate); next.set(row.id, entry.data);
                }
                if (generation >= currentGeneration) {
                    currentGeneration = generation; currentVersions = observed;
                    try { await save(next); } catch { return new Map<string, Classification>(); }
                }
                return result;
            });
        },
        record(rows: ReadonlyArray<Readonly<ProjectConversationRawHeader>>, entries: GoalProjectConversationIndexEntry[], generation: number) {
            return serial(async () => {
                if (!supported) throw new Error('Persistent conversation index is unavailable');
                await load(); active();
                const observed = versions(rows);
                if (entries.length > 200 || Buffer.byteLength(JSON.stringify(entries)) > 192 * 1024) throw new Error('Conversation index evidence exceeds its batch limit');
                const parsed = entries.map(entry => GoalProjectConversationIndexEntrySchema.parse(entry));
                if (new Set(parsed.map(entry => entry.id)).size !== parsed.length) throw new Error('Conversation index evidence identities are duplicated');
                for (const entry of parsed) if (observed.get(entry.id) !== entry.metadataVersion) throw new Error('Conversation index evidence is outside the snapshot or metadata changed');
                if (generation < currentGeneration) return false;
                if (generation !== currentGeneration || observed.size !== currentVersions.size || [...observed].some(([id, version]) => currentVersions.get(id) !== version))
                    throw new Error('Conversation index snapshot is no longer current; refresh conversations');
                const next = new Map([...records].filter(([id, entry]) => observed.get(id) === entry.metadataVersion));
                for (const entry of parsed) next.set(entry.id, entry);
                await save(next);
                return true;
            });
        },
    };
}
