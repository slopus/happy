import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no declarations
import TestRenderer from 'react-test-renderer';
import { WorkspaceDirectoryTree } from './WorkspaceDirectoryTree';

const mocks = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/sync/ops', () => ({ sessionWorkspaceListDirectory: mocks.list }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('./context', () => ({ useFileWorkspace: () => ({ enabled: true, root: '/project', snapshot: { active: '/project/unrelated/file.md' }, openReference: mocks.open }) }));
vi.mock('./WorkspaceButton', () => ({ WorkspaceButton: 'Button' }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
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
});
