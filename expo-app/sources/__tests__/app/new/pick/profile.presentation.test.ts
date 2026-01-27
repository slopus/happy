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

let lastStackScreenOptions: any = null;
vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: any) => {
            lastStackScreenOptions = options;
            return null;
        },
    },
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), setParams: vi.fn() }),
    useNavigation: () => ({ getState: () => ({ index: 1, routes: [{ key: 'a' }, { key: 'b' }] }), dispatch: vi.fn() }),
    useLocalSearchParams: () => ({ selectedId: '', machineId: 'm1' }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' }, textSecondary: '#666', status: { connected: '#0f0', disconnected: '#f00' } } } }),
    StyleSheet: { create: () => ({}) },
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
    useMachineEnvPresence: () => ({ refresh: vi.fn(), machineEnvReadyByName: {} }),
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

describe('ProfilePickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        vi.resetModules();
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        lastStackScreenOptions = null;

        await act(async () => {
            renderer.create(React.createElement(ProfilePickerScreen));
        });

        const resolvedOptions = typeof lastStackScreenOptions === 'function' ? lastStackScreenOptions() : lastStackScreenOptions;
        expect(resolvedOptions?.presentation).toBe('containedModal');
        expect(typeof resolvedOptions?.headerLeft).toBe('function');
    });
});
