import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { isTauri } from '@/utils/platform';

const AUTH_KEY = 'auth_credentials';
const MIGRATION_FLAG = '_keychain_migrated';

// Cache for synchronous access
let credentialsCache: string | null = null;

// Lazy-load Tauri invoke to avoid import errors on non-Tauri platforms
let tauriInvoke: ((cmd: string, args?: any) => Promise<any>) | null = null;
async function getInvoke() {
    if (!tauriInvoke) {
        const { invoke } = await import('@tauri-apps/api/core');
        tauriInvoke = invoke;
    }
    return tauriInvoke;
}

export interface AuthCredentials {
    token: string;
    secret: string;
}

// Migrate credentials from localStorage to OS keychain (one-time, on first Tauri launch)
async function migrateToKeychain(invoke: (cmd: string, args?: any) => Promise<any>): Promise<AuthCredentials | null> {
    // Already migrated?
    if (localStorage.getItem(MIGRATION_FLAG) === 'true') {
        return null;
    }

    const stored = localStorage.getItem(AUTH_KEY);
    if (!stored) return null;

    try {
        // Write to keychain first
        await invoke('keychain_set', { key: AUTH_KEY, value: stored });
        // Set migration flag
        localStorage.setItem(MIGRATION_FLAG, 'true');
        // Delete old localStorage entry
        localStorage.removeItem(AUTH_KEY);
        return JSON.parse(stored) as AuthCredentials;
    } catch (e) {
        // Keychain write failed — don't touch localStorage
        console.warn('[keychain] Migration failed, keeping localStorage:', e);
        return null;
    }
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        // Tauri: use OS keychain with localStorage migration
        if (isTauri()) {
            try {
                const invoke = await getInvoke();
                const stored = await invoke('keychain_get', { key: AUTH_KEY }) as string | null;
                if (stored) {
                    return JSON.parse(stored) as AuthCredentials;
                }
                // Try migration from localStorage
                const migrated = await migrateToKeychain(invoke);
                if (migrated) return migrated;
                return null;
            } catch (e) {
                console.warn('[keychain] Read failed, falling back to localStorage:', e);
                // Fallback to localStorage
                const stored = localStorage.getItem(AUTH_KEY);
                return stored ? JSON.parse(stored) as AuthCredentials : null;
            }
        }

        // Web: localStorage
        if (Platform.OS === 'web') {
            return localStorage.getItem(AUTH_KEY) ? JSON.parse(localStorage.getItem(AUTH_KEY)!) as AuthCredentials : null;
        }

        // Native: SecureStore
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            credentialsCache = stored;
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        if (isTauri()) {
            try {
                const invoke = await getInvoke();
                await invoke('keychain_set', { key: AUTH_KEY, value: JSON.stringify(credentials) });
                return true;
            } catch (e) {
                console.warn('[keychain] Write failed, falling back to localStorage:', e);
                localStorage.setItem(AUTH_KEY, JSON.stringify(credentials));
                return true;
            }
        }

        if (Platform.OS === 'web') {
            localStorage.setItem(AUTH_KEY, JSON.stringify(credentials));
            return true;
        }

        try {
            const json = JSON.stringify(credentials);
            await SecureStore.setItemAsync(AUTH_KEY, json);
            credentialsCache = json;
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (isTauri()) {
            try {
                const invoke = await getInvoke();
                await invoke('keychain_delete', { key: AUTH_KEY });
                // Also clean up any leftover localStorage
                localStorage.removeItem(AUTH_KEY);
                localStorage.removeItem(MIGRATION_FLAG);
                return true;
            } catch (e) {
                console.warn('[keychain] Delete failed:', e);
                localStorage.removeItem(AUTH_KEY);
                return true;
            }
        }

        if (Platform.OS === 'web') {
            localStorage.removeItem(AUTH_KEY);
            return true;
        }

        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            credentialsCache = null;
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};

// Exported for testing
export { MIGRATION_FLAG };