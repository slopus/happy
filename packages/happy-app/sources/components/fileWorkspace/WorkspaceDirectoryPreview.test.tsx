import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no declarations
import TestRenderer from 'react-test-renderer';
import type { DirectoryEntry } from '@/sync/ops';
import { WorkspaceDirectoryPreview } from './WorkspaceDirectoryPreview';

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', Platform: { OS: 'web' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'active-text', textSecondary: 'active-secondary', surfacePressed: 'active-hover', surfaceSelected: 'active-selected', textLink: 'active-focus' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme) } };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; vi.clearAllMocks(); });

describe('WorkspaceDirectoryPreview', () => {
    it('opens directories and files using their full Unicode paths with spaces', () => {
        const path = '/Users/jacky/项目资料/19-Xilo 视频拆解/参考拆解';
        const onOpen = vi.fn();
        act(() => { renderer = TestRenderer.create(<WorkspaceDirectoryPreview path={path} entries={[
            { name: '精选 关键帧', type: 'directory' },
            { name: '素材索引 中文.md', type: 'file' },
        ]} onOpen={onOpen} />); });

        const row = (fullPath: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === fullPath);
        act(() => row(`${path}/精选 关键帧`).props.onPress());
        act(() => row(`${path}/素材索引 中文.md`).props.onPress());
        expect(onOpen.mock.calls).toEqual([
            [`${path}/精选 关键帧`],
            [`${path}/素材索引 中文.md`],
        ]);
    });

    it('lists directories first and sorts names while excluding unsafe and unsupported entries', () => {
        const entries: DirectoryEntry[] = [
            { name: 'z.md', type: 'file' },
            { name: 'z-folder', type: 'directory' },
            { name: 'a.md', type: 'file' },
            { name: 'a-folder', type: 'directory' },
            { name: '.', type: 'directory' },
            { name: '..', type: 'directory' },
            { name: '../escape.md', type: 'file' },
            { name: '/absolute.md', type: 'file' },
            { name: 'nested/file.md', type: 'file' },
            { name: 'nested\\file.md', type: 'file' },
            { name: 'unsupported', type: 'other' },
        ];
        act(() => { renderer = TestRenderer.create(<WorkspaceDirectoryPreview path="/workspace/参考拆解" entries={entries} onOpen={vi.fn()} />); });

        expect(renderer.root.findAllByType('Pressable').map((node: any) => node.props.accessibilityLabel)).toEqual([
            '/workspace/参考拆解/a-folder',
            '/workspace/参考拆解/z-folder',
            '/workspace/参考拆解/a.md',
            '/workspace/参考拆解/z.md',
        ]);
    });

    it('shows the empty-directory message when there are no browsable entries', () => {
        act(() => { renderer = TestRenderer.create(<WorkspaceDirectoryPreview path="/workspace/空目录" entries={[]} onOpen={vi.fn()} />); });

        expect(JSON.stringify(renderer.toJSON())).toContain('fileWorkspace.emptyDirectory');
        expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    });
});
