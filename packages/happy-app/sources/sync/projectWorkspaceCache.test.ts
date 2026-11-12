import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
const mock = vi.hoisted(() => ({ raw: undefined as string | undefined, deleted: new Set<string>(), current: true, account: { key: 'a', scope: 'a', serverUrl: 'https://a.test', generation: '0' } }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mock.current, getRuntimeAccountSelection: () => mock.account }));
vi.mock('./persistence', () => ({ loadProjectWorkspaceCache: () => mock.raw, saveProjectWorkspaceCache: (raw: string) => { mock.raw = raw; }, loadProjectSessionDeleted: (key: string) => mock.deleted.has(key), saveProjectSessionDeleted: (key: string) => { mock.deleted.add(key); } }));
import { projectCacheKey, projectHistorySchema, readProjectCache, writeProjectCache, removeProjectSessionFromCache, isProjectSessionDeleted, subscribeProjectSessionDeletions, getProjectSessionDeletionRevision } from './projectWorkspaceCache';
const schema = z.array(z.string());
beforeEach(() => { mock.raw = undefined; mock.deleted.clear(); mock.current = true; mock.account = { key: 'a', scope: 'a', serverUrl: 'https://a.test', generation: Math.random().toString() }; delete (globalThis as any).__HAPPY_CONFIG__; });
describe('real project metadata cache', () => {
    it('survives a reload generation but isolates server, account, machine, feature, task and preview', () => {
        const key = projectCacheKey('history', 'm', 'f', 't');
        writeProjectCache(key, ['saved']);
        mock.account.generation += 'reload';
        expect(readProjectCache(projectCacheKey('history', 'm', 'f', 't'), schema)?.value).toEqual(['saved']);
        for (const tuple of [['other', 'f', 't'], ['m', 'other', 't'], ['m', 'f', 'other']]) expect(readProjectCache(projectCacheKey('history', ...tuple as [string, string, string]), schema)).toBeNull();
        mock.account.key = 'b'; expect(readProjectCache(projectCacheKey('history', 'm', 'f', 't'), schema)).toBeNull();
        mock.account.key = 'a'; mock.account.serverUrl = 'https://b.test'; expect(readProjectCache(projectCacheKey('history', 'm', 'f', 't'), schema)).toBeNull();
        mock.account.serverUrl = 'https://a.test'; (globalThis as any).__HAPPY_CONFIG__ = { goalProjectReadOnly: true };
        expect(readProjectCache(projectCacheKey('history', 'm', 'f', 't'), schema)).toBeNull();
    });
    it('treats empty successful data as cached and rejects corrupt, expired and frozen data', () => {
        writeProjectCache('catalog', []); expect(readProjectCache('catalog', schema)?.value).toEqual([]);
        mock.current = false; expect(readProjectCache('catalog', schema)).toBeNull();
        const before = mock.raw; writeProjectCache('catalog', ['late']); expect(mock.raw).toBe(before);
        mock.current = true; mock.raw = '{invalid'; expect(readProjectCache('catalog', schema)).toBeNull();
        mock.raw = JSON.stringify([{ key: 'catalog', value: ['old'], savedAt: Date.now() - 8 * 86400000 }]); expect(readProjectCache('catalog', schema)).toBeNull();
        mock.raw = JSON.stringify([{ key: 'catalog', value: ['future'], savedAt: Date.now() + 86400000 }]); expect(readProjectCache('catalog', schema)).toBeNull();
    });
    it('bounds disk use and evicts old entries', () => {
        for (let i = 0; i < 60; i++) writeProjectCache(String(i), ['x'.repeat(50000)]);
        expect(mock.raw!.length).toBeLessThanOrEqual(1024 * 1024);
        expect(readProjectCache('0', schema)).toBeNull();
        expect(readProjectCache('59', schema)?.value).toHaveLength(1);
    });
    it('an authoritative deletion removes durable links and fences a late history response', () => {
        const session = { sessionId: 'deleted', directory: '/task', title: 'task', updatedAt: 1, executed: false };
        writeProjectCache('history', { sessions: [session] });
        removeProjectSessionFromCache('deleted');
        expect(isProjectSessionDeleted('deleted')).toBe(true);
        expect(readProjectCache('history', projectHistorySchema)?.value.sessions).toEqual([]);
        writeProjectCache('history', { sessions: [session] });
        expect(readProjectCache('history', projectHistorySchema)?.value.sessions).toEqual([]);
        mock.account.key = 'other'; expect(isProjectSessionDeleted('deleted')).toBe(false);
    });
});

it('notifies a mounted consumer even when the deleted ID was never hydrated in the session store', () => {
    const listener = vi.fn(); const previous = getProjectSessionDeletionRevision();
    const unsubscribe = subscribeProjectSessionDeletions(listener);
    writeProjectCache('history', { sessions: [{ sessionId: 'cache-only', directory: '/task', title: 'Task', updatedAt: 1, executed: false }] });
    removeProjectSessionFromCache('cache-only');
    expect(listener).toHaveBeenCalledOnce(); expect(getProjectSessionDeletionRevision()).toBe(previous + 1);
    expect(readProjectCache('history', projectHistorySchema)?.value.sessions).toEqual([]);
    unsubscribe();
});

it('retains authoritative deletion across runtime generations and history-cache eviction', () => {
    const session = { sessionId: 'durably-deleted', directory: '/task', title: 'Task', updatedAt: 1, executed: false };
    removeProjectSessionFromCache(session.sessionId);
    mock.raw = undefined;
    mock.account.generation += 'reload';
    expect(isProjectSessionDeleted(session.sessionId)).toBe(true);
    writeProjectCache('history', { sessions: [session] });
    expect(readProjectCache('history', projectHistorySchema)?.value.sessions).toEqual([]);
    mock.account.serverUrl = 'https://other.test'; expect(isProjectSessionDeleted(session.sessionId)).toBe(false);
});
it('a frozen account cannot persist a deletion into the next runtime', () => {
    mock.current = false;
    removeProjectSessionFromCache('do-not-persist');
    expect(mock.deleted.size).toBe(0);
});
