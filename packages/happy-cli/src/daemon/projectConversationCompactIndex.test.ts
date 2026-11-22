import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { decrypt, encrypt, encodeBase64 } from '@/api/encryption';
import { createProjectGoalRuntime } from './projectGoalRuntime';
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const sessionKey = new Uint8Array(32).fill(7), indexKey = new Uint8Array(32).fill(9);
const indexEncryption = { encryptionKey: indexKey, encryptionVariant: 'dataKey' as const };
const encode = (metadata: any, key = sessionKey) => encodeBase64(encrypt(key, 'legacy', metadata));
const candidate = { sessionId: 'own', metadataVersion: 1, directory: '/project', title: 'Owned title' };
const raw = (id: string, metadata = encode({ machineId: 'machine', host: 'fixture', path: '/project', name: 'Owned title' }), version = 1) => ({
    id, metadata, metadataVersion: version, dataEncryptionKey: null, seq: 1, updatedAt: 10, active: false,
});
const roots: string[] = [];
async function indexPath() { const root = await mkdtemp(join(tmpdir(), 'paws-conversation-index-test-')); roots.push(root); return join(root, 'compact.enc'); }
const runtime = (path: string, extra: any = {}) => createProjectGoalRuntime({ serverUrl: 'https://relay.test', token: 'private-token', machineId: 'machine',
    findSession: () => undefined, indexEncryption, indexPath: path, ...extra });
beforeEach(() => { vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('runtime compact conversation classifications', () => {
    it('projects only decryptable selected-machine metadata, proves foreign/unbound null and leaves failures opaque', async () => {
        const path = await indexPath();
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [
            raw('own'), raw('foreign', encode({ machineId: 'other', path: '/foreign-private-path', name: 'FOREIGN_PRIVATE_TITLE' })),
            raw('unbound', encode({ host: 'fixture', path: '/unbound' })), raw('opaque', encode({}, new Uint8Array(32).fill(8))),
        ], hasNext: false } });
        const adapter = runtime(path, { legacyKey: sessionKey });
        const manifest = await adapter.conversationCatalog!('/project', { format: 'manifest' });
        expect(manifest).toMatchObject({ indexSupported: true, sessions: [
            { id: 'own', metadataVersion: 1, candidate }, { id: 'foreign', metadataVersion: 1, candidate: null },
            { id: 'unbound', metadataVersion: 1, candidate: null }, { id: 'opaque', metadataVersion: 1 },
        ] });
        expect(JSON.stringify(manifest)).not.toMatch(/FOREIGN_PRIVATE|foreign-private|private-token|encryptionKey|dataEncryptionKey/);
        expect(manifest.sessions[3]).not.toHaveProperty('candidate');
        const restarted = runtime(path), restored = await restarted.conversationCatalog!('/project', { format: 'manifest' });
        expect(restored.sessions).toEqual(manifest.sessions);
    });

    it('does not learn exclusions from an empty legacy aggregate, but persists explicit evidence encrypted across restart', async () => {
        const path = await indexPath(), rows = [raw('own'), raw('foreign')];
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: rows, hasNext: false } });
        const adapter = runtime(path), first = await adapter.conversationCatalog!('/project', { format: 'manifest' });
        await adapter.history('/project', [], { headersOnly: true, snapshotId: first.snapshotId, catalogFingerprint: first.catalogFingerprint, headerCandidates: [] });
        const untouched = runtime(path), opaque = await untouched.conversationCatalog!('/project', { format: 'manifest' });
        expect(opaque.sessions.every(row => !Object.hasOwn(row, 'candidate'))).toBe(true);
        await adapter.conversationIndex!('/project', { snapshotId: first.snapshotId, catalogFingerprint: first.catalogFingerprint,
            entries: [{ id: 'own', metadataVersion: 1, candidate }, { id: 'foreign', metadataVersion: 1, candidate: null }] });
        const disk = await readFile(path); expect(disk.toString()).not.toMatch(/Owned title|\/project|foreign|private-token/);
        expect(decrypt(indexKey, 'dataKey', disk)).toBeNull();
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        rows[0] = { ...rows[0], seq: 9, updatedAt: 999, active: true };
        const restarted = runtime(path), restored = await restarted.conversationCatalog!('/project', { format: 'manifest' });
        expect(restored.sessions).toEqual([{ id: 'own', metadataVersion: 1, candidate }, { id: 'foreign', metadataVersion: 1, candidate: null }]);
        const result = await restarted.history('/project', [{ id: '', directory: '/project', featurePath: '/project' }], {
            headersOnly: true, snapshotId: restored.snapshotId, catalogFingerprint: restored.catalogFingerprint, headerCandidates: [candidate],
        });
        expect(result[0]).toMatchObject({ sessionId: 'own', updatedAt: 999, active: true, executed: true });
    });

    it('leaves unmentioned IDs opaque after an explicit partial update and rejects invalid evidence atomically', async () => {
        const path = await indexPath();vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own'), raw('opaque')], hasNext: false } });
        const adapter = runtime(path), manifest = await adapter.conversationCatalog!('/project', { format: 'manifest' });
        await adapter.conversationIndex!('/project', { snapshotId: manifest.snapshotId, catalogFingerprint: manifest.catalogFingerprint, entries: [{ id: 'own', metadataVersion: 1, candidate }] });
        for (const entries of [
            [{ id: 'missing', metadataVersion: 1, candidate: null }],
            [{ id: 'own', metadataVersion: 2, candidate: null }],
            [{ id: 'opaque', metadataVersion: 1, candidate: null }, { id: 'opaque', metadataVersion: 1, candidate: null }],
        ]) await expect(adapter.conversationIndex!('/project', { snapshotId: manifest.snapshotId, catalogFingerprint: manifest.catalogFingerprint, entries })).rejects.toThrow();
        const restarted = runtime(path), result = await restarted.conversationCatalog!('/project', { format: 'manifest' });
        expect(result.sessions).toEqual([{ id: 'own', metadataVersion: 1, candidate }, { id: 'opaque', metadataVersion: 1 }]);
    });

    it('invalidates changed metadata and absent IDs and ignores classification submissions from an older snapshot', async () => {
        const path = await indexPath();vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own'), raw('gone')], hasNext: false } });
        const adapter = runtime(path), old = await adapter.conversationCatalog!('/project', { format: 'manifest' });
        await adapter.conversationIndex!('/project', { snapshotId: old.snapshotId, catalogFingerprint: old.catalogFingerprint,
            entries: [{ id: 'own', metadataVersion: 1, candidate }, { id: 'gone', metadataVersion: 1, candidate: null }] });
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own', raw('own').metadata, 2)], hasNext: false } });
        const fresh = await adapter.conversationCatalog!('/project', { format: 'manifest' });
        expect(fresh.sessions).toEqual([{ id: 'own', metadataVersion: 2 }]);
        await expect(adapter.conversationIndex!('/project', { snapshotId: old.snapshotId, catalogFingerprint: old.catalogFingerprint,
            entries: [{ id: 'own', metadataVersion: 1, candidate }] })).resolves.toEqual({ success: true, applied: false });
        const restarted = runtime(path), result = await restarted.conversationCatalog!('/project', { format: 'manifest' });
        expect(result.sessions).toEqual([{ id: 'own', metadataVersion: 2 }]);
    });

    it.each(['server', 'machine', 'key', 'corrupt'] as const)('treats a %s mismatch as opaque instead of trusting persisted classifications', async change => {
        const path = await indexPath();vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
        const first = runtime(path), manifest = await first.conversationCatalog!('/project', { format: 'manifest' });
        await first.conversationIndex!('/project', { snapshotId: manifest.snapshotId, catalogFingerprint: manifest.catalogFingerprint, entries: [{ id: 'own', metadataVersion: 1, candidate }] });
        if (change === 'corrupt') await writeFile(path, Buffer.from('invalid encrypted cache'));
        const other = runtime(path, change === 'server' ? { serverUrl: 'https://other.test' } : change === 'machine' ? { machineId: 'other' }
            : change === 'key' ? { indexEncryption: { ...indexEncryption, encryptionKey: new Uint8Array(32).fill(4) } } : {});
        const result = await other.conversationCatalog!('/project', { format: 'manifest' });
        expect(result.sessions).toEqual([{ id: 'own', metadataVersion: 1 }]);
    });
});

