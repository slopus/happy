import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerPushToken as registerPushTokenApi } from '../apiPush';
import type { Encryption } from '../encryption/encryption';
import type { Profile } from '../profile';
import { profileParse } from '../profile';
import { settingsParse, SUPPORTED_SCHEMA_VERSION } from '../settings';
import { getServerUrl } from '../serverConfig';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';

export async function handleUpdateAccountSocketUpdate(params: {
    accountUpdate: any;
    updateCreatedAt: number;
    currentProfile: Profile;
    encryption: Encryption;
    applyProfile: (profile: Profile) => void;
    applySettings: (settings: any, version: number) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { accountUpdate, updateCreatedAt, currentProfile, encryption, applyProfile, applySettings, log } = params;

    // Build updated profile with new data
    const updatedProfile: Profile = {
        ...currentProfile,
        firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
        lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
        avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
        github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
        timestamp: updateCreatedAt, // Update timestamp to latest
    };

    // Apply the updated profile to storage
    applyProfile(updatedProfile);

    // Handle settings updates (new for profile sync)
    if (accountUpdate.settings?.value) {
        try {
            const decryptedSettings = await encryption.decryptRaw(accountUpdate.settings.value);
            const parsedSettings = settingsParse(decryptedSettings);

            // Version compatibility check
            const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
            if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                console.warn(
                    `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                        `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`,
                );
            }

            applySettings(parsedSettings, accountUpdate.settings.version);
            log.log(
                `📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`,
            );
        } catch (error) {
            console.error('❌ Failed to process settings update:', error);
            // Don't crash on settings sync errors, just log
        }
    }
}

export async function fetchAndApplyProfile(params: {
    credentials: AuthCredentials;
    applyProfile: (profile: Profile) => void;
}): Promise<void> {
    const { credentials, applyProfile } = params;

    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v1/account/profile`, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError(`Failed to fetch profile (${response.status})`, false);
        }
        throw new Error(`Failed to fetch profile: ${response.status}`);
    }

    const data = await response.json();
    const parsedProfile = profileParse(data);

    // Apply profile to storage
    applyProfile(parsedProfile);
}

export async function registerPushTokenIfAvailable(params: {
    credentials: AuthCredentials;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { credentials, log } = params;

    // Only register on mobile platforms
    if (Platform.OS === 'web') {
        return;
    }

    // Request permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    log.log('existingStatus: ' + JSON.stringify(existingStatus));

    if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
    }
    log.log('finalStatus: ' + JSON.stringify(finalStatus));

    if (finalStatus !== 'granted') {
        log.log('Failed to get push token for push notification!');
        return;
    }

    // Get push token
    const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    log.log('tokenData: ' + JSON.stringify(tokenData));

    // Register with server
    try {
        await registerPushTokenApi(credentials, tokenData.data);
        log.log('Push token registered successfully');
    } catch (error) {
        log.log('Failed to register push token: ' + JSON.stringify(error));
    }
}
