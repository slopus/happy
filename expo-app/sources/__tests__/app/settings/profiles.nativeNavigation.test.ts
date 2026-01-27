import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: any) => React.createElement('Ionicons', props, props.children),
    };
});

const routerMock = {
    push: vi.fn(),
    back: vi.fn(),
};

vi.mock('expo-router', () => ({
    useRouter: () => routerMock,
    useNavigation: () => ({ setOptions: vi.fn() }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { groupped: { background: '#ffffff' }, surface: '#ffffff', divider: '#dddddd' } },
        rt: { insets: { bottom: 0 } },
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { groupped: { background: '#ffffff' }, divider: '#dddddd' } }) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/storage', () => ({
    useSetting: () => false,
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: vi.fn() },
}));

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: vi.fn(async () => 'keep'),
}));

vi.mock('@/components/profiles/edit', () => ({
    ProfileEditForm: () => React.createElement('ProfileEditForm'),
}));

let capturedProfilesListProps: any = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: (props: any) => {
        capturedProfilesListProps = props;
        return React.createElement('ProfilesList');
    },
}));

vi.mock('@/sync/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));

vi.mock('@/sync/profileMutations', () => ({
    convertBuiltInProfileToCustom: (p: any) => p,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: (p: any) => p,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props, props.children),
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => React.createElement('SecretRequirementModal'),
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ isSatisfied: true, items: [] }),
}));

vi.mock('@/sync/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => [],
}));

describe('ProfileManager (native)', () => {
    it('navigates to the profile edit screen instead of using the inline modal editor', async () => {
        const ProfileManager = (await import('@/app/(app)/settings/profiles')).default;

        capturedProfilesListProps = null;
        routerMock.push.mockClear();

        await act(async () => {
            renderer.create(React.createElement(ProfileManager));
        });

        expect(typeof capturedProfilesListProps?.onEditProfile).toBe('function');

        await act(async () => {
            capturedProfilesListProps.onEditProfile({
                id: 'p1',
                name: 'Test profile',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            });
        });

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/profile-edit',
            params: { profileId: 'p1' },
        });
    });
});