it('keeps an already-issued manifest immutable after explicit index evidence is saved', async () => {
    const path = await indexPath();vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
    const adapter = runtime(path), before = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    await adapter.conversationIndex!('/project', { snapshotId: before.snapshotId, catalogFingerprint: before.catalogFingerprint, entries: [{ id: 'own', metadataVersion: 1, candidate }] });
    expect(await adapter.conversationCatalog!('/project', { format: 'manifest', snapshotId: before.snapshotId })).toEqual(before);
    const next = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    expect(next.snapshotId).not.toBe(before.snapshotId);expect(next.sessions).toEqual([{ id: 'own', metadataVersion: 1, candidate }]);
});

it('does not let an earlier catalog request completing late overwrite a newer persisted version', async () => {
    const path = await indexPath();let resolve!: (response: any) => void;
    vi.mocked(axios.get).mockReturnValueOnce(new Promise(done => { resolve = done; }))
        .mockResolvedValue({ data: { sessions: [raw('own', raw('own').metadata, 2)], hasNext: false } });
    const adapter = runtime(path), old = adapter.conversationCatalog!('/older-project', { format: 'manifest' });
    const current = await adapter.conversationCatalog!('/newer-project', { format: 'manifest' });
    const newer = { ...candidate, metadataVersion: 2 };
    await adapter.conversationIndex!('/newer-project', { snapshotId: current.snapshotId, catalogFingerprint: current.catalogFingerprint,
        entries: [{ id: 'own', metadataVersion: 2, candidate: newer }] });
    resolve({ data: { sessions: [raw('own')], hasNext: false } });const late = await old;
    expect(late.sessions).toEqual([{ id: 'own', metadataVersion: 1 }]);
    const restarted = runtime(path), result = await restarted.conversationCatalog!('/newer-project', { format: 'manifest' });
    expect(result.sessions).toEqual([{ id: 'own', metadataVersion: 2, candidate: newer }]);
});

