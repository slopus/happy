import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalProject } from '@slopus/happy-wire';

const mock = vi.hoisted(() => ({ stores: {} as Record<string, string>, current: true, fail: false, account: { key: 'a', scope: 'a', serverUrl: 'https://a.test', generation: '1' } }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mock.current, getRuntimeAccountSelection: () => mock.account }));
vi.mock('./persistence', () => ({
    loadProjectLibraryPreferences: () => mock.stores[mock.account.scope],
    saveProjectLibraryPreferences: (value: string) => { if (mock.fail) throw new Error('Storage full'); mock.stores[mock.account.scope] = value; },
}));
import { filterProjectLibrary, getProjectLibraryRevision, projectLibraryOwner, readProjectLibrary, subscribeProjectLibrary, updateProjectLibrary } from './projectLibrary';
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
