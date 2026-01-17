import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/storageScope';

const AUTH_KEY = 'auth_credentials';

function getAuthKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(AUTH_KEY, scope);
}

// Cache for synchronous access
let credentialsCache: string | null = null;
let credentialsCacheKey: string | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        const key = getAuthKey();
        if (Platform.OS === 'web') {
            return localStorage.getItem(key) ? JSON.parse(localStorage.getItem(key)!) as AuthCredentials : null;
        }
        if (credentialsCache && credentialsCacheKey === key) {
            try {
                return JSON.parse(credentialsCache) as AuthCredentials;
            } catch {
                // Ignore cache parse errors, fall through to secure store read.
            }
        }
        try {
            const stored = await SecureStore.getItemAsync(key);
            if (!stored) return null;
            credentialsCache = stored; // Update cache
            credentialsCacheKey = key;
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const key = getAuthKey();
        if (Platform.OS === 'web') {
            localStorage.setItem(key, JSON.stringify(credentials));
            return true;
        }
        try {
            const json = JSON.stringify(credentials);
            await SecureStore.setItemAsync(key, json);
            credentialsCache = json; // Update cache
            credentialsCacheKey = key;
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        const key = getAuthKey();
        if (Platform.OS === 'web') {    
            localStorage.removeItem(key);
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(key);
            credentialsCache = null; // Clear cache
            credentialsCacheKey = null;
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};