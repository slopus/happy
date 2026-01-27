import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
    TurboModuleRegistry: { getEnforcing: () => ({}) },
}));

let lastStackScreenOptions: any = null;
vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: any) => {
            lastStackScreenOptions = options;
            return null;
        },
    },
    useRouter: () => ({ back: vi.fn() }),
    useNavigation: () => ({ getState: () => ({ index: 1, routes: [{ key: 'a' }, { key: 'b' }] }) }),
    useLocalSearchParams: () => ({ machineId: 'm1', selectedPath: '/tmp' }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' }, textSecondary: '#666', input: { background: '#fff', placeholder: '#aaa', text: '#000' }, divider: '#ddd' } } }),
    StyleSheet: { create: (fn: any) => fn({ colors: { header: { tint: '#000' }, textSecondary: '#666', input: { background: '#fff', placeholder: '#aaa', text: '#000' }, divider: '#ddd' } }) },
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
    PathSelector: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [{ id: 'm1', metadata: { homeDir: '/home' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        if (key === 'usePathPickerSearch') return false;
        return null;
    },
    useSettingMutable: () => [[], vi.fn()],
}));

describe('PathPickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        lastStackScreenOptions = null;

        await act(async () => {
            renderer.create(React.createElement(PathPickerScreen));
        });

        expect(lastStackScreenOptions?.presentation).toBe('containedModal');
        expect(typeof lastStackScreenOptions?.headerLeft).toBe('function');
    });
});
