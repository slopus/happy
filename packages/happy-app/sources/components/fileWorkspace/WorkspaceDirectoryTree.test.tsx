import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no declarations
import TestRenderer from 'react-test-renderer';
import { WorkspaceDirectoryTree } from './WorkspaceDirectoryTree';

const mocks = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Platform: { OS: 'web' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/sync/ops', () => ({ sessionWorkspaceListDirectory: mocks.list }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'active-text', textSecondary: 'active-secondary', surfacePressed: 'active-hover', surfaceSelected: 'active-selected', textLink: 'active-focus' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme) } };
});
vi.mock('./context', () => ({ useFileWorkspace: () => ({ enabled: true, root: '/project', snapshot: { active: '/project/unrelated/file.md' }, openReference: mocks.open }) }));
vi.mock('./WorkspaceButton', () => ({ WorkspaceButton: 'Button' }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
const flatten = (style: any): any => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; vi.clearAllMocks(); });

describe('WorkspaceDirectoryTree task scope', () => {
    it('keeps the existing workspace-scoped loader by default', async () => {
        mocks.list.mockResolvedValue({ success: true, entries: [] });
        await act(async () => { renderer = TestRenderer.create(<WorkspaceDirectoryTree sessionId="s" />); });
        expect(mocks.list).toHaveBeenCalledWith('s', '/project');
    });

    it('loads only the requested task root and opens its files using the supplied handler', async () => {
        const readOnlyList = vi.fn(async (_session, path) => ({ success: true, entries: path === '/goal/tasks/t1' ? [{ name: 'result.md', type: 'file' as const }, { name: 'assets', type: 'directory' as const }] : [{ name: 'plot.png', type: 'file' as const }] }));
        const onOpenFile = vi.fn();
        await act(async () => { renderer = TestRenderer.create(<WorkspaceDirectoryTree sessionId="s" rootPath="/goal/tasks/t1" onOpenFile={onOpenFile} listDirectory={readOnlyList} />); });
        expect(readOnlyList.mock.calls).toEqual([['s', '/goal/tasks/t1']]);
        expect(mocks.list).not.toHaveBeenCalled();
        const row = (path: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === path);
        act(() => row('/goal/tasks/t1/result.md').props.onPress());
        expect(onOpenFile).toHaveBeenCalledWith('/goal/tasks/t1/result.md');
        expect(mocks.open).not.toHaveBeenCalled();
        await act(async () => row('/goal/tasks/t1/assets').props.onPress());
        expect(readOnlyList).toHaveBeenLastCalledWith('s', '/goal/tasks/t1/assets');
        expect(row('/goal/tasks/t1/assets/plot.png')).toBeTruthy();
    });
    it('filters saved deletions without changing folder loading or nesting action buttons', async () => {
        const list = vi.fn(async () => ({ success: true, entries: [{ name: 'keep.md', type: 'file' as const }, { name: 'hidden.md', type: 'file' as const }] }));
        const action = vi.fn();
        await act(async () => { renderer = TestRenderer.create(<WorkspaceDirectoryTree sessionId="s" rootPath="/goal" listDirectory={list} includeFile={path => !path.endsWith('hidden.md')} renderFileActions={path => <button onClick={() => action(path)}>Favorite</button>} />); });
        const rows = renderer.root.findAllByType('Pressable');
        expect(rows.map((row: any) => row.props.accessibilityLabel)).toEqual(['/goal/keep.md']);
        const button = renderer.root.findByType('button');
        expect(button.parent.type).not.toBe('Pressable');
        act(() => button.props.onClick());
        expect(action).toHaveBeenCalledWith('/goal/keep.md');
        expect(mocks.open).not.toHaveBeenCalled();
    });

    it('keeps a compact left-aligned folder row and a focus boundary without changing its geometry', async () => {
        const list = vi.fn(async () => ({ success: true, entries: [{ name: 'assets', type: 'directory' as const }] }));
        await act(async () => { renderer = TestRenderer.create(<WorkspaceDirectoryTree sessionId="s" rootPath="/goal" listDirectory={list} />); });
        const row = () => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '/goal/assets');
        const normal = flatten(row().props.style({ pressed: false }));
        expect(normal).toMatchObject({ flexDirection: 'row', alignItems: 'center', padding: 8, paddingLeft: 12, gap: 7 });
        expect(typeof row().props.onFocus).toBe('function');
        act(() => row().props.onFocus());
        const focused = flatten(row().props.style({ pressed: false }));
        expect(focused).toMatchObject({ outlineColor: 'active-focus', outlineWidth: 1, outlineStyle: 'solid' });
        for (const key of ['padding', 'paddingLeft', 'gap', 'flex', 'minWidth', 'borderWidth']) expect(focused[key]).toBe(normal[key]);
        act(() => row().props.onBlur());
        expect(flatten(row().props.style({ pressed: false })).outlineWidth).toBe(0);
    });

});
