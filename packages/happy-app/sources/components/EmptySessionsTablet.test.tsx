import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only uses the minimal create/unmount API.
import TestRenderer from 'react-test-renderer';

import { EmptySessionsTablet } from './EmptySessionsTablet';

const { navigate, state, translations } = vi.hoisted(() => ({
    navigate: vi.fn(),
    state: { machines: [] as Array<{ online: boolean }> },
    translations: {
        'sidebar.emptySessionsTitle': '暂无活跃会话',
        'sidebar.emptySessionsOnlineDescription': '在任意一台已连接的设备上开始新会话。',
        'sidebar.emptySessionsOfflineDescription': '在电脑上打开新的终端以开始会话。',
        'newSession.title': '开始新会话',
    } as Record<string, string>,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({
    useRouter: () => ({ navigate }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: object) => object) => factory({
            colors: {
                textSecondary: '#666666',
                button: {
                    primary: {
                        background: '#111111',
                        tint: '#ffffff',
                    },
                },
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666666',
                button: { primary: { tint: '#ffffff' } },
            },
        },
    }),
}));
vi.mock('@/sync/storage', () => ({
    useAllMachines: () => state.machines,
}));
vi.mock('@/utils/machineUtils', () => ({
    isMachineOnline: (machine: { online: boolean }) => machine.online,
}));
vi.mock('@/text', () => ({
    t: (key: string) => translations[key] ?? key,
}));

function renderedText(renderer: any): string[] {
    return renderer.root
        .findAllByType('Text')
        .map((node: { children: unknown[] }) => node.children.join(''));
}

describe('EmptySessionsTablet i18n empty state', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        navigate.mockReset();
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('renders translated title, online guidance, and existing new-session action', () => {
        state.machines = [{ online: true }];
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<EmptySessionsTablet />);
        });

        expect(renderedText(renderer)).toEqual([
            '暂无活跃会话',
            '在任意一台已连接的设备上开始新会话。',
            '开始新会话',
        ]);

        act(() => renderer.root.findByType('Pressable').props.onPress());
        expect(navigate).toHaveBeenCalledWith('/new');

        act(() => renderer.unmount());
    });

    it('renders translated offline guidance without the new-session action', () => {
        state.machines = [{ online: false }];
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<EmptySessionsTablet />);
        });

        expect(renderedText(renderer)).toEqual([
            '暂无活跃会话',
            '在电脑上打开新的终端以开始会话。',
        ]);
        expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);

        act(() => renderer.unmount());
    });
});
