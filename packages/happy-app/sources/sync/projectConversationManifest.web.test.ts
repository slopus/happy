import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn().mockResolvedValue({ token: 'private', secret: 'private' }) } }));
vi.mock('./apiSessions', () => ({ fetchSessionSnapshotPage: vi.fn() }));
vi.mock('./projectGoals', () => ({ projectGoalRequest: vi.fn() }));
import { fetchSessionSnapshotPage } from './apiSessions';
import { projectGoalRequest } from './projectGoals';
import { readProjectConversationManifestHeaders } from './projectConversationManifest.web';
const header = (id: string, metadataVersion = 1) => ({ id, metadataVersion, metadata: btoa(`cipher-${id}`), dataEncryptionKey: null });
const candidate = (id: string) => ({ sessionId: id, metadataVersion: 1, directory: '/task', title: id });
const manifest = (ids: string[]) => ({ projectPath: '/project', snapshotId: 'fixed-snapshot', catalogFingerprint: 'a'.repeat(64), total: ids.length, expiresAt: Date.now() + 60000, sessions: ids.map(id => ({ id, metadataVersion: 1 })) });
const rawPage = (m: ReturnType<typeof manifest>, ids: string[], extra = {}) => ({ ...m, total: ids.length, sessions: ids.map(id => header(id)), nextCursor: null, hasNext: false, ...extra });
beforeEach(() => vi.resetAllMocks());
describe('compact classifications and opaque snapshot retrieval', () => {
    it('reuses explicit positive and negative classifications without HTTP or ciphertext transfer', async () => {
        const m = { ...manifest(['a', 'b']), sessions: [{ id: 'a', metadataVersion: 1, candidate: candidate('a') }, { id: 'b', metadataVersion: 1, candidate: null }] };
        expect(await readProjectConversationManifestHeaders('machine', '/project', m, { current() {} })).toEqual(m.sessions);
        expect(projectGoalRequest).not.toHaveBeenCalled(); expect(fetchSessionSnapshotPage).not.toHaveBeenCalled();
    });
    it('fetches only opaque rows and consumes known rows before network completion', async () => {
        const m = { ...manifest(['a', 'b', 'c']), sessions: [{ id: 'a', metadataVersion: 1, candidate: candidate('a') }, { id: 'b', metadataVersion: 1, candidate: null }, { id: 'c', metadataVersion: 1 }] };
        const batches: string[][] = [];
        vi.mocked(projectGoalRequest).mockImplementation(async () => { expect(batches).toEqual([['a', 'b']]); return rawPage(m, ['c']); });
        const result = await readProjectConversationManifestHeaders('machine', '/project', m, { current() {}, version: 'read-1', onRows: async rows => { batches.push(rows.map(row => row.id)); } });
        expect(result.map(row => row.id)).toEqual(['a', 'b', 'c']); expect(batches).toEqual([['a', 'b'], ['c']]);
        expect(projectGoalRequest).toHaveBeenCalledExactlyOnceWith('machine', 'goalProjectConversationCatalog', { projectPath: '/project', snapshotId: m.snapshotId, sessionIds: ['c'] }, 'read-1');
    });
    it('exhausts byte-limited opaque pages', async () => {
        const m = manifest(['c', 'b', 'a']);
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(rawPage(m, ['c'], { total: 3, hasNext: true, nextCursor: '1' })).mockResolvedValueOnce(rawPage(m, ['b', 'a'], { total: 3 }));
        expect((await readProjectConversationManifestHeaders('machine', '/project', m, { current() {} })).map(row => row.id)).toEqual(['c', 'b', 'a']);
        expect(projectGoalRequest).toHaveBeenLastCalledWith('machine', 'goalProjectConversationCatalog', { projectPath: '/project', snapshotId: m.snapshotId, sessionIds: ['c', 'b', 'a'], cursor: '1' });
    });
    it.each([['snapshot', { snapshotId: 'other' }], ['digest', { catalogFingerprint: 'b'.repeat(64) }], ['project', { projectPath: '/other' }], ['total', { total: 2 }], ['version', { sessions: [header('a', 2)] }], ['foreign identity', { sessions: [header('foreign')] }], ['incomplete', { sessions: [] }]])('rejects mismatching opaque %s', async (_name, extra) => {
        const m = manifest(['a']); vi.mocked(projectGoalRequest).mockResolvedValue(rawPage(m, ['a'], extra));
        await expect(readProjectConversationManifestHeaders('machine', '/project', m, { current() {} })).rejects.toThrow();
    });
    it('never converts invalid positive classification to exclusion', async () => {
        const m = { ...manifest(['a']), sessions: [{ id: 'a', metadataVersion: 1, candidate: candidate('foreign') }] };
        await expect(readProjectConversationManifestHeaders('machine', '/project', m, { current() {} })).rejects.toThrow(); expect(projectGoalRequest).not.toHaveBeenCalled();
    });
    it('cancels during known rows without scheduling opaque requests', async () => {
        const m = { ...manifest(['a', 'b']), sessions: [{ id: 'a', metadataVersion: 1, candidate: null }, { id: 'b', metadataVersion: 1 }] }; let cancelled = false;
        await expect(readProjectConversationManifestHeaders('machine', '/project', m, { current() { if (cancelled) throw new Error('cancelled'); }, onRows: async () => { cancelled = true; } })).rejects.toThrow(/cancelled/);
        expect(projectGoalRequest).not.toHaveBeenCalled();
    });
    it('reads empty directories without HTTP or RPC', async () => {
        expect(await readProjectConversationManifestHeaders('machine', '/project', manifest([]), { current() {} })).toEqual([]); expect(projectGoalRequest).not.toHaveBeenCalled(); expect(fetchSessionSnapshotPage).not.toHaveBeenCalled();
    });
});
