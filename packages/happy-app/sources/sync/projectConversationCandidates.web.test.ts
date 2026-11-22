import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    owner: { key: 'a', generation: '1', serverUrl: 'https://example.test', scope: 'test' },
    metadata: new Map<string, any>(), encryption: {} as any,
}));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => mock.owner, assertAccountRuntime: () => {} }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn().mockResolvedValue({ token: 'private-token', secret: 'private-secret' }) } }));
vi.mock('./sync', () => ({ sync: { get encryption() { return mock.encryption; } } }));
vi.mock('./apiSessions', () => ({ fetchSessionSnapshotPage: vi.fn() }));
vi.mock('./projectGoals', () => ({ projectGoalRequest: vi.fn() }));

import { TokenStorage } from '@/auth/tokenStorage';
import { fetchSessionSnapshotPage } from './apiSessions';
import { projectGoalRequest } from './projectGoals';
import { loadProjectConversationCandidates, type ProjectConversationHistoryProgress } from './projectConversationCandidates.web';

const machineId = 'selected-machine', projectPath = '/projects/paws';
const snapshotA = '00000000-0000-4000-8000-000000000001';
const snapshotB = '00000000-0000-4000-8000-000000000002';
let catalogExpiry: number;
const encryptedRow = (id: string, metadataVersion = 3) => ({ id, metadataVersion, metadata: Buffer.from(`encrypted-${id}`).toString('base64'), dataEncryptionKey: Buffer.from('private-wrapped-key').toString('base64') });
type RawRow = ReturnType<typeof encryptedRow>;
async function digest(rows: RawRow[]) {
    const pairs = rows.map(row => [row.id, row.metadataVersion] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(pairs)));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function catalog(rows: RawRow[] = [encryptedRow('one')], extra: Record<string, unknown> = {}) {
    return { success: true, projectPath, snapshotId: snapshotA, catalogFingerprint: await digest(rows), total: rows.length,
        sessions: rows, nextCursor: null, hasNext: false, expiresAt: catalogExpiry, ...extra };
}
function makeEncryption() {
    return {
        decryptEncryptionKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
        prepareSessionEncryption: vi.fn(async (id: string) => ({
            sessionEncryption: { decryptMetadata: vi.fn(async () => mock.metadata.get(id)) }, commit: vi.fn(),
        })),
    };
}
async function twoPages(firstExtra: Record<string, unknown> = {}, secondExtra: Record<string, unknown> = {}) {
    const all = [encryptedRow('one'), encryptedRow('other')];
    const fingerprint = await digest(all);
    return [
        await catalog([all[0]], { total: 2, catalogFingerprint: fingerprint, hasNext: true, nextCursor: 'catalog-next-1', ...firstExtra }),
        await catalog([all[1]], { total: 2, catalogFingerprint: fingerprint, ...secondExtra }),
    ];
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
beforeEach(() => {
    vi.resetAllMocks();
    catalogExpiry = Date.now() + 60_000;
    vi.mocked(TokenStorage.getCredentials).mockResolvedValue({ token: 'private-token', secret: 'private-secret' });
    mock.owner = { key: 'a', generation: '1', serverUrl: 'https://example.test', scope: 'test' };
    mock.metadata = new Map([
        ['one', { machineId, host: 'fixture-host', path: '/archive/task', goalBoard: { featurePath: '/projects/paws/features/web', taskId: 'GFT-abcd1234' }, summary: { text: 'Task discussion', updatedAt: 1 } }],
        ['other', { machineId: 'other-machine', host: 'fixture-host', path: '/other' }],
    ]);
    mock.encryption = makeEncryption();
    vi.mocked(fetchSessionSnapshotPage).mockRejectedValue(new Error('Legacy session snapshot endpoint must not be used'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('daemon-owned immutable project conversation catalogs', () => {
    it('exhausts one immutable snapshot, verifies its complete digest, and exports only selected-machine compact metadata', async () => {
        const pages = await twoPages();
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        const result = await loadProjectConversationCandidates(machineId, projectPath);
        expect(projectGoalRequest).toHaveBeenNthCalledWith(1, machineId, 'goalProjectConversationCatalog', { projectPath });
        expect(projectGoalRequest).toHaveBeenNthCalledWith(2, machineId, 'goalProjectConversationCatalog', { projectPath, snapshotId: snapshotA, cursor: 'catalog-next-1' });
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
        expect(fetchSessionSnapshotPage).not.toHaveBeenCalled();
        expect(result).toEqual({ candidates: [{ sessionId: 'one', metadataVersion: 3, directory: '/archive/task', title: 'Task discussion',
            featurePath: '/projects/paws/features/web', taskId: 'GFT-abcd1234' }], catalogFingerprint: pages[0].catalogFingerprint, catalogSnapshotId: snapshotA });
        expect(mock.encryption.prepareSessionEncryption).toHaveBeenCalledWith('one', expect.any(Uint8Array));
        for (const prepared of mock.encryption.prepareSessionEncryption.mock.results) expect((await prepared.value).commit).not.toHaveBeenCalled();
        const first = await mock.encryption.prepareSessionEncryption.mock.results[0].value;
        expect(first.sessionEncryption.decryptMetadata).toHaveBeenCalledExactlyOnceWith(3, pages[0].sessions[0].metadata);
        expect(JSON.stringify(result)).not.toMatch(/private-|wrapped|encryptionKey|secret|host|other-machine/);
    });

    it('hashes all account metadata versions, including sessions excluded by the machine filter', async () => {
        const rows = [encryptedRow('other', 8), encryptedRow('one', 2)];
        const page = await catalog(rows); vi.mocked(projectGoalRequest).mockResolvedValue(page);
        const result = await loadProjectConversationCandidates(machineId, projectPath);
        expect(result.catalogFingerprint).toBe(await digest(rows));
        expect(result.candidates.map(candidate => candidate.sessionId)).toEqual(['one']);
        expect(result.candidates[0].metadataVersion).toBe(2);
    });

    it.each([
        ['snapshot identity', { snapshotId: snapshotB }],
        ['project path', { projectPath: '/projects/other' }],
        ['total', { total: 3 }],
        ['catalog fingerprint', { catalogFingerprint: '0'.repeat(64) }],
    ] as const)('rejects a changed %s between pages', async (_name, change) => {
        const pages = await twoPages({}, change);
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow();
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    });

    it('rejects duplicate session IDs rather than quietly deduplicating a corrupted catalog', async () => {
        const rows = [encryptedRow('one'), encryptedRow('one')];
        const fingerprint = await digest(rows);
        vi.mocked(projectGoalRequest)
            .mockResolvedValueOnce(await catalog([rows[0]], { total: 2, catalogFingerprint: fingerprint, hasNext: true, nextCursor: 'catalog-next-1' }))
            .mockResolvedValueOnce(await catalog([rows[1]], { total: 2, catalogFingerprint: fingerprint }));
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/duplicate|catalog/i);
    });

    it.each([undefined, 'catalog-next-1'])('rejects missing or repeated next cursor (%s) before issuing another page', async nextCursor => {
        const pages = await twoPages({}, { hasNext: true, nextCursor });
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/cursor|catalog/i);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    });

    it('rejects an incomplete final page rather than trusting the advertised total', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog([encryptedRow('one')], { total: 2 }));
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/total|catalog|complete/i);
    });

    it('rejects a final digest that disagrees with the server fingerprint', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog([encryptedRow('one')], { catalogFingerprint: 'f'.repeat(64) }));
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/fingerprint|catalog/i);
    });

    it('rejects a first page for a different project', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog([encryptedRow('one')], { projectPath: '/projects/other' }));
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/project|scope|catalog/i);
    });

    it('rejects unreadable record keys and null metadata without returning partial candidates', async () => {
        mock.encryption.decryptEncryptionKey.mockResolvedValueOnce(null);
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog());
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/decrypt|key|history/i);
        mock.encryption = makeEncryption(); mock.metadata.set('one', null);
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/metadata|decrypt|history/i);
    });

    it('requires valid selected-machine path metadata', async () => {
        mock.metadata.set('one', { machineId, host: 'fixture-host' });
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog());
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow();
    });

    it('supports legacy records without a wrapped data key through detached preparation', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog([{ ...encryptedRow('one'), dataEncryptionKey: null } as any]));
        const result = await loadProjectConversationCandidates(machineId, projectPath);
        expect(result.candidates).toHaveLength(1);
        expect(mock.encryption.decryptEncryptionKey).not.toHaveBeenCalled();
        expect(mock.encryption.prepareSessionEncryption).toHaveBeenCalledWith('one', null);
    });

    it('rejects an account change while a catalog request is in flight', async () => {
        const pending = deferred<any>(); vi.mocked(projectGoalRequest).mockReturnValue(pending.promise);
        const request = loadProjectConversationCandidates(machineId, projectPath);
        const outcome = request.then(() => undefined, error => error);
        await Promise.resolve(); mock.owner = { ...mock.owner, generation: 'replacement' };
        pending.resolve(await catalog());
        const error = await outcome;
        expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(/account|changed/i);
        expect(mock.encryption.prepareSessionEncryption).not.toHaveBeenCalled();
    });

    it.each(['account', 'encryption'] as const)('fences a replaced %s during metadata decryption', async replacement => {
        const original = mock.encryption;
        original.prepareSessionEncryption.mockImplementation(async () => ({ sessionEncryption: { decryptMetadata: async () => {
            if (replacement === 'account') mock.owner = { ...mock.owner, generation: 'replacement' };
            else mock.encryption = makeEncryption();
            return mock.metadata.get('one');
        } }, commit: vi.fn() }));
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog());
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/account|changed/i);
    });

    it('never requests another page after an account switch during a finite decryption yield', async () => {
        const rows = Array.from({ length: 32 }, (_, index) => encryptedRow(`yield-${index}`));
        for (const row of rows) mock.metadata.set(row.id, { machineId, host: 'fixture-host', path: `/work/${row.id}` });
        const all = [...rows, encryptedRow('other')], fingerprint = await digest(all);
        vi.mocked(projectGoalRequest)
            .mockResolvedValueOnce(await catalog(rows, { total: 33, catalogFingerprint: fingerprint, hasNext: true, nextCursor: 'after-yield' }))
            .mockResolvedValueOnce(await catalog([all[32]], { total: 33, catalogFingerprint: fingerprint }));
        const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(((callback: () => void) => {
            mock.owner = { ...mock.owner, generation: 'replacement' }; queueMicrotask(callback); return 0;
        }) as any);
        try {
            await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow(/account|changed/i);
            expect(projectGoalRequest).toHaveBeenCalledTimes(1);
        } finally { timer.mockRestore(); }
    });
});

