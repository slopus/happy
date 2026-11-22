import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('./apiSessions', () => ({ fetchSessionSnapshotPage: vi.fn() }));
vi.mock('./projectGoals', () => ({ projectGoalRequest: vi.fn() }));
import { TokenStorage } from '@/auth/tokenStorage';
import { fetchSessionSnapshotPage } from './apiSessions';
import { projectGoalRequest } from './projectGoals';
import { readProjectConversationManifestHeaders } from './projectConversationManifest.web';

const header = (id: string, metadataVersion = 1) => ({ id, metadataVersion, metadata: btoa(`cipher-${id}`), dataEncryptionKey: null });
const manifest = (ids: string[]) => ({ projectPath: '/project', snapshotId: 'fixed-snapshot', catalogFingerprint: 'a'.repeat(64),
    total: ids.length, expiresAt: Date.now() + 60000, sessions: ids.map(id => ({ id, metadataVersion: 1 })) });
const page = (rows: ReturnType<typeof header>[], extra = {}) => ({ sessions: rows, nextCursor: null, hasNext: false, ...extra });
const rawPage = (m: ReturnType<typeof manifest>, ids: string[], extra = {}) => ({ ...m, total: ids.length,
    sessions: ids.map(id => header(id)), nextCursor: null, hasNext: false, ...extra });
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(TokenStorage.getCredentials).mockResolvedValue({ token: 'private-token', secret: 'private-secret' });
});

describe('HTTP acceleration of an immutable project catalog', () => {
    it('reads every pinned identity with at most three concurrent ID-range requests, without relaying metadata', async () => {
        const ids = Array.from({ length: 601 }, (_, i) => `s${String(i).padStart(4, '0')}`).reverse();
        const m = manifest(ids);
        let active = 0, maximum = 0;
        vi.mocked(fetchSessionSnapshotPage).mockImplementation(async (_credentials, options) => {
            active++; maximum = Math.max(maximum, active);
            await Promise.resolve();
            const start = options.cursor ? ids.indexOf(options.cursor.slice('cursor_v1_'.length)) + 1 : 0;
            active--;
            return page(ids.slice(start, start + 200).map(id => header(id))) as any;
        });
        const result = await readProjectConversationManifestHeaders('machine', '/project', m, { current() {} });
        expect(result).toEqual(ids.map(id => header(id)));
        expect(maximum).toBe(3);
        expect(fetchSessionSnapshotPage).toHaveBeenCalledTimes(4);
        expect(projectGoalRequest).not.toHaveBeenCalled();
    });

    it('fills changed, deleted and displaced rows from the same snapshot, excluding new sessions', async () => {
        const m = manifest(['c', 'b', 'a']);
        vi.mocked(fetchSessionSnapshotPage).mockResolvedValue(page([header('new'), header('c', 2), header('a')]) as any);
        vi.mocked(projectGoalRequest).mockResolvedValue(rawPage(m, ['c', 'b']));
        const result = await readProjectConversationManifestHeaders('machine', '/project', m, { current() {}, version: 'read-1' });
        expect(result).toEqual(['c', 'b', 'a'].map(id => header(id)));
        expect(projectGoalRequest).toHaveBeenCalledExactlyOnceWith('machine', 'goalProjectConversationCatalog', {
            projectPath: '/project', snapshotId: m.snapshotId, sessionIds: ['c', 'b'],
        }, 'read-1');
    });

    it('exhausts byte-limited missing-row pages rather than treating one page as complete', async () => {
        const m = manifest(['c', 'b', 'a']);
        vi.mocked(fetchSessionSnapshotPage).mockResolvedValue(page([]) as any);
        vi.mocked(projectGoalRequest).mockResolvedValueOnce(rawPage(m, ['c'], { total: 3, hasNext: true, nextCursor: '1' }))
            .mockResolvedValueOnce(rawPage(m, ['b', 'a'], { total: 3 }));
        expect((await readProjectConversationManifestHeaders('machine', '/project', m, { current() {} })).map(row => row.id)).toEqual(['c', 'b', 'a']);
        expect(projectGoalRequest).toHaveBeenLastCalledWith('machine', 'goalProjectConversationCatalog', {
            projectPath: '/project', snapshotId: m.snapshotId, sessionIds: ['c', 'b', 'a'], cursor: '1',
        });
    });

    it.each([
        ['snapshot', { snapshotId: 'other' }], ['digest', { catalogFingerprint: 'b'.repeat(64) }],
        ['project', { projectPath: '/other' }], ['total', { total: 2 }], ['version', { sessions: [header('a', 2)] }],
        ['foreign identity', { sessions: [header('foreign')] }], ['incomplete', { sessions: [] }],
    ])('rejects a mismatching fallback %s', async (_name, extra) => {
        const m = manifest(['a']);
        vi.mocked(fetchSessionSnapshotPage).mockResolvedValue(page([]) as any);
        vi.mocked(projectGoalRequest).mockResolvedValue(rawPage(m, ['a'], extra));
        await expect(readProjectConversationManifestHeaders('machine', '/project', m, { current() {} })).rejects.toThrow();
    });

    it('stops scheduling requests when the account or cancellation fence changes', async () => {
        const ids = Array.from({ length: 801 }, (_, i) => `s${i.toString().padStart(4, '0')}`);
        let changed = false;
        vi.mocked(fetchSessionSnapshotPage).mockImplementation(async () => { changed = true; return page([]) as any; });
        await expect(readProjectConversationManifestHeaders('machine', '/project', manifest(ids), {
            current() { if (changed) throw new Error('Account changed or history cancelled'); },
        })).rejects.toThrow(/changed|cancelled/);
        expect(vi.mocked(fetchSessionSnapshotPage).mock.calls.length).toBeLessThanOrEqual(3);
        expect(projectGoalRequest).not.toHaveBeenCalled();
    });

    it('does not call authenticated HTTP or RPC for an empty complete directory', async () => {
        expect(await readProjectConversationManifestHeaders('machine', '/project', manifest([]), { current() {} })).toEqual([]);
        expect(TokenStorage.getCredentials).not.toHaveBeenCalled();
        expect(fetchSessionSnapshotPage).not.toHaveBeenCalled();
    });
});
