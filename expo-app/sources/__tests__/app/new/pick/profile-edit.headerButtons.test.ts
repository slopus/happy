import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: any) => React.createElement('Ionicons', props, props.children),
    };
});

vi.mock('expo-constants', () => ({
    default: { statusBarHeight: 0 },
}));

vi.mock('@react-navigation/elements', () => ({
    useHeaderHeight: () => 0,
}));

const routerMock = {
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
};

const navigationMock = {
    setOptions: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    getState: vi.fn(() => ({ index: 1, routes: [{ key: 'prev' }, { key: 'current' }] })),
    dispatch: vi.fn(),
};

vi.mock('expo-router', () => {
    const React = require('react');
    return {
        Stack: {
            Screen: (props: any) => React.createElement('StackScreen', props),
        },
        useRouter: () => routerMock,
        useLocalSearchParams: () => ({
            profileData: JSON.stringify({
                id: 'p1',
                name: 'Test profile',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            }),
        }),
        useNavigation: () => navigationMock,
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { header: { tint: '#000000' }, groupped: { background: '#ffffff' } } },
        rt: { insets: { bottom: 0 } },
    }),
    StyleSheet: {
        create: (fn: any) => fn({ colors: { groupped: { background: '#ffffff' } } }, { insets: { bottom: 0 } }),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/profiles/edit', () => ({
    ProfileEditForm: () => React.createElement('ProfileEditForm'),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/sync/storage', () => ({
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/sync/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfile: () => null,
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));

vi.mock('@/sync/profileMutations', () => ({
    convertBuiltInProfileToCustom: (p: any) => p,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: (p: any) => p,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), show: vi.fn() },
}));

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: vi.fn(async () => 'keep'),
}));

describe('ProfileEditScreen (header buttons)', () => {
    it('renders a header close button even when the form is pristine', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(ProfileEditScreen));
        });

        const stackScreen = tree?.root.findByType('StackScreen' as any);
        expect(typeof stackScreen?.props?.options?.headerLeft).toBe('function');
    });

    it('renders a disabled header save button when the form is pristine', async () => {
        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(ProfileEditScreen));
        });

        const stackScreen = tree?.root.findByType('StackScreen' as any);
        expect(typeof stackScreen?.props?.options?.headerRight).toBe('function');

        const headerRight = stackScreen?.props?.options?.headerRight;
        const saveButton = headerRight?.();
        expect(saveButton?.props?.disabled).toBe(true);
    });
});