describe('project history progress', () => {
    it('publishes the first page progress while the next page is still pending', async () => {
        const pages = await twoPages(), nextStarted = deferred<void>(), nextPage = deferred<any>();
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockImplementationOnce(async () => {
            nextStarted.resolve();
            return nextPage.promise;
        });
        const progress: ProjectConversationHistoryProgress[] = [];
        const request = loadProjectConversationCandidates(machineId, projectPath, { onProgress: value => progress.push(value) });
        await nextStarted.promise;
        expect(progress).toEqual([
            { phase: 'catalog', processed: 0, total: 0 },
            { phase: 'catalog', processed: 1, total: 2 },
        ]);
        nextPage.resolve(pages[1]);
        await request;
        expect(progress.at(-1)).toEqual({ phase: 'catalog', processed: 2, total: 2 });
    });

    it('reports fully decoded page counts across all machines without claiming grouping or completion', async () => {
        const pages = await twoPages();
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        const progress: ProjectConversationHistoryProgress[] = [];
        const result = await loadProjectConversationCandidates(machineId, projectPath, { onProgress: value => progress.push(value) });
        expect(result.candidates).toHaveLength(1);
        expect(progress).toEqual([
            { phase: 'catalog', processed: 0, total: 0 },
            { phase: 'catalog', processed: 1, total: 2 },
            { phase: 'catalog', processed: 2, total: 2 },
        ]);
    });

    it('does not advance progress for a page with unreadable metadata', async () => {
        const rows = [encryptedRow('one'), encryptedRow('other')];
        mock.metadata.set('other', null);
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog(rows));
        const progress: ProjectConversationHistoryProgress[] = [];
        await expect(loadProjectConversationCandidates(machineId, projectPath, { onProgress: value => progress.push(value) })).rejects.toThrow(/metadata/i);
        expect(progress).toEqual([{ phase: 'catalog', processed: 0, total: 0 }]);
    });

    it('does not advance progress for a page whose cursor did not advance', async () => {
        const pages = await twoPages({}, { hasNext: true, nextCursor: 'catalog-next-1' });
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        const progress: ProjectConversationHistoryProgress[] = [];
        await expect(loadProjectConversationCandidates(machineId, projectPath, { onProgress: value => progress.push(value) })).rejects.toThrow(/cursor/i);
        expect(progress).toEqual([
            { phase: 'catalog', processed: 0, total: 0 },
            { phase: 'catalog', processed: 1, total: 2 },
        ]);
    });

    it('does not report grouping or completed results for a catalog that fails its final fingerprint', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog(undefined, { catalogFingerprint: 'f'.repeat(64) }));
        const progress: ProjectConversationHistoryProgress[] = [];
        await expect(loadProjectConversationCandidates(machineId, projectPath, { onProgress: value => progress.push(value) })).rejects.toThrow(/fingerprint/i);
        expect(progress).toEqual([
            { phase: 'catalog', processed: 0, total: 0 },
            { phase: 'catalog', processed: 1, total: 1 },
        ]);
    });

    it('reports the full account total on a complete cache hit instead of only selected-machine candidates', async () => {
        const pages = await twoPages();
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        await loadProjectConversationCandidates(machineId, projectPath);
        const progress: ProjectConversationHistoryProgress[] = [];
        const result = await loadProjectConversationCandidates(machineId, projectPath, { onProgress: value => progress.push(value) });
        expect(result.candidates).toHaveLength(1);
        expect(progress).toEqual([{ phase: 'catalog', processed: 2, total: 2 }]);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    });

    it.each(['account', 'encryption', 'cancel'] as const)('fences cached progress when %s ownership changes before delivery', async replacement => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog());
        await loadProjectConversationCandidates(machineId, projectPath);
        const controller = new AbortController();
        const progress: ProjectConversationHistoryProgress[] = [];
        const request = loadProjectConversationCandidates(machineId, projectPath, {
            ...(replacement === 'cancel' ? { signal: controller.signal } : {}),
            onProgress: value => progress.push(value),
        });
        if (replacement === 'account') mock.owner = { ...mock.owner };
        else if (replacement === 'encryption') mock.encryption = makeEncryption();
        else controller.abort();
        await expect(request).rejects.toThrow();
        expect(progress).toEqual([]);
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
    });

    it.each(['account', 'cancel'] as const)('stops after the first progress callback changes %s ownership', async replacement => {
        const controller = new AbortController();
        const progress: ProjectConversationHistoryProgress[] = [];
        await expect(loadProjectConversationCandidates(machineId, projectPath, { signal: controller.signal, onProgress: value => {
            progress.push(value);
            if (replacement === 'account') mock.owner = { ...mock.owner };
            else controller.abort();
        } })).rejects.toThrow();
        expect(progress).toEqual([{ phase: 'catalog', processed: 0, total: 0 }]);
        expect(projectGoalRequest).not.toHaveBeenCalled();
    });

    it.each(['account', 'cancel'] as const)('never reports late page progress after %s changes during decryption', async replacement => {
        const started = deferred<void>(), metadata = deferred<any>();
        const controller = new AbortController();
        mock.encryption.prepareSessionEncryption.mockResolvedValue({ sessionEncryption: { decryptMetadata: async () => {
            started.resolve(); return metadata.promise;
        } }, commit: vi.fn() });
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog());
        const progress: ProjectConversationHistoryProgress[] = [];
        const request = loadProjectConversationCandidates(machineId, projectPath, { signal: controller.signal, onProgress: value => progress.push(value) });
        const rejected = expect(request).rejects.toThrow();
        await started.promise;
        if (replacement === 'account') mock.owner = { ...mock.owner };
        else controller.abort();
        metadata.resolve(mock.metadata.get('one'));
        await rejected;
        await Promise.resolve();
        expect(progress).toEqual([{ phase: 'catalog', processed: 0, total: 0 }]);
    });
});

