import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { AuthCredentials } from '@/auth/tokenStorage';
import { clearRegisteredPushToken, loadRegisteredPushToken, saveRegisteredPushToken } from './persistence';
import { registerPushToken, unregisterPushToken } from './apiPush';
import expoProject from '../../expo-project.json';

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
    error?: string;
}

const BUNDLED_EXPO_PROJECT_ID = expoProject.projectId;
const ANDROID_PUSH_TOKEN_STAGE_TIMEOUT_MS = 25_000;

async function waitForAndroidPushTokenStage<T>(operation: Promise<T>, stage: 'FCM device token' | 'Expo push token'): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`${stage} request timed out after 25 seconds. Check Google Play services and the phone's network, then restart Paws and retry.`));
                }, ANDROID_PUSH_TOKEN_STAGE_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function fetchCurrentExpoPushToken(): Promise<string> {
    const projectId = getExpoProjectId();
    if (Platform.OS !== 'android') {
        return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    }

    // Expo normally fetches the FCM token inside getExpoPushTokenAsync. Split
    // the stages so a stalled native request can be distinguished from an
    // unreachable Expo registration endpoint without logging either token.
    console.log('Push token registration: requesting FCM device token');
    const devicePushToken = await waitForAndroidPushTokenStage(
        Notifications.getDevicePushTokenAsync(),
        'FCM device token',
    );
    console.log('Push token registration: requesting Expo push token');
    const expoPushToken = await waitForAndroidPushTokenStage(
        Notifications.getExpoPushTokenAsync({ projectId, devicePushToken }),
        'Expo push token',
    );
    return expoPushToken.data;
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

function getExpoProjectId(): string {
    return Constants?.expoConfig?.extra?.eas?.projectId
        ?? Constants?.easConfig?.projectId
        ?? BUNDLED_EXPO_PROJECT_ID;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return 'Unknown error';
    }
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

    try {
        return await fetchCurrentExpoPushToken() ?? loadRegisteredPushToken();
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

    try {
        const currentToken = await fetchCurrentExpoPushToken();
        const previousToken = loadRegisteredPushToken();

        if (!currentToken) {
            return {
                registered: false,
                token: previousToken,
                permission,
                error: 'Expo returned an empty push token.',
            };
        }

        console.log('Push token registration: submitting to Paws server');
        await registerPushToken(credentials, currentToken);
        console.log('Push token registration: accepted by Paws server');
        saveRegisteredPushToken(currentToken);

        if (previousToken && previousToken !== currentToken) {
            // The new registration is already active. Cleaning up a stale
            // token must not keep the manual action spinning or report failure.
            void unregisterPushToken(credentials, previousToken).catch(error => {
                console.log('Failed to unregister previous push token:', error);
            });
        }

        return {
            registered: true,
            token: currentToken,
            permission,
        };
    } catch (error) {
        console.log('Failed to sync Expo push token:', error);
        return {
            registered: false,
            token: loadRegisteredPushToken(),
            permission,
            error: getErrorMessage(error),
        };
    }
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
        Application.nativeApplicationVersion ? `Paws ${Application.nativeApplicationVersion}` : null,
        Application.nativeBuildVersion ? `build ${Application.nativeBuildVersion}` : null,
        Device.isDevice === false ? 'simulator' : null,
    ].filter((value): value is string => !!value);

    return {
        deviceLabel: deviceParts.join(' • ') || `${Platform.OS} device`,
        appLabel: appParts.length > 0 ? appParts.join(' • ') : null,
    };
}