it('keeps failed disk writes opaque and never acknowledges unpersisted explicit evidence', async () => {
    const path = await indexPath();await mkdir(path);
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
    const adapter = runtime(path), manifest = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    expect(manifest.sessions).toEqual([{ id: 'own', metadataVersion: 1 }]);
    await expect(adapter.conversationIndex!('/project', { snapshotId: manifest.snapshotId, catalogFingerprint: manifest.catalogFingerprint,
        entries: [{ id: 'own', metadataVersion: 1, candidate }] })).rejects.toThrow(/saved/i);
    expect(await adapter.conversationCatalog!('/project', { format: 'manifest', snapshotId: manifest.snapshotId })).toEqual(manifest);
});

it('does not advertise persistent index support without the machine storage encryption key', async () => {
    const path = await indexPath();vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
    const adapter = runtime(path, { indexEncryption: undefined, legacyKey: sessionKey });
    const manifest = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    expect(manifest).not.toHaveProperty('indexSupported');
    expect(manifest.sessions[0]).toMatchObject({ candidate });
    await expect(adapter.conversationIndex!('/project', { snapshotId: manifest.snapshotId, catalogFingerprint: manifest.catalogFingerprint,
        entries: [{ id: 'own', metadataVersion: 1, candidate }] })).rejects.toThrow(/unavailable/i);
});

it('rejects oversized persisted data as opaque and bounds direct index evidence batches', async () => {
    const path = await indexPath();await writeFile(path, Buffer.alloc(17 * 1024 * 1024));
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
    const adapter = runtime(path), manifest = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    expect(manifest.sessions).toEqual([{ id: 'own', metadataVersion: 1 }]);
    await expect(adapter.conversationIndex!('/project', { snapshotId: manifest.snapshotId, catalogFingerprint: manifest.catalogFingerprint,
        entries: Array.from({ length: 201 }, () => ({ id: 'own', metadataVersion: 1, candidate: null })) })).rejects.toThrow(/limit/i);
});

it('does not let a local manifest consumer mutate another page of the fixed snapshot', async () => {
    const path = await indexPath();vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
    const adapter = runtime(path, { legacyKey: sessionKey }), first = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    try { (first.sessions[0] as any).candidate.title = 'Mutated consumer title'; } catch { /* Frozen proof is also acceptable. */ }
    const again = await adapter.conversationCatalog!('/project', { format: 'manifest', snapshotId: first.snapshotId });
    expect(again.sessions).toEqual([{ id: 'own', metadataVersion: 1, candidate }]);
});

it('shares same-project I/O while keeping each reader classification, generation and release independent', async () => {
    const path = await indexPath();
    let finish!: (response: any) => void;
    vi.mocked(axios.get).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
        .mockResolvedValue({ data: { sessions: [raw('own')], hasNext: false } });
    const adapter = runtime(path);
    const firstRead = adapter.conversationCatalog!('/project', { format: 'manifest' });
    const secondRead = adapter.conversationCatalog!('/project', { format: 'manifest' });
    expect(axios.get).toHaveBeenCalledTimes(1);
    finish({ data: { sessions: [raw('own')], hasNext: false } });
    const [first, second] = await Promise.all([firstRead, secondRead]);
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(first.sessions).toEqual([{ id: 'own', metadataVersion: 1 }]);
    expect(second.sessions).toEqual(first.sessions);
    const evidence = { catalogFingerprint: second.catalogFingerprint, entries: [{ id: 'own', metadataVersion: 1, candidate }] };
    await expect(adapter.conversationIndex!('/project', { ...evidence, snapshotId: first.snapshotId })).resolves.toEqual({ success: true, applied: false });
    await expect(adapter.conversationIndex!('/project', { ...evidence, snapshotId: second.snapshotId })).resolves.toEqual({ success: true, applied: true });
    expect(await adapter.releaseConversationCatalog!('/project', first.snapshotId)).toBe(true);
    await expect(adapter.conversationIndex!('/project', { ...evidence, snapshotId: first.snapshotId })).rejects.toThrow('unavailable');
    expect(await adapter.conversationCatalog!('/project', { format: 'manifest', snapshotId: second.snapshotId })).toEqual(second);
    expect((await adapter.conversationCatalog!('/project', { snapshotId: second.snapshotId, sessionIds: ['own'] })).sessions).toHaveLength(1);
    const next = await adapter.conversationCatalog!('/project', { format: 'manifest' });
    expect(next.sessions).toEqual([{ id: 'own', metadataVersion: 1, candidate }]);
    expect(axios.get).toHaveBeenCalledTimes(2);
});
