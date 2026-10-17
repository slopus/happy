import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface ManagedConfiguration {
    readonly serverUrl?: string;
    readonly analyticsEnabled?: boolean;
}

/** Validate the MDM dictionary without coercing strings/numbers into booleans. */
export function parseManagedConfiguration(value: unknown): ManagedConfiguration {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const dictionary = value as Record<string, unknown>;
    let serverUrl: string | undefined;
    if (typeof dictionary.server_url === 'string') {
        const candidate = dictionary.server_url.trim();
        try {
            const url = new URL(candidate);
            // Managed endpoints must be HTTPS origins. API callers append their
            // own paths; credentials, paths, queries and fragments are not valid.
            if (candidate.toLowerCase().startsWith('https://') && url.protocol === 'https:' && url.hostname
                && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
                serverUrl = url.origin;
            }
        } catch {
            // Ignore an invalid key independently of the analytics policy.
        }
    }
    return {
        ...(serverUrl ? { serverUrl } : {}),
        ...(typeof dictionary.analytics_enabled === 'boolean'
            ? { analyticsEnabled: dictionary.analytics_enabled }
            : {}),
    };
}

// Snapshot once per JS runtime. Existing binaries, Expo Go, Android and web do
// not provide this module and retain their current behavior. Never persist an
// MDM policy in user/account settings: removing it must restore user choices.
const nativeModule = Platform.OS === 'ios'
    ? requireOptionalNativeModule<{ configuration: unknown }>('HappyManagedConfiguration')
    : null;
export const managedConfiguration: ManagedConfiguration = Object.freeze(
    parseManagedConfiguration(nativeModule?.configuration)
);