describe('bounded catalog token reuse', () => {
    it('reuses a complete valid cached snapshot without repeated page reads or decryption', async () => {
        const pages = await twoPages(); vi.mocked(projectGoalRequest).mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
        const first = await loadProjectConversationCandidates(machineId, projectPath);
        const reads = vi.mocked(projectGoalRequest).mock.calls.length, decryptions = mock.encryption.prepareSessionEncryption.mock.calls.length;
        const second = await loadProjectConversationCandidates(machineId, projectPath);
        expect(second).toEqual(first); expect(projectGoalRequest).toHaveBeenCalledTimes(reads);
        expect(mock.encryption.prepareSessionEncryption).toHaveBeenCalledTimes(decryptions);
    });

    it('refresh requests a fresh snapshot token without submitting the old snapshot or cursor', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(await catalog()).mockResolvedValueOnce(await catalog(undefined, { snapshotId: snapshotB }));
        const old = await loadProjectConversationCandidates(machineId, projectPath);
        const fresh = await loadProjectConversationCandidates(machineId, projectPath, { refresh: true });
        expect(old.catalogSnapshotId).toBe(snapshotA); expect(fresh.catalogSnapshotId).toBe(snapshotB);
        expect(projectGoalRequest).toHaveBeenNthCalledWith(2, machineId, 'goalProjectConversationCatalog', { projectPath });
    });

    it('rebuilds only on the next call when the server expiry enters its five-second margin', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-22T08:00:00Z'));
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(await catalog(undefined, { expiresAt: Date.now() + 20_000 }))
            .mockResolvedValueOnce(await catalog(undefined, { snapshotId: snapshotB, expiresAt: Date.now() + 60_000 }));
        await loadProjectConversationCandidates(machineId, projectPath);
        vi.setSystemTime(Date.now() + 14_000);
        expect((await loadProjectConversationCandidates(machineId, projectPath)).catalogSnapshotId).toBe(snapshotA);
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + 1_001);
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
        expect((await loadProjectConversationCandidates(machineId, projectPath)).catalogSnapshotId).toBe(snapshotB);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    });

    it.each(['account', 'encryption', 'machine', 'project'] as const)('does not reuse a catalog across a changed %s identity', async dimension => {
        vi.mocked(projectGoalRequest).mockImplementation(async (_machine, _operation, input: any) => catalog(undefined, { projectPath: input.projectPath }));
        await loadProjectConversationCandidates(machineId, projectPath);
        if (dimension === 'account') mock.owner = { ...mock.owner };
        if (dimension === 'encryption') mock.encryption = makeEncryption();
        await loadProjectConversationCandidates(dimension === 'machine' ? 'another-machine' : machineId, dimension === 'project' ? '/projects/other' : projectPath);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    });

    it('retains at most two project keys so revisiting an evicted scope obtains a new token', async () => {
        vi.mocked(projectGoalRequest).mockImplementation(async (_machine, _operation, input: any) => catalog(undefined, { projectPath: input.projectPath }));
        await loadProjectConversationCandidates(machineId, '/projects/a');
        await loadProjectConversationCandidates(machineId, '/projects/b');
        await loadProjectConversationCandidates(machineId, '/projects/c');
        expect(projectGoalRequest).toHaveBeenCalledTimes(3);
        await loadProjectConversationCandidates(machineId, '/projects/a');
        expect(projectGoalRequest).toHaveBeenCalledTimes(4);
    });

    it('does not cache a rejected catalog', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(await catalog(undefined, { total: 2 })).mockResolvedValueOnce(await catalog());
        await expect(loadProjectConversationCandidates(machineId, projectPath)).rejects.toThrow();
        expect((await loadProjectConversationCandidates(machineId, projectPath)).catalogSnapshotId).toBe(snapshotA);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    });
});

