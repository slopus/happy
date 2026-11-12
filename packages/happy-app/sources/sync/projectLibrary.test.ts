import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalProject } from '@slopus/happy-wire';

const mock = vi.hoisted(() => ({ stores: {} as Record<string, string>, current: true, fail: false, account: { key: 'a', scope: 'a', serverUrl: 'https://a.test', generation: '1' } }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mock.current, getRuntimeAccountSelection: () => mock.account }));
vi.mock('./persistence', () => ({
    loadProjectLibraryPreferences: () => mock.stores[mock.account.scope],
    saveProjectLibraryPreferences: (value: string) => { if (mock.fail) throw new Error('Storage full'); mock.stores[mock.account.scope] = value; },
}));
import { libraryItemAvailable, readLibraryItems, updateLibraryItem, filterProjectLibrary, getProjectLibraryRevision, projectLibraryOwner, readProjectLibrary, subscribeProjectLibrary, updateProjectLibrary } from './projectLibrary';
const projects = [
    { projectPath: '/a', title: 'Alpha', summary: 'Research', features: [] },
    { projectPath: '/b', title: 'Beta', features: [] },
] as GoalProject[];
beforeEach(() => { mock.stores = {}; mock.fail = false; mock.current = true; mock.account = { key: 'a', scope: 'a', serverUrl: 'https://a.test', generation: '1' }; });

describe('durable project library preferences', () => {
    it('survives reloads and cache age without sharing a machine or account', () => {
        updateProjectLibrary('machine', '/a', { favorite: true });
        mock.account.generation = 'reload';
        expect(readProjectLibrary('machine')['/a'].favorite).toBe(true);
        expect(readProjectLibrary('other')).toEqual({});
        mock.account = { ...mock.account, key: 'b', scope: 'b' };
        expect(readProjectLibrary('machine')).toEqual({});
        updateProjectLibrary('machine', '/a', { state: 'deleted' });
        mock.account = { ...mock.account, key: 'a', scope: 'a' };
        expect(readProjectLibrary('machine')['/a']).toMatchObject({ favorite: true, state: 'active' });
    });
    it('keeps archived/deleted favorites out of active views and restores their star', () => {
        updateProjectLibrary('machine', '/a', { favorite: true, state: 'archived' });
        const select = (filter: Parameters<typeof filterProjectLibrary>[2], query = '') => filterProjectLibrary(projects, readProjectLibrary('machine'), filter, query).map(project => project.projectPath);
        expect(select('all')).toEqual(['/b']);
        expect(select('favorites')).toEqual([]);
        expect(select('archived')).toEqual(['/a']);
        updateProjectLibrary('machine', '/a', { state: 'deleted' });
        expect(select('archived')).toEqual([]);
        expect(select('deleted')).toEqual(['/a']);
        updateProjectLibrary('machine', '/a', { state: 'active' });
        expect(select('favorites', ' RESEARCH ')).toEqual(['/a']);
        expect(select('favorites', 'beta')).toEqual([]);
        updateProjectLibrary('machine', '/a', { favorite: false });
        expect(readProjectLibrary('machine')).toEqual({});
    });
    it('fences delayed confirmations after account changes and frozen runtimes', () => {
        const owner = projectLibraryOwner();
        mock.account.generation = 'next';
        expect(() => updateProjectLibrary('machine', '/a', { state: 'deleted' }, owner)).toThrow('Account changed');
        mock.current = false;
        expect(() => updateProjectLibrary('machine', '/a', { favorite: true })).toThrow('Account changed');
        expect(mock.stores).toEqual({});
    });
    it('notifies mounted consumers only after a successful durable write', () => {
        const listener = vi.fn(), before = getProjectLibraryRevision();
        const unsubscribe = subscribeProjectLibrary(listener);
        mock.fail = true;
        expect(() => updateProjectLibrary('machine', '/a', { state: 'deleted' })).toThrow('Storage full');
        expect(getProjectLibraryRevision()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        mock.fail = false;
        updateProjectLibrary('machine', '/a', { favorite: true });
        expect(listener).toHaveBeenCalledOnce();
        expect(readProjectLibrary('machine')['/a'].favorite).toBe(true);
        unsubscribe();
    });
    it('recovers from malformed local preferences', () => {
        mock.stores.a = '{broken';
        expect(readProjectLibrary('machine')).toEqual({});
        updateProjectLibrary('machine', '/a', { state: 'archived' });
        expect(readProjectLibrary('machine')['/a'].state).toBe('archived');
    });
});

describe('subproject and document library', () => {
    it('reads existing v1 entries and keeps a direct subproject distinct from its project', () => {
        mock.stores.a = JSON.stringify([{ machineId: 'm', projectPath: '/a', favorite: true, state: 'active' }]);
        updateLibraryItem('m', 'feature', '/a', { state: 'deleted', title: 'Direct tasks' });
        expect(readProjectLibrary('m')['/a']).toMatchObject({ kind: 'project', favorite: true, state: 'active' });
        expect(readLibraryItems('m').find(item => item.kind === 'feature')).toMatchObject({ state: 'deleted' });
    });
    it('preserves file read context and favorite across delete, reload and restore', () => {
        updateLibraryItem('m', 'file', '/a/features/f/tasks/t/result.md', { favorite: true, title: 'result.md', scopePath: '/a/features/f', rootPath: '/a/features/f/tasks/t', taskId: 't' });
        updateLibraryItem('m', 'file', '/a/features/f/tasks/t/result.md', { state: 'deleted' });
        mock.account.generation = 'reload';
        const item = readLibraryItems('m')[0];
        expect(item).toMatchObject({ favorite: true, state: 'deleted', taskId: 't', rootPath: '/a/features/f/tasks/t' });
        expect(libraryItemAvailable(item, readLibraryItems('m'))).toBe(false);
        updateLibraryItem('m', 'file', item.projectPath, { state: 'active' });
        expect(libraryItemAvailable(readLibraryItems('m')[0], readLibraryItems('m'))).toBe(true);
        expect(readProjectLibrary('m')).toEqual({});
    });
    it('hides descendants of removed parents with path-boundary isolation', () => {
        updateLibraryItem('m', 'file', '/a/f/result.md', { favorite: true });
        updateLibraryItem('m', 'file', '/ab/result.md', { favorite: true });
        updateProjectLibrary('m', '/a', { state: 'archived' });
        const items = readLibraryItems('m');
        expect(items.filter(item => item.kind === 'file' && libraryItemAvailable(item, items)).map(item => item.projectPath)).toEqual(['/ab/result.md']);
        updateProjectLibrary('m', '/a', { state: 'active' });
        updateLibraryItem('m', 'feature', '/a/f', { state: 'deleted' });
        expect(libraryItemAvailable(readLibraryItems('m').find(item => item.projectPath === '/a/f/result.md')!, readLibraryItems('m'))).toBe(false);
    });
});
