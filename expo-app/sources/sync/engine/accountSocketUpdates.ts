import type { Encryption } from '../encryption/encryption';
import type { Profile } from '../profile';
import { settingsParse, SUPPORTED_SCHEMA_VERSION } from '../settings';

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

