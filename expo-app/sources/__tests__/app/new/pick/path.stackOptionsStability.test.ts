import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stableMachines = [{ id: 'm1', metadata: { homeDir: '/home' } }] as const;
const stableSessions: any[] = [];
const stableRecentMachinePaths: any[] = [];
const stableFavoriteDirectories: any[] = [];

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 720 },
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: any) => {
        const didTriggerRef = React.useRef(false);
        React.useEffect(() => {
            if (didTriggerRef.current) return;
            didTriggerRef.current = true;
            // Trigger a state update that should NOT require updating Stack.Screen options.
            props.onChangeSearchQuery?.('abc');
        }, [props]);
        return null;
    },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' } } } }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => stableMachines,
    useSessions: () => stableSessions,
    useSetting: (key: string) => {
        if (key === 'usePathPickerSearch') return false;
        if (key === 'recentMachinePaths') return stableRecentMachinePaths;
        return null;
    },
    useSettingMutable: () => [stableFavoriteDirectories, vi.fn()],
}));

describe('PathPickerScreen (Stack.Screen options stability)', () => {
    it('keeps Stack.Screen options referentially stable across parent re-renders', async () => {
        const routerApi = { back: vi.fn(), setParams: vi.fn() };
        const navigationApi = { goBack: vi.fn() };
        const setOptions = vi.fn();

        vi.doMock('expo-router', () => ({
            Stack: {
                Screen: ({ options }: any) => {
                    React.useEffect(() => {
                        setOptions(options);
                    }, [options]);
                    return null;
                },
            },
            useRouter: () => routerApi,
            useNavigation: () => navigationApi,
            useLocalSearchParams: () => ({ machineId: 'm1', selectedPath: '' }),
        }));

        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        await act(async () => {
            renderer.create(React.createElement(PathPickerScreen));
        });

        expect(setOptions).toHaveBeenCalledTimes(1);
    });
});
