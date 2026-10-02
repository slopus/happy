import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const authState = vi.hoisted(() => ({
    credentials: null as null | { token: string; secret: string },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }));
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({
        credentials: authState.credentials,
        isAuthenticated: true,
        logout: vi.fn(),
    }),
}));
vi.mock('@/auth/secretKeyBackup', () => ({ formatSecretKeyForBackup: (value: string) => value }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: (action: unknown) => [false, action] }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn() } }));
vi.mock('@/sync/apiGithub', () => ({ disconnectGitHub: vi.fn() }));
vi.mock('@/sync/apiServices', () => ({ disconnectService: vi.fn() }));
vi.mock('@/sync/apiPush', () => ({ fetchPushTokens: vi.fn() }));
vi.mock('@/sync/profile', () => ({ getDisplayName: () => null }));
vi.mock('@/sync/pushRegistration', () => ({
    getCurrentExpoPushToken: vi.fn(),
    getCurrentPushDeviceMetadata: () => ({ deviceLabel: 'test-device', appLabel: 'Paws' }),
    getPushPermissionInfo: vi.fn(),
    requestPushPermissionOrOpenSettings: vi.fn(),
    removePushToken: vi.fn(),
    syncCurrentPushToken: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({
    useProfile: () => ({ connectedServices: [] }),
    useSettingMutable: () => [false, vi.fn()],
}));
vi.mock('@/sync/sync', () => ({
    sync: { anonID: 'anonymous-id', serverID: 'public-id', refreshProfile: vi.fn() },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: '#00ff88',
                text: '#ffffff',
                textSecondary: '#aaaaaa',
            },
        },
    }),
}));

import AccountSettingsScreen from './account';
import { fetchPushTokens } from '@/sync/apiPush';
import { getCurrentExpoPushToken, getPushPermissionInfo, syncCurrentPushToken } from '@/sync/pushRegistration';
import { Modal } from '@/modal';

describe('AccountSettingsScreen scan entry', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        authState.credentials = null;
        vi.clearAllMocks();
        consoleErrorSpy.mockRestore();
    });

    it('does not expose a second scanner after the settings home owns the authenticated scan entry', () => {
        const itemTitles = renderer.root.findAllByType('Item').map((node: any) => node.props.title);

        expect(itemTitles).toContain('settingsAccount.status');
        expect(itemTitles).not.toContain('settingsAccount.linkNewDevice');
    });

    it('keeps push repair available and reports its result while Expo token lookup or list refresh stalls', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        vi.mocked(fetchPushTokens)
            .mockResolvedValueOnce([{ id: 'stored-token', token: 'ExpoPushToken[stored]', createdAt: 1, updatedAt: 1 }])
            .mockImplementationOnce(() => new Promise(() => {}));
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: false });
        vi.mocked(getCurrentExpoPushToken).mockImplementation(() => new Promise(() => {}));
        vi.mocked(syncCurrentPushToken).mockResolvedValue({
            registered: true,
            token: 'ExpoPushToken[fresh]',
            permission: { status: 'granted', granted: true, canAskAgain: false },
        });

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });

        const items = renderer.root.findAllByType('Item');
        expect(items.find((item: any) => item.props.title === 'pushNotifications.permission')?.props.detail)
            .toBe('pushNotifications.permissionAllowed');
        expect(items.some((item: any) => String(item.props.title).includes('stored'))).toBe(true);
        expect(renderer.root.findAllByType('ItemGroup').map((group: any) => group.props.title))
            .toContain('pushNotifications.registeredTokensTitle');
        const reRegister = items.find((item: any) => item.props.title === 'pushNotifications.reRegister');
        expect(reRegister?.props.disabled).toBe(false);

        await act(async () => {
            await reRegister.props.onPress();
        });

        expect(Modal.alert).toHaveBeenCalledWith('common.success', 'pushNotifications.tokenRefreshed');
    });
});
