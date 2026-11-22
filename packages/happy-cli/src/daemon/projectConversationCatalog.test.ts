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
    it.each(['ciphertext', 'manifest'] as const)('keeps issued %s tokens readable when a third small catalog is created', async format => {
        let now = 1000;
        const rows = [row('a', Buffer.alloc(110 * 1024, 1).toString('base64')), row('b', Buffer.alloc(110 * 1024, 2).toString('base64'))];
        const store = createProjectConversationCatalog(async () => rows, () => now);
        const first = await store.page('/a', format === 'manifest' ? { format } : {});
        const second = await store.page('/b', {});
        now += 20_000;
        const third = await store.page('/c', {});
        expect(new Set([first.snapshotId, second.snapshotId, third.snapshotId]).size).toBe(3);
        // A manifest still needs its token for selected ciphertext and grouping.
        const selected = await store.page('/a', { snapshotId: first.snapshotId, sessionIds: ['b'] });
        expect(selected.sessions.map(item => item.id)).toEqual(['b']);
        expect(selected.expiresAt).toBe(301000);
        for (const [project, snapshot] of [['/a', first], ['/b', second], ['/c', third]] as const)
            expect(store.read(project, snapshot.snapshotId, snapshot.catalogFingerprint).map(item => item.id)).toEqual(['a', 'b']);
    });
    it('reserves worst-case pending bytes without evicting a published token, then converts the reservation to actual bytes', async () => {
        let resolve!: (rows: ProjectConversationRawHeader[]) => void;
        let loads = 0;
        const store = createProjectConversationCatalog(() => {
            loads++;
            return loads === 2 ? new Promise<ProjectConversationRawHeader[]>(done => { resolve = done; }) : Promise.resolve([row('a')]);
        });
        const first = await store.page('/a', {});
        const pending = store.page('/b', {});
        const excess = store.page('/c', {}).then(value => value, error => error);
        const firstAgain = store.page('/a', { snapshotId: first.snapshotId }).then(value => value, error => error);
        resolve([row('b')]);
        const second = await pending;
        expect(await firstAgain).toMatchObject({ sessions: [{ id: 'a' }] });
        expect(await excess).toBeInstanceOf(Error);
        expect((await excess).message).toMatch(/busy/);
        expect(loads).toBe(2);
        const third = await store.page('/c', {});
        expect(store.read('/b', second.snapshotId, second.catalogFingerprint).map(item => item.id)).toEqual(['b']);
        expect(store.read('/c', third.snapshotId, third.catalogFingerprint).map(item => item.id)).toEqual(['a']);
    });
    it('bounds small resident snapshots by count without revoking any of the issued tokens', async () => {
        const load = vi.fn(async () => [row('a')]), store = createProjectConversationCatalog(load);
        const pages = [];
        for (let index = 0; index < 32; index++) pages.push(await store.page('/project', {}));
        const excess = await store.page('/project', {}).then(value => value, error => error);
        for (const page of pages) expect(store.read('/project', page.snapshotId, page.catalogFingerprint)).toHaveLength(1);
        expect(excess).toBeInstanceOf(Error); expect(excess.message).toMatch(/busy/);
        expect(load).toHaveBeenCalledTimes(32);
        expect(store.release('/project', pages[0].snapshotId)).toBe(true);
        const next = await store.page('/project', {});
        expect(store.read('/project', next.snapshotId, next.catalogFingerprint)).toHaveLength(1);
    });
    it('reclaims expired capacity without renewing an unexpired same-project token', async () => {
        let now = 1000;
        const store = createProjectConversationCatalog(async () => [row('a')], () => now);
        const first = await store.page('/project', {});
        now += 20_000;
        const second = await store.page('/project', {});
        expect(second.snapshotId).not.toBe(first.snapshotId);
        now = first.expiresAt;
        const third = await store.page('/project', {});
        expect(third.snapshotId).not.toBe(second.snapshotId);
        await expect(store.page('/project', { snapshotId: first.snapshotId })).rejects.toThrow('expired');
        expect((await store.page('/project', { snapshotId: second.snapshotId })).expiresAt).toBe(321000);
        expect(store.read('/project', third.snapshotId, third.catalogFingerprint)).toHaveLength(1);
    });
    it('releases a failed creation reservation while preserving an existing token', async () => {
        let loads = 0;
        const store = createProjectConversationCatalog(async () => {
            loads++;
            return loads === 2 ? [{ ...row('bad'), metadata: '' }] : [row('a')];
        });
        const first = await store.page('/a', {});
        await expect(store.page('/b', {})).rejects.toThrow();
        const second = await store.page('/c', {});
        expect(store.read('/a', first.snapshotId, first.catalogFingerprint).map(item => item.id)).toEqual(['a']);
        expect(store.read('/c', second.snapshotId, second.catalogFingerprint).map(item => item.id)).toEqual(['a']);
    });
    it('releases only the requested snapshot and makes repeated or unknown releases harmless', async () => {
        const store = createProjectConversationCatalog(async () => [row('a')]);
        const first = await store.page('/project', {}), second = await store.page('/project', {});
        expect(store.release('/project', first.snapshotId)).toBe(true);
        expect(store.release('/project', first.snapshotId)).toBe(false);
        expect(store.release('/project', 'unknown')).toBe(false);
        await expect(store.page('/project', { snapshotId: first.snapshotId })).rejects.toThrow('unavailable');
        expect(store.read('/project', second.snapshotId, second.catalogFingerprint)).toHaveLength(1);
    });
    it('refuses cross-project release without altering the valid owner token and isolates runtimes', async () => {
        const store = createProjectConversationCatalog(async () => [row('a')]);
        const first = await store.page('/project', {});
        expect(store.release('/other', first.snapshotId)).toBe(false);
        const other = createProjectConversationCatalog(async () => [row('b')]);
        expect(other.release('/project', first.snapshotId)).toBe(false);
        expect(store.read('/project', first.snapshotId, first.catalogFingerprint)).toHaveLength(1);
    });
    it('returns false for an expired release and rejects release after disposal', async () => {
        let now = 1000;
        const store = createProjectConversationCatalog(async () => [row('a')], () => now);
        const first = await store.page('/project', {});
        now = first.expiresAt;
        expect(store.release('/project', first.snapshotId)).toBe(false);
        store.dispose();
        expect(() => store.release('/project', first.snapshotId)).toThrow('disposed');
    });
    it('makes released bytes immediately available to another worst-case pending load', async () => {
        const resolvers: Array<(rows: ProjectConversationRawHeader[]) => void> = [];
        let loads = 0;
        const store = createProjectConversationCatalog(() => ++loads === 1 ? Promise.resolve([row('a')])
            : new Promise<ProjectConversationRawHeader[]>(resolve => { resolvers.push(resolve); }));
        const first = await store.page('/a', {}), pending = store.page('/b', {});
        const excess = await store.page('/c', {}).then(value => value, error => error);
        expect(excess).toBeInstanceOf(Error); expect(excess.message).toMatch(/busy/);
        expect(store.release('/a', first.snapshotId)).toBe(true);
        const retry = store.page('/c', {});
        expect(resolvers).toHaveLength(2);
        resolvers.forEach(resolve => resolve([row('next')]));
        const [second, third] = await Promise.all([pending, retry]);
        expect(store.read('/b', second.snapshotId, second.catalogFingerprint)).toHaveLength(1);
        expect(store.read('/c', third.snapshotId, third.catalogFingerprint)).toHaveLength(1);
    });
    it('does not cancel a pending same-project fresh load when releasing its earlier token', async () => {
        let resolve!: (rows: ProjectConversationRawHeader[]) => void;
        let loads = 0;
        const store = createProjectConversationCatalog(() => ++loads === 1 ? Promise.resolve([row('first')])
            : new Promise<ProjectConversationRawHeader[]>(done => { resolve = done; }));
        const first = await store.page('/project', {}), pending = store.page('/project', {});
        expect(store.release('/project', first.snapshotId)).toBe(true);
        resolve([row('fresh')]);
        const fresh = await pending;
        expect(store.read('/project', fresh.snapshotId, fresh.catalogFingerprint).map(item => item.id)).toEqual(['fresh']);
    });
    it('shares pending same-project I/O while issuing independent reader tokens and bounding reservations', async () => {
        let resolve!: (value: ProjectConversationRawHeader[]) => void;
        const load = vi.fn(() => new Promise<ProjectConversationRawHeader[]>(r => { resolve = r; }));
        const store = createProjectConversationCatalog(load), first = store.page('/a', {}), same = store.page('/a', {});
        expect(load).toHaveBeenCalledTimes(1); resolve([row('a')]); expect((await first).snapshotId).not.toBe((await same).snapshotId);
        const resolvers: Array<(value: ProjectConversationRawHeader[]) => void> = [];
        const busy = createProjectConversationCatalog(() => new Promise(r => resolvers.push(r)));
        const one = busy.page('/a', {}), two = busy.page('/b', {}); await expect(busy.page('/c', {})).rejects.toThrow('busy');
        resolvers.forEach(r => r([row('a')])); await Promise.all([one, two]);
    });
    it('releasing one concurrent same-project reader cannot revoke another reader token', async () => {
        let resolve!: (rows: ProjectConversationRawHeader[]) => void;
        const load = vi.fn(() => new Promise<ProjectConversationRawHeader[]>(done => { resolve = done; }));
        const store = createProjectConversationCatalog(load);
        const firstRead = store.page('/project', { format: 'manifest' });
        const secondRead = store.page('/project', {});
        resolve([row('a'), row('b')]);
        const [first, second] = await Promise.all([firstRead, secondRead]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(store.release('/project', first.snapshotId)).toBe(true);
        expect(store.release('/project', first.snapshotId)).toBe(false);
        const selected = await store.page('/project', { snapshotId: second.snapshotId, sessionIds: ['b'] });
        expect(selected.sessions.map(item => item.id)).toEqual(['b']);
        const manifest = await store.page('/project', { snapshotId: second.snapshotId, format: 'manifest' });
        expect(manifest.sessions.map(item => item.id)).toEqual(['a', 'b']);
        expect(store.read('/project', second.snapshotId, second.catalogFingerprint).map(item => item.id)).toEqual(['a', 'b']);
    });
    it('reserves a worst-case slot for each same-project reader even when their source I/O is shared', async () => {
        let resolve!: (rows: ProjectConversationRawHeader[]) => void;
        const load = vi.fn(() => new Promise<ProjectConversationRawHeader[]>(done => { resolve = done; }));
        const store = createProjectConversationCatalog(load);
        const one = store.page('/project', {}), two = store.page('/project', {});
        const excess = store.page('/project', {}).then(value => value, error => error);
        resolve([row('a')]);
        const [first, second] = await Promise.all([one, two]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(await excess).toBeInstanceOf(Error); expect((await excess).message).toMatch(/busy/);
        expect(first.snapshotId).not.toBe(second.snapshotId);
        expect(store.read('/project', first.snapshotId, first.catalogFingerprint)).toHaveLength(1);
        expect(store.read('/project', second.snapshotId, second.catalogFingerprint)).toHaveLength(1);
    });
    it('clears every failed shared reader reservation before the same project retries', async () => {
        let reject!: (reason: Error) => void;
        const load = vi.fn<() => Promise<ProjectConversationRawHeader[]>>()
            .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
            .mockResolvedValue([row('retry')]);
        const store = createProjectConversationCatalog(load);
        const first = store.page('/project', {}), second = store.page('/project', {});
        const results = Promise.allSettled([first, second]);
        reject(new Error('Source request failed'));
        expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
        const retry = await store.page('/project', {});
        expect(store.read('/project', retry.snapshotId, retry.catalogFingerprint).map(item => item.id)).toEqual(['retry']);
        expect(load).toHaveBeenCalledTimes(2);
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

describe('lightweight manifest and selected ciphertext catalog pages', () => {
    it('returns one manifest page without ciphertext while retaining the complete immutable snapshot', async () => {
        const rows = [row('a', Buffer.alloc(110 * 1024, 1).toString('base64')), row('b', Buffer.alloc(110 * 1024, 2).toString('base64'))];
        const load = vi.fn(async () => rows), store = createProjectConversationCatalog(load);
        const manifest = await store.page('/project', { format: 'manifest' });
        expect(manifest).toMatchObject({ format: 'manifest', total: 2, hasNext: false, nextCursor: null });
        expect(manifest.sessions).toEqual([{ id: 'a', metadataVersion: 1 }, { id: 'b', metadataVersion: 1 }]);
        expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(256 * 1024);
        const raw = await store.page('/project', { snapshotId: manifest.snapshotId });
        expect(raw.sessions).toHaveLength(1); expect(raw.hasNext).toBe(true);
        expect(raw.catalogFingerprint).toBe(manifest.catalogFingerprint);
        expect(store.read('/project', manifest.snapshotId, manifest.catalogFingerprint)).toHaveLength(2);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('pages a large manifest under the same 256KiB envelope and preserves its complete fingerprint', async () => {
        const rows = Array.from({ length: 2500 }, (_, i) => row(`session-${String(i).padStart(4, '0')}-` + 'x'.repeat(160)));
        const store = createProjectConversationCatalog(async () => rows);
        const first = await store.page('/project', { format: 'manifest' });
        expect(first.hasNext).toBe(true); expect(first.sessions.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
        const last = await store.page('/project', { snapshotId: first.snapshotId, cursor: first.nextCursor!, format: 'manifest' });
        expect(last.hasNext).toBe(false); expect(last.total).toBe(rows.length);
        expect(last.catalogFingerprint).toBe(first.catalogFingerprint); expect(last.expiresAt).toBe(first.expiresAt);
        expect([...first.sessions, ...last.sessions].map(item => item.id)).toEqual(rows.map(item => item.id));
        expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThan(256 * 1024);
    });

    it('selects exact snapshot ciphertext in deduplicated request order without changing the full fingerprint or read contract', async () => {
        const rows = [row('a'), row('b'), row('c')], load = vi.fn(async () => rows), store = createProjectConversationCatalog(load);
        const manifest = await store.page('/project', { format: 'manifest' });
        const old = rows[1].metadata; rows[1].metadata = Buffer.from('newer than snapshot').toString('base64');
        const selected = await store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: ['b', 'a', 'b'] });
        expect(selected.total).toBe(2); expect(selected.sessions.map(item => item.id)).toEqual(['b', 'a']);
        expect(selected.sessions[0]).toMatchObject({ metadata: old, dataEncryptionKey: null });
        expect(selected).not.toHaveProperty('format'); expect(selected.hasNext).toBe(false);
        expect(selected.catalogFingerprint).toBe(manifest.catalogFingerprint); expect(selected.expiresAt).toBe(manifest.expiresAt);
        expect(store.read('/project', manifest.snapshotId, selected.catalogFingerprint)).toHaveLength(3);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('uses offsets within the selected ID list when ciphertext needs more than one bounded page', async () => {
        const rows = ['a', 'b', 'c'].map((id, i) => row(id, Buffer.alloc(110 * 1024, i).toString('base64')));
        const store = createProjectConversationCatalog(async () => rows), manifest = await store.page('/project', { format: 'manifest' });
        const first = await store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: ['c', 'a'] });
        expect(first.total).toBe(2); expect(first.sessions.map(item => item.id)).toEqual(['c']); expect(first.nextCursor).toBe('1');
        const last = await store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: ['c', 'a'], cursor: first.nextCursor! });
        expect(last.total).toBe(2); expect(last.sessions.map(item => item.id)).toEqual(['a']); expect(last.hasNext).toBe(false);
        expect(last.catalogFingerprint).toBe(manifest.catalogFingerprint);
        for (const page of [first, last]) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
        await expect(store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: ['c', 'a'], cursor: '2' })).rejects.toThrow('cursor');
    });

    it('fails the entire selection for unknown identities or missing snapshot without creating a new snapshot', async () => {
        const load = vi.fn(async () => [row('a')]), store = createProjectConversationCatalog(load);
        await expect(store.page('/project', { sessionIds: ['a'] })).rejects.toThrow(/snapshot/i);
        expect(load).not.toHaveBeenCalled();
        const manifest = await store.page('/project', { format: 'manifest' });
        await expect(store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: ['a', 'missing'] })).rejects.toThrow(/unknown|unavailable|session/i);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('accepts an explicit empty selection and rejects manifest combinations, invalid IDs and oversized batches', async () => {
        const store = createProjectConversationCatalog(async () => [row('a')]), manifest = await store.page('/project', { format: 'manifest' });
        const empty = await store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: [] });
        expect(empty).toMatchObject({ total: 0, sessions: [], hasNext: false, nextCursor: null, catalogFingerprint: manifest.catalogFingerprint });
        for (const input of [
            { sessionIds: ['a'], format: 'manifest' },
            { sessionIds: [''] },
            { sessionIds: Array.from({ length: 201 }, () => 'a') },
        ]) await expect(store.page('/project', { snapshotId: manifest.snapshotId, ...input } as any)).rejects.toThrow();
    });

    it('applies project binding and expiration to both manifest and selected requests', async () => {
        let now = 1000; const store = createProjectConversationCatalog(async () => [row('a')], () => now);
        const manifest = await store.page('/project', { format: 'manifest' });
        await expect(store.page('/other', { snapshotId: manifest.snapshotId, format: 'manifest' })).rejects.toThrow('another project');
        await expect(store.page('/other', { snapshotId: manifest.snapshotId, sessionIds: ['a'] })).rejects.toThrow('another project');
        now = manifest.expiresAt;
        await expect(store.page('/project', { snapshotId: manifest.snapshotId, format: 'manifest' })).rejects.toThrow('expired');
        await expect(store.page('/project', { snapshotId: manifest.snapshotId, sessionIds: ['a'] })).rejects.toThrow('expired');
    });
});
