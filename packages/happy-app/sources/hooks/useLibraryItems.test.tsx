import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ data: '[]', owner: { key: 'a', generation: '1' }, confirm: vi.fn() }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => true, getRuntimeAccountSelection: () => mock.owner }));
vi.mock('@/sync/persistence', () => ({ loadProjectLibraryPreferences: () => mock.data, saveProjectLibraryPreferences: (data: string) => { mock.data = data; } }));
vi.mock('@/modal', () => ({ Modal: { confirm: mock.confirm, alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { useLibraryItems } from './useLibraryItems';
import { readLibraryItems, updateLibraryItem } from '@/sync/projectLibrary';
let renderer: any, library: ReturnType<typeof useLibraryItems>;
function Host() { library = useLibraryItems('machine'); return null; }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mock.data = '[]'; mock.owner = { key: 'a', generation: '1' }; mock.confirm.mockResolvedValue(true); });
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
it('does not restore a stale favorite when deleting from an already-open saved reader', async () => {
    updateLibraryItem('machine', 'file', '/scope/result.md', { favorite: true, scopePath: '/scope', rootPath: '/scope', title: 'result.md' });
    act(() => { renderer = TestRenderer.create(<Host />); });
    const originalTarget = library.items[0];
    act(() => library.favorite(originalTarget));
    expect(readLibraryItems('machine')).toEqual([]);
    await act(async () => { await library.remove(originalTarget); });
    expect(readLibraryItems('machine')[0]).toMatchObject({ state: 'deleted', favorite: false, scopePath: '/scope' });
});
it('rejects a late confirmed deletion after an account generation change', async () => {
    let resolve!: (result: boolean) => void;
    mock.confirm.mockReturnValue(new Promise(done => { resolve = done; }));
    act(() => { renderer = TestRenderer.create(<Host />); });
    let pending!: Promise<void>;
    act(() => { pending = library.remove({ kind: 'feature', projectPath: '/scope/feature', title: 'Feature' }); });
    mock.owner = { key: 'a', generation: 'next' };
    await act(async () => { resolve(true); await pending; });
    expect(readLibraryItems('machine')).toEqual([]);
});
