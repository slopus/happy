import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { AuthCredentials } from '@/auth/tokenStorage';
import { clearRegisteredPushToken, loadRegisteredPushToken, saveRegisteredPushToken } from './persistence';
import { registerPushToken, unregisterPushToken } from './apiPush';

export type PushPermissionStatus = 'unsupported' | 'granted' | 'denied' | 'undetermined';

export interface PushPermissionInfo {
    status: PushPermissionStatus;
    granted: boolean;
    canAskAgain: boolean;
}

export interface CurrentPushDeviceMetadata {
    deviceLabel: string;
    appLabel: string | null;
}

export interface PushPermissionRequestResult {
    granted: boolean;
    openedSettings: boolean;
    permission: PushPermissionInfo;
}

export interface SyncCurrentPushTokenResult {
    registered: boolean;
    token: string | null;
    permission: PushPermissionInfo;
}

function normalizePushPermission(result: {
    status: string;
    granted?: boolean;
    canAskAgain?: boolean;
}): PushPermissionInfo {
    const status: PushPermissionStatus =
        result.status === 'granted' || result.status === 'denied' || result.status === 'undetermined'
            ? result.status
            : 'undetermined';

    return {
        status,
        granted: result.granted === true || status === 'granted',
        canAskAgain: result.canAskAgain === true,
    };
}

function getExpoProjectId(): string | null {
    return Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId ?? null;
}

export async function getPushPermissionInfo(): Promise<PushPermissionInfo> {
    if (Platform.OS === 'web') {
        return {
            status: 'unsupported',
            granted: false,
            canAskAgain: false,
        };
    }

    try {
        return normalizePushPermission(await Notifications.getPermissionsAsync());
    } catch (error) {
        console.log('Failed to get push notification permissions:', error);
        return {
            status: 'undetermined',
            granted: false,
            canAskAgain: false,
        };
    }
}

export async function requestPushPermissionOrOpenSettings(): Promise<PushPermissionRequestResult> {
    if (Platform.OS === 'web') {
        return {
            granted: false,
            openedSettings: false,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            }
        };
    }

    const existingPermission = await getPushPermissionInfo();
    if (existingPermission.granted) {
        return {
            granted: true,
            openedSettings: false,
            permission: existingPermission,
        };
    }

    if (existingPermission.canAskAgain) {
        const requestedPermission = normalizePushPermission(await Notifications.requestPermissionsAsync());
        return {
            granted: requestedPermission.granted,
            openedSettings: false,
            permission: requestedPermission,
        };
    }

    await Linking.openSettings();
    return {
        granted: false,
        openedSettings: true,
        permission: existingPermission,
    };
}

export async function getCurrentExpoPushToken(): Promise<string | null> {
    if (Platform.OS === 'web') {
        return null;
    }

    const permission = await getPushPermissionInfo();
    if (!permission.granted) {
        return loadRegisteredPushToken();
    }

    const projectId = getExpoProjectId();
    if (!projectId) {
        return loadRegisteredPushToken();
    }

    try {
        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        return tokenData.data ?? loadRegisteredPushToken();
    } catch (error) {
        console.log('Failed to get Expo push token:', error);
        return loadRegisteredPushToken();
    }
}

export async function syncCurrentPushToken(credentials: AuthCredentials): Promise<SyncCurrentPushTokenResult> {
    if (Platform.OS === 'web') {
        return {
            registered: false,
            token: null,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            }
        };
    }

    let permission = await getPushPermissionInfo();
    if (!permission.granted) {
        if (!permission.canAskAgain) {
            return {
                registered: false,
                token: loadRegisteredPushToken(),
                permission,
            };
        }

        permission = normalizePushPermission(await Notifications.requestPermissionsAsync());
        if (!permission.granted) {
            return {
                registered: false,
                token: loadRegisteredPushToken(),
                permission,
            };
        }
    }

    const projectId = getExpoProjectId();
    if (!projectId) {
        return {
            registered: false,
            token: loadRegisteredPushToken(),
            permission,
        };
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const currentToken = tokenData.data;
    const previousToken = loadRegisteredPushToken();

    await registerPushToken(credentials, currentToken);
    saveRegisteredPushToken(currentToken);

    if (previousToken && previousToken !== currentToken) {
        try {
            await unregisterPushToken(credentials, previousToken);
        } catch (error) {
            console.log('Failed to unregister previous push token:', error);
        }
    }

    return {
        registered: true,
        token: currentToken,
        permission,
    };
}

export async function removePushToken(credentials: AuthCredentials, token: string): Promise<void> {
    await unregisterPushToken(credentials, token);

    if (loadRegisteredPushToken() === token) {
        clearRegisteredPushToken();
    }
}

export function getCurrentPushDeviceMetadata(): CurrentPushDeviceMetadata {
    const deviceParts = [
        Device.deviceName,
        Device.modelName && Device.modelName !== Device.deviceName ? Device.modelName : null,
        [Device.osName ?? Platform.OS, Device.osVersion].filter(Boolean).join(' '),
    ].filter((value): value is string => !!value && value.trim().length > 0);

    const appParts = [
        Application.nativeApplicationVersion ? `Happy ${Application.nativeApplicationVersion}` : null,
        Application.nativeBuildVersion ? `build ${Application.nativeBuildVersion}` : null,
        Device.isDevice === false ? 'simulator' : null,
    ].filter((value): value is string => !!value);

    return {
        deviceLabel: deviceParts.join(' • ') || `${Platform.OS} device`,
        appLabel: appParts.length > 0 ? appParts.join(' • ') : null,
    };
}
