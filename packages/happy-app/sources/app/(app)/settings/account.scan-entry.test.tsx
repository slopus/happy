import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const authState = vi.hoisted(() => ({
    credentials: null as null | { token: string; secret: string },
}));
const focusState = vi.hoisted(() => ({ refresh: null as null | (() => void) }));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (callback: React.EffectCallback) => {
        focusState.refresh = () => { callback(); };
        React.useEffect(callback, [callback]);
    },
}));
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
import { fetchPushTokens, type PushToken } from '@/sync/apiPush';
import { getCurrentExpoPushToken, getPushPermissionInfo, requestPushPermissionOrOpenSettings, syncCurrentPushToken } from '@/sync/pushRegistration';
import { Modal } from '@/modal';

describe('AccountSettingsScreen', () => {
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
        focusState.refresh = null;
        vi.clearAllMocks();
        consoleErrorSpy.mockRestore();
    });

    it('does not expose a second scanner after the settings home owns the authenticated scan entry', () => {
        const itemTitles = renderer.root.findAllByType('Item').map((node: any) => node.props.title);

        expect(itemTitles).toContain('settingsAccount.status');
        expect(itemTitles).not.toContain('settingsAccount.linkNewDevice');
    });

    it('fetches push settings once when the account screen first gains focus', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        vi.mocked(fetchPushTokens).mockResolvedValue([]);
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: false });
        vi.mocked(getCurrentExpoPushToken).mockResolvedValue(null);

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });

        expect(fetchPushTokens).toHaveBeenCalledTimes(1);
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
        const unidentifiedToken = items.find((item: any) => String(item.props.title).includes('stored'));
        expect(unidentifiedToken?.props.onPress).toBeUndefined();
        expect(unidentifiedToken?.props.disabled).toBe(true);
        expect(unidentifiedToken?.props.subtitle).not.toContain('pushNotifications.otherDevice');
        expect(renderer.root.findAllByType('ItemGroup').map((group: any) => group.props.title))
            .toContain('pushNotifications.registeredTokensTitle');
        const reRegister = items.find((item: any) => item.props.title === 'pushNotifications.reRegister');
        expect(reRegister?.props.disabled).toBe(false);

        await act(async () => {
            await reRegister.props.onPress();
        });

        expect(Modal.alert).toHaveBeenCalledWith('common.success', 'pushNotifications.tokenRefreshed');
    });

    it('does not show a pre-registration token list after registration succeeds', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        let resolveFirst: (tokens: PushToken[]) => void = () => {};
        vi.mocked(fetchPushTokens)
            .mockImplementationOnce(() => new Promise<PushToken[]>(resolve => { resolveFirst = resolve; }))
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
        const reRegister = renderer.root.findAllByType('Item')
            .find((item: any) => item.props.title === 'pushNotifications.reRegister');
        await act(async () => {
            await reRegister.props.onPress();
        });
        await act(async () => {
            resolveFirst([{ id: 'first-result', token: 'ExpoPushToken[first]', createdAt: 1, updatedAt: 1 }]);
        });

        expect(renderer.root.findAllByType('Item').some((item: any) =>
            String(item.props.title).includes('first'))).toBe(false);
    });

    it('shows the pending initial list while manual registration waits on the device service', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        let resolveInitial: (tokens: PushToken[]) => void = () => {};
        vi.mocked(fetchPushTokens).mockImplementationOnce(() =>
            new Promise<PushToken[]>(resolve => { resolveInitial = resolve; }));
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: false });
        vi.mocked(getCurrentExpoPushToken).mockImplementation(() => new Promise(() => {}));
        vi.mocked(syncCurrentPushToken).mockImplementation(() => new Promise(() => {}));

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });
        const reRegister = renderer.root.findAllByType('Item')
            .find((item: any) => item.props.title === 'pushNotifications.reRegister');
        await act(async () => {
            void reRegister.props.onPress();
        });
        await act(async () => {
            resolveInitial([{ id: 'ready', token: 'ExpoPushToken[ready]', createdAt: 1, updatedAt: 1 }]);
        });

        expect(renderer.root.findAllByType('Item').some((item: any) =>
            String(item.props.title).includes('ready'))).toBe(true);
    });

    it('shows the pending initial list while the permission request waits on the device', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        let resolveInitial: (tokens: PushToken[]) => void = () => {};
        vi.mocked(fetchPushTokens).mockImplementationOnce(() =>
            new Promise<PushToken[]>(resolve => { resolveInitial = resolve; }));
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'undetermined', granted: false, canAskAgain: true });
        vi.mocked(getCurrentExpoPushToken).mockImplementation(() => new Promise(() => {}));
        vi.mocked(requestPushPermissionOrOpenSettings).mockImplementation(() => new Promise(() => {}));

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });
        const requestAgain = renderer.root.findAllByType('Item')
            .find((item: any) => item.props.title === 'pushNotifications.requestAgain');
        await act(async () => {
            void requestAgain.props.onPress();
        });
        await act(async () => {
            resolveInitial([{ id: 'ready', token: 'ExpoPushToken[ready]', createdAt: 1, updatedAt: 1 }]);
        });

        expect(renderer.root.findAllByType('Item').some((item: any) =>
            String(item.props.title).includes('ready'))).toBe(true);
    });

    it('does not allow deleting a refreshed token while device identity is being checked again', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        vi.mocked(fetchPushTokens)
            .mockResolvedValueOnce([{ id: 'old', token: 'ExpoPushToken[old]', createdAt: 1, updatedAt: 1 }])
            .mockResolvedValueOnce([{ id: 'new', token: 'ExpoPushToken[new]', createdAt: 2, updatedAt: 2 }]);
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: false });
        vi.mocked(getCurrentExpoPushToken)
            .mockResolvedValueOnce('ExpoPushToken[old]')
            .mockImplementationOnce(() => new Promise(() => {}));

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });
        await act(async () => {
            focusState.refresh?.();
        });

        const newToken = renderer.root.findAllByType('Item')
            .find((item: any) => String(item.props.title).includes('new'));
        expect(newToken?.props.onPress).toBeUndefined();
        expect(newToken?.props.disabled).toBe(true);
    });

    it('shows a registration failure without waiting for the token list to refresh', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        vi.mocked(fetchPushTokens)
            .mockResolvedValueOnce([])
            .mockImplementationOnce(() => new Promise(() => {}));
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: false });
        vi.mocked(getCurrentExpoPushToken).mockImplementation(() => new Promise(() => {}));
        vi.mocked(syncCurrentPushToken).mockResolvedValue({
            registered: false,
            token: null,
            permission: { status: 'granted', granted: true, canAskAgain: false },
            error: 'FCM token unavailable',
        });

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });
        const reRegister = renderer.root.findAllByType('Item')
            .find((item: any) => item.props.title === 'pushNotifications.reRegister');
        await act(async () => {
            await reRegister.props.onPress();
        });

        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'pushNotifications.refreshFailed\n\nFCM token unavailable');
    });

    it('shows the first completed result when two reads in the same state overlap', async () => {
        act(() => renderer.unmount());
        authState.credentials = { token: 'test-token', secret: 'test-secret' };
        let resolveFirst: (tokens: PushToken[]) => void = () => {};
        vi.mocked(fetchPushTokens)
            .mockImplementationOnce(() => new Promise<PushToken[]>(resolve => { resolveFirst = resolve; }))
            .mockImplementationOnce(() => new Promise(() => {}));
        vi.mocked(getPushPermissionInfo).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: false });
        vi.mocked(getCurrentExpoPushToken).mockImplementation(() => new Promise(() => {}));

        await act(async () => {
            renderer = TestRenderer.create(<AccountSettingsScreen />);
        });
        await act(async () => {
            focusState.refresh?.();
        });
        await act(async () => {
            resolveFirst([{ id: 'first', token: 'ExpoPushToken[first]', createdAt: 1, updatedAt: 1 }]);
        });

        expect(renderer.root.findAllByType('Item').some((item: any) =>
            String(item.props.title).includes('first'))).toBe(true);
    });
});
