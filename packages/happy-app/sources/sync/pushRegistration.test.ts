import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constantsMock = vi.hoisted(() => ({
    expoConfig: {},
    easConfig: undefined as { projectId?: string } | undefined,
}));

const notificationsMock = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

const persistenceMock = vi.hoisted(() => ({
    loadRegisteredPushToken: vi.fn(),
    saveRegisteredPushToken: vi.fn(),
    clearRegisteredPushToken: vi.fn(),
}));

const apiPushMock = vi.hoisted(() => ({
    registerPushToken: vi.fn(),
    unregisterPushToken: vi.fn(),
}));

vi.mock('react-native', () => ({
    Linking: { openSettings: vi.fn() },
    Platform: { OS: 'android' },
}));

vi.mock('expo-constants', () => ({
    default: constantsMock,
}));

vi.mock('expo-notifications', () => notificationsMock);

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '1.7.1',
    nativeBuildVersion: '21',
}));

vi.mock('expo-device', () => ({
    deviceName: 'Test Phone',
    modelName: 'Test Phone',
    osName: 'Android',
    osVersion: '15',
    isDevice: true,
}));

vi.mock('./persistence', () => persistenceMock);

vi.mock('./apiPush', () => apiPushMock);

import { syncCurrentPushToken } from './pushRegistration';

describe('pushRegistration', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        constantsMock.expoConfig = {};
        constantsMock.easConfig = undefined;
        vi.clearAllMocks();
        persistenceMock.loadRegisteredPushToken.mockReturnValue(null);
        notificationsMock.getPermissionsAsync.mockResolvedValue({
            status: 'granted',
            granted: true,
            canAskAgain: false,
        });
        notificationsMock.getExpoPushTokenAsync.mockResolvedValue({
            data: 'ExponentPushToken[current-device]',
        });
        apiPushMock.registerPushToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses the bundled Expo project ID when OTA constants do not include one', async () => {
        const result = await syncCurrentPushToken({
            token: 'auth-token',
            secret: 'auth-secret',
        });

        expect(notificationsMock.getExpoPushTokenAsync).toHaveBeenCalledWith({
            projectId: '16941d72-39af-4e7e-8b91-9b0c11c46a56',
        });
        expect(apiPushMock.registerPushToken).toHaveBeenCalledWith(
            { token: 'auth-token', secret: 'auth-secret' },
            'ExponentPushToken[current-device]',
        );
        expect(result).toMatchObject({
            registered: true,
            token: 'ExponentPushToken[current-device]',
        });
    });

    it('prefers the Expo project ID from runtime constants when present', async () => {
        constantsMock.expoConfig = {
            extra: {
                eas: {
                    projectId: 'runtime-project-id',
                },
            },
        };

        await syncCurrentPushToken({
            token: 'auth-token',
            secret: 'auth-secret',
        });

        expect(notificationsMock.getExpoPushTokenAsync).toHaveBeenCalledWith({
            projectId: 'runtime-project-id',
        });
    });

    it('returns the token lookup error without registering a stale token', async () => {
        notificationsMock.getExpoPushTokenAsync.mockRejectedValueOnce(new Error('FCM unavailable'));
        persistenceMock.loadRegisteredPushToken.mockReturnValue('ExponentPushToken[stale-device]');

        const result = await syncCurrentPushToken({
            token: 'auth-token',
            secret: 'auth-secret',
        });

        expect(apiPushMock.registerPushToken).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            registered: false,
            token: 'ExponentPushToken[stale-device]',
            error: 'FCM unavailable',
        });
    });
});