describe('cancellable catalog reads', () => {
    it('rejects an already cancelled read without issuing an RPC', async () => {
        const controller = new AbortController();
        const reason = new Error('History read timed out');
        controller.abort(reason);
        await expect(loadProjectConversationCandidates(machineId, projectPath, { signal: controller.signal })).rejects.toBe(reason);
        expect(projectGoalRequest).not.toHaveBeenCalled();
    });

    it('cancels a pending RPC immediately and gives a retry an independent request identity', async () => {
        const pages = await twoPages(), stale = deferred<any>();
        vi.mocked(projectGoalRequest).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(await catalog());
        const controller = new AbortController(), reason = new Error('History read timed out');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const request = loadProjectConversationCandidates(machineId, projectPath, { signal: controller.signal });
        const rejected = expect(request).rejects.toBe(reason);
        controller.abort(reason);
        await rejected;
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        const retry = await loadProjectConversationCandidates(machineId, projectPath, { signal: new AbortController().signal });
        expect(retry.candidates).toHaveLength(1);
        const calls = vi.mocked(projectGoalRequest).mock.calls;
        expect(calls[0][3]).toEqual(expect.any(String));
        expect(calls[1][3]).toEqual(expect.any(String));
        expect(calls[0][3]).not.toBe(calls[1][3]);
        const decryptions = mock.encryption.prepareSessionEncryption.mock.calls.length;
        stale.resolve(pages[0]);
        await Promise.resolve(); await Promise.resolve();
        expect(mock.encryption.prepareSessionEncryption).toHaveBeenCalledTimes(decryptions);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
        expect(await loadProjectConversationCandidates(machineId, projectPath)).toEqual(retry);
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
    }, 1_000);

    it.each(['key', 'preparation', 'metadata'] as const)('stops a cancelled read during %s decryption without processing the next record or page', async phase => {
        const rows = [encryptedRow('one'), encryptedRow('other')], page = await catalog(rows, {
            total: 3, hasNext: true, nextCursor: 'must-not-read',
        });
        const pending = deferred<any>(), started = deferred<void>();
        const decryptMetadata = vi.fn(async () => {
            if (phase === 'metadata') { started.resolve(); return pending.promise; }
            return mock.metadata.get('one');
        });
        mock.encryption.decryptEncryptionKey.mockImplementation(async () => {
            if (phase === 'key') { started.resolve(); return pending.promise; }
            return new Uint8Array(32);
        });
        mock.encryption.prepareSessionEncryption.mockImplementation(async () => {
            if (phase === 'preparation') { started.resolve(); return pending.promise; }
            return { sessionEncryption: { decryptMetadata }, commit: vi.fn() };
        });
        vi.mocked(projectGoalRequest).mockResolvedValue(page);
        const controller = new AbortController(), reason = new Error('History read timed out');
        const request = loadProjectConversationCandidates(machineId, projectPath, { signal: controller.signal });
        const rejected = expect(request).rejects.toBe(reason);
        await started.promise;
        controller.abort(reason);
        await rejected;
        pending.resolve(phase === 'key' ? new Uint8Array(32) : phase === 'preparation'
            ? { sessionEncryption: { decryptMetadata }, commit: vi.fn() } : mock.metadata.get('one'));
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
        expect(mock.encryption.decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(mock.encryption.prepareSessionEncryption).toHaveBeenCalledTimes(phase === 'key' ? 0 : 1);
        expect(decryptMetadata).toHaveBeenCalledTimes(phase === 'metadata' ? 1 : 0);
    }, 1_000);

    it('reuses a completed snapshot for cancellable pagination and removes its abort listener on success', async () => {
        vi.mocked(projectGoalRequest).mockResolvedValue(await catalog());
        const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
        const first = await loadProjectConversationCandidates(machineId, projectPath, { signal: controller.signal });
        const nextController = new AbortController();
        const second = await loadProjectConversationCandidates(machineId, projectPath, { signal: nextController.signal });
        expect(second).toEqual(first);
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
