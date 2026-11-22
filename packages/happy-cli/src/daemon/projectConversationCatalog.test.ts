import { describe, expect, it, vi } from 'vitest';
import { createProjectConversationCatalog, type ProjectConversationRawHeader } from './projectConversationCatalog';
const row = (id: string, metadata = Buffer.from('encrypted metadata').toString('base64')): ProjectConversationRawHeader => ({ id, metadata, metadataVersion: 1, dataEncryptionKey: null, seq: 1, updatedAt: 10, active: false });
describe('immutable project conversation catalogs', () => {
    it('pages ciphertext under 256KiB and preserves one immutable complete catalog', async () => {
        const rows = [row('a', Buffer.alloc(110 * 1024).toString('base64')), row('b', Buffer.alloc(110 * 1024).toString('base64'))];
        const load = vi.fn(async () => rows), store = createProjectConversationCatalog(load);
        const first = await store.page('/project', {});
        expect(first.sessions).toHaveLength(1); expect(first.total).toBe(2); expect(first.hasNext).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
        expect(Object.keys(first.sessions[0]).sort()).toEqual(['dataEncryptionKey', 'id', 'metadata', 'metadataVersion']);
        rows[1].metadata = Buffer.from('changed after snapshot').toString('base64'); rows.push(row('new'));
        const last = await store.page('/project', { snapshotId: first.snapshotId, cursor: first.nextCursor! });
        expect(last.total).toBe(2); expect(last.sessions.map(r => r.id)).toEqual(['b']); expect(last.hasNext).toBe(false); expect(last.nextCursor).toBeNull();
        expect(last.sessions[0].metadata).not.toBe(rows[1].metadata); expect(load).toHaveBeenCalledTimes(1);
        expect(store.read('/project', first.snapshotId, first.catalogFingerprint)).toHaveLength(2);
    });
    it('binds tokens to project/runtime and expires them lazily after five minutes', async () => {
        let now = 1000; const store = createProjectConversationCatalog(async () => [row('a')], () => now);
        const first = await store.page('/project', {});
        expect(first.snapshotId).toMatch(/^[a-zA-Z0-9_-]{32}$/); expect(first.expiresAt).toBe(301000);
        await expect(store.page('/other', { snapshotId: first.snapshotId })).rejects.toThrow('another project');
        expect(() => store.read('/project', first.snapshotId, '0'.repeat(64))).toThrow('fingerprint');
        await expect(createProjectConversationCatalog(async () => [row('a')]).page('/project', { snapshotId: first.snapshotId })).rejects.toThrow('unavailable');
        now = first.expiresAt; await expect(store.page('/project', { snapshotId: first.snapshotId })).rejects.toThrow('expired');
        expect(() => store.read('/project', first.snapshotId, first.catalogFingerprint)).toThrow('expired');
    });
    it('retains at most two snapshots and explicitly rejects an evicted token', async () => {
        const store = createProjectConversationCatalog(async () => [row('a')]);
        const a = await store.page('/a', {}), b = await store.page('/b', {}), c = await store.page('/c', {});
        expect(new Set([a.snapshotId, b.snapshotId, c.snapshotId]).size).toBe(3);
        await expect(store.page('/a', { snapshotId: a.snapshotId })).rejects.toThrow('unavailable');
        expect((await store.page('/b', { snapshotId: b.snapshotId })).total).toBe(1);
    });
    it('shares a pending same-project load and bounds concurrent catalog reservations', async () => {
        let resolve!: (value: ProjectConversationRawHeader[]) => void;
        const load = vi.fn(() => new Promise<ProjectConversationRawHeader[]>(r => { resolve = r; }));
        const store = createProjectConversationCatalog(load), first = store.page('/a', {}), same = store.page('/a', {});
        expect(load).toHaveBeenCalledTimes(1); resolve([row('a')]); expect((await first).snapshotId).toBe((await same).snapshotId);
        const resolvers: Array<(value: ProjectConversationRawHeader[]) => void> = [];
        const busy = createProjectConversationCatalog(() => new Promise(r => resolvers.push(r)));
        const one = busy.page('/a', {}), two = busy.page('/b', {}); await expect(busy.page('/c', {})).rejects.toThrow('busy');
        resolvers.forEach(r => r([row('a')])); await Promise.all([one, two]);
    });
    it('rejects duplicate identities, malformed metadata/version and oversized headers', async () => {
        for (const rows of [[row('a'), row('a')], [{ ...row('a'), metadata: '' }], [{ ...row('a'), metadataVersion: -1 }], [row('large', Buffer.alloc(200 * 1024).toString('base64'))]])
            await expect(createProjectConversationCatalog(async () => rows).page('/project', {})).rejects.toThrow();
    });
    it('rejects more than 20k records or 64MiB of projected headers', async () => {
        await expect(createProjectConversationCatalog(async () => Array.from({ length: 20001 }, (_, i) => row(String(i)))).page('/project', {})).rejects.toThrow('record limit');
        const metadata = Buffer.alloc(3 * 1024).toString('base64');
        await expect(createProjectConversationCatalog(async () => Array.from({ length: 20000 }, (_, i) => row(String(i), metadata))).page('/project', {})).rejects.toThrow('snapshot byte limit');
    });
    it('requires a snapshot for cursors and validates numeric offsets', async () => {
        const store = createProjectConversationCatalog(async () => [row('a')]);
        await expect(store.page('/project', { cursor: '1' })).rejects.toThrow('requires its snapshot');
        const page = await store.page('/project', {});
        for (const cursor of ['-1', '1.5', '100', 'bogus']) await expect(store.page('/project', { snapshotId: page.snapshotId, cursor })).rejects.toThrow('cursor');
    });
});

it('disposes cached catalogs and fences a pending load before it can repopulate the store', async () => {
    let resolve!: (value: ProjectConversationRawHeader[]) => void;
    const store = createProjectConversationCatalog(() => new Promise(r => { resolve = r; }));
    const loading = store.page('/project', {}); store.dispose(); resolve([row('a')]);
    await expect(loading).rejects.toThrow('disposed');
    await expect(store.page('/project', {})).rejects.toThrow('disposed');
});
