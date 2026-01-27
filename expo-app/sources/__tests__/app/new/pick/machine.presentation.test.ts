import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#666', header: { tint: '#000' }, surface: '#fff' } } }),
    StyleSheet: { create: () => ({ container: {}, emptyContainer: {}, emptyText: {} }) },
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: (props: any) => React.createElement('StackScreen', props) },
    useRouter: () => ({ back: vi.fn() }),
    useNavigation: () => ({ getState: () => ({ index: 1, routes: [{ key: 'a' }, { key: 'b' }] }), dispatch: vi.fn() }),
    useLocalSearchParams: () => ({ selectedId: 'm1' }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: any) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [],
    useSessions: () => [],
    useSetting: () => false,
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshMachinesThrottled: vi.fn() },
}));

vi.mock('@/hooks/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilities: vi.fn(),
}));

vi.mock('@/hooks/useMachineEnvPresence', () => ({
    invalidateMachineEnvPresence: vi.fn(),
}));

describe('MachinePickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(MachinePickerScreen));
        });

        const stackScreen = tree?.root.findByType('StackScreen' as any);
        expect(stackScreen?.props?.options?.presentation).toBe('containedModal');
        expect(typeof stackScreen?.props?.options?.headerLeft).toBe('function');
    });
});
