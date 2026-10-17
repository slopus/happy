import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getServerUrl, getUnmanagedServerUrl } from '@/sync/serverConfig';
import { managedConfiguration } from '@/sync/managedConfiguration';

const AUTH_KEY = 'auth_credentials';

// Cache for synchronous access
let credentialsCache: string | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

interface StoredAuthCredentials extends AuthCredentials {
    managedServerUrl?: string;
}

function sameServer(left: string, right: string): boolean {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            return localStorage.getItem(AUTH_KEY) ? JSON.parse(localStorage.getItem(AUTH_KEY)!) as AuthCredentials : null;
        }
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            const credentials = JSON.parse(stored) as StoredAuthCredentials;
            if (managedConfiguration.serverUrl || credentials.managedServerUrl) {
                const originalServer = credentials.managedServerUrl ?? getUnmanagedServerUrl();
                // Never forward a previous server's bearer token after policy
                // application, changes or removal. Leave it in Keychain until
                // the user reconnects, rather than deleting their account key.
                if (!sameServer(originalServer, getServerUrl())) return null;
            }
            credentialsCache = stored; // Update cache
            return credentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        if (Platform.OS === 'web') {
            localStorage.setItem(AUTH_KEY, JSON.stringify(credentials));
            return true;
        }
        try {
            const stored: StoredAuthCredentials = {
                token: credentials.token,
                secret: credentials.secret,
                ...(managedConfiguration.serverUrl ? { managedServerUrl: getServerUrl() } : {}),
            };
            const json = JSON.stringify(stored);
            await SecureStore.setItemAsync(AUTH_KEY, json);
            credentialsCache = json; // Update cache
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {    
            localStorage.removeItem(AUTH_KEY);
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            credentialsCache = null; // Clear cache
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};