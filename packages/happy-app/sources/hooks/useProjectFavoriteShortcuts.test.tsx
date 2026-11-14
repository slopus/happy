import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GoalProject } from '@slopus/happy-wire';

const mock = vi.hoisted(() => ({
    stores: {} as Record<string, string>, account: { key: 'a', generation: '1' }, online: true,
    catalog: null as GoalProject[] | null, resource: vi.fn(),
}));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => true, getRuntimeAccountSelection: () => mock.account }));
vi.mock('@/sync/persistence', () => ({
    loadProjectLibraryPreferences: () => mock.stores[mock.account.key],
    saveProjectLibraryPreferences: (value: string) => { mock.stores[mock.account.key] = value; },
}));
vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [{ id: 'm', active: true }, { id: 'other', active: false }],
    useMachine: (id: string) => id === 'm' || id === 'other' ? { id, daemonState: { goalProjectRevision: 'rev' } } : null,
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('./useNewSessionDraft', () => ({ useNewSessionDraft: (select: any) => select({ selectedMachineId: 'm' }) }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => mock.online }));
vi.mock('@/sync/projectGoals', () => ({ getProjectPreviewMachineId: () => undefined, loadGoalProjects: vi.fn() }));
vi.mock('@/sync/projectWorkspaceCache', () => ({ projectCacheKey: (_: string, machine: string) => machine, projectCatalogSchema: {} }));
vi.mock('@/components/goalBoard/useProjectData', () => ({ useCachedProjectResource: (...args: unknown[]) => { mock.resource(...args); return { value: mock.catalog }; } }));
import { updateLibraryItem, updateProjectLibrary } from '@/sync/projectLibrary';
import { selectedProjectFavorite } from '@/utils/projectFavoriteShortcuts';
import { useProjectFavoriteShortcuts } from './useProjectFavoriteShortcuts';

const project: GoalProject = { projectPath: '/p', title: 'Project', features: [{ featurePath: '/p/features/video', title: 'Video review' }] };
let renderer: any, result: ReturnType<typeof useProjectFavoriteShortcuts>;
function Host({ machine }: { machine?: string }) { result = useProjectFavoriteShortcuts(machine); return null; }
function mount(machine?: string) { act(() => { renderer = TestRenderer.create(<Host machine={machine} />); }); }
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mock.stores = {}; mock.account = { key: 'a', generation: '1' }; mock.online = true;
    mock.catalog = [project, { projectPath: '/direct', title: 'Direct tasks', features: [], direct: { featurePath: '/direct', title: 'Direct tasks' } }];
    mock.resource.mockClear();
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; });

it('reuses favorites and live catalog titles without including documents or other machines', () => {
    updateProjectLibrary('m', '/p', { favorite: true });
    updateLibraryItem('m', 'feature', '/p/features/video', { favorite: true, title: 'Old title', parentProjectPath: '/p' });
    updateLibraryItem('m', 'file', '/p/file.md', { favorite: true });
    updateProjectLibrary('other', '/other', { favorite: true });
    mount();
    expect(result.shortcuts.map(shortcut => shortcut.title)).toEqual(['Project', 'Video review']);
    expect(result.shortcuts[1].location).toEqual({ machine: 'm', project: '/p', feature: '/p/features/video' });
    expect(selectedProjectFavorite(result.shortcuts, { machine: 'm', project: '/p', feature: '/p/features/video', task: 'task' })).toBe(result.shortcuts[1].key);
    expect(selectedProjectFavorite(result.shortcuts, { machine: 'other', project: '/p' })).toBeUndefined();
});

it('updates immediately on favorite, unfavorite, archive, restore and delete', () => {
    mount(); expect(result.shortcuts).toEqual([]);
    expect(mock.resource.mock.lastCall?.[3]).toBe(false);
    act(() => { updateProjectLibrary('m', '/p', { favorite: true }); updateLibraryItem('m', 'feature', '/p/features/video', { favorite: true, parentProjectPath: '/p' }); });
    expect(result.shortcuts).toHaveLength(2);
    expect(mock.resource.mock.lastCall?.[3]).toBe(true);
    act(() => updateProjectLibrary('m', '/p', { state: 'archived' }));
    expect(result.shortcuts).toEqual([]);
    act(() => updateProjectLibrary('m', '/p', { state: 'active', favorite: false }));
    expect(result.shortcuts.map(shortcut => shortcut.kind)).toEqual(['feature']);
    act(() => updateLibraryItem('m', 'feature', '/p/features/video', { state: 'deleted' }));
    expect(result.shortcuts).toEqual([]);
});

it('preserves offline titles and direct-task destinations across remounts', () => {
    updateProjectLibrary('m', '/direct', { favorite: true });
    updateLibraryItem('m', 'feature', '/p/features/video', { favorite: true, title: 'Video review', parentProjectPath: '/p' });
    mount();
    expect(result.shortcuts[0].location).toEqual({ machine: 'm', project: '/direct', feature: '/direct' });
    act(() => renderer.unmount()); renderer = null;
    mock.online = false; mock.catalog = null;
    mount();
    expect(result.shortcuts.map(shortcut => shortcut.title)).toEqual(['direct', 'Video review']);
    expect(result.shortcuts[1].location).toEqual({ machine: 'm', project: '/p', feature: '/p/features/video' });
    expect(mock.resource.mock.lastCall?.[3]).toBe(false);
});

it('keeps explicit missing machine ownership and isolates account changes', () => {
    updateProjectLibrary('m', '/p', { favorite: true });
    mount('missing');
    expect(result.machineId).toBe('missing'); expect(result.shortcuts).toEqual([]);
    act(() => renderer.update(<Host machine="m" />));
    expect(result.shortcuts).toHaveLength(1);
    mock.account = { key: 'b', generation: '2' };
    act(() => renderer.update(<Host machine="m" />));
    expect(result.shortcuts).toEqual([]);
});
