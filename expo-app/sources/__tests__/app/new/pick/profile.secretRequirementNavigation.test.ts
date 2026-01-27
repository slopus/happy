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

const routerMock = {
    push: vi.fn(),
    back: vi.fn(),
};

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => routerMock,
    useNavigation: () => ({ getState: () => ({ index: 1, routes: [{ key: 'a' }, { key: 'b' }] }), dispatch: vi.fn(), setParams: vi.fn() }),
    useLocalSearchParams: () => ({ selectedId: '', machineId: 'm1' }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' }, textSecondary: '#666' } } }),
    StyleSheet: { create: () => ({}) },
}));

const modalShowMock = vi.fn();
vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: (...args: any[]) => modalShowMock(...args) },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'useProfiles') return true;
        if (key === 'experiments') return false;
        return false;
    },
    useSettingMutable: (key: string) => {
        if (key === 'secrets') return [[], vi.fn()];
        if (key === 'secretBindingsByProfileId') return [{}, vi.fn()];
        if (key === 'profiles') return [[], vi.fn()];
        if (key === 'favoriteProfiles') return [[], vi.fn()];
        return [[], vi.fn()];
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

let capturedProfilesListProps: any = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: (props: any) => {
        capturedProfilesListProps = props;
        return null;
    },
}));

vi.mock('@/sync/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => ['DEESEEK_AUTH_TOKEN'],
}));

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: vi.fn(async () => ({ supported: false })),
}));

vi.mock('@/sync/settings', () => ({
    getProfileEnvironmentVariables: () => ({}),
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({
        isSatisfied: false,
        items: [{ envVarName: 'DEESEEK_AUTH_TOKEN', required: true, isSatisfied: false }],
    }),
}));

vi.mock('@/hooks/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isLoading: false, isPreviewEnvSupported: false, meta: {} }),
}));

vi.mock('@/utils/tempDataStore', () => ({
    storeTempData: () => 'temp',
    getTempData: () => null,
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

describe('ProfilePickerScreen (native secret requirement)', () => {
    it('navigates to the secret requirement screen when required secrets are missing', async () => {
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        capturedProfilesListProps = null;
        routerMock.push.mockClear();
        modalShowMock.mockClear();

        await act(async () => {
            renderer.create(React.createElement(ProfilePickerScreen));
        });

        expect(typeof capturedProfilesListProps?.onPressProfile).toBe('function');

        await act(async () => {
            await capturedProfilesListProps.onPressProfile({
                id: 'deepseek',
                name: 'DeepSeek',
                isBuiltIn: true,
                compatibility: { claude: true, codex: true, gemini: true },
            });
        });

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                profileId: 'deepseek',
                machineId: 'm1',
                secretEnvVarName: 'DEESEEK_AUTH_TOKEN',
                secretEnvVarNames: 'DEESEEK_AUTH_TOKEN',
                revertOnCancel: '0',
            }),
        });
    });
});
