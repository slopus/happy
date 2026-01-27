import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: vi.fn() },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => (key === 'useProfiles' ? false : false),
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ isSatisfied: true, items: [] }),
}));

vi.mock('@/sync/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => [],
}));

vi.mock('@/hooks/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isLoading: false, isPreviewEnvSupported: false, meta: {} }),
}));

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: vi.fn(async () => ({ supported: false })),
}));

vi.mock('@/sync/settings', () => ({
    getProfileEnvironmentVariables: () => ({}),
}));

vi.mock('@/utils/tempDataStore', () => ({
    storeTempData: () => 'temp',
    getTempData: () => null,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' } } } }),
    StyleSheet: { create: () => ({}) },
}));

describe('ProfilePickerScreen (Stack.Screen options stability)', () => {
    it('does not trigger an infinite setOptions update loop', async () => {
        const listeners = new Set<() => void>();
        let setOptionsCalls = 0;
        let didLoop = false;

        const navigationApi = {
            getState: () => ({ index: 1, routes: [{ key: 'a' }, { key: 'b' }] }),
            dispatch: vi.fn(),
            setOptions: (_options: unknown) => {
                setOptionsCalls += 1;
                if (setOptionsCalls > 20) {
                    didLoop = true;
                    return;
                }
                listeners.forEach((notify) => notify());
            },
        };

        vi.doMock('expo-router', () => ({
            Stack: {
                Screen: ({ options }: any) => {
                    React.useEffect(() => {
                        navigationApi.setOptions(typeof options === 'function' ? options() : options);
                    }, [options]);
                    return null;
                },
            },
            useRouter: () => ({ back: vi.fn(), push: vi.fn(), setParams: vi.fn() }),
            useNavigation: () => {
                const [, force] = React.useReducer((x) => x + 1, 0);
                React.useLayoutEffect(() => {
                    listeners.add(force);
                    return () => void listeners.delete(force);
                }, [force]);
                return navigationApi as any;
            },
            useLocalSearchParams: () => ({ selectedId: '', machineId: 'm1' }),
        }));

        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;

        await act(async () => {
            renderer.create(React.createElement(ProfilePickerScreen));
        });

        expect(didLoop).toBe(false);
    });
});
