import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

let lastPathSelectorProps: any = null;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: (options: { web?: unknown; ios?: unknown; default?: unknown }) => options.web ?? options.ios ?? options.default,
    },
    TurboModuleRegistry: {
        getEnforcing: () => ({}),
    },
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ back: vi.fn() }),
    useNavigation: () => ({ getState: () => ({ index: 1, routes: [{ key: 'a' }, { key: 'b' }] }) }),
    useLocalSearchParams: () => ({ machineId: 'm1', selectedPath: '/tmp' }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' }, textSecondary: '#666', input: { background: '#fff', placeholder: '#aaa', text: '#000' }, divider: '#ddd' } } }),
    StyleSheet: { create: (fn: any) => fn({ colors: { textSecondary: '#666', input: { background: '#fff', placeholder: '#aaa', text: '#000' }, divider: '#ddd' } }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 900 },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: any) => {
        lastPathSelectorProps = props;
        return null;
    },
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [{ id: 'm1', metadata: { homeDir: '/home' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        if (key === 'usePathPickerSearch') return false;
        return null;
    },
    useSettingMutable: (key: string) => {
        if (key === 'favoriteDirectories') return [undefined, vi.fn()];
        return [null, vi.fn()];
    },
}));

describe('PathPickerScreen', () => {
    beforeEach(() => {
        lastPathSelectorProps = null;
    });

    it('defaults favoriteDirectories to an empty array when setting is undefined', async () => {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        act(() => {
            renderer.create(React.createElement(PathPickerScreen));
        });

        expect(lastPathSelectorProps).toBeTruthy();
        expect(lastPathSelectorProps.favoriteDirectories).toEqual([]);
        expect(typeof lastPathSelectorProps.onChangeFavoriteDirectories).toBe('function');
    });
});
