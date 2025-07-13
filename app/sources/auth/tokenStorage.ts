import * as SecureStore from 'expo-secure-store';

const AUTH_KEY = 'auth_credentials';

// Cache for synchronous access
let credentialsCache: string | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            credentialsCache = stored; // Update cache
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        try {
            const json = JSON.stringify(credentials);
            await SecureStore.setItemAsync(AUTH_KEY, json);
            credentialsCache = json; // Update cache
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            credentialsCache = null; // Clear cache
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },

    // Legacy methods for backward compatibility
    async getToken(): Promise<string | null> {
        const credentials = await this.getCredentials();
        return credentials?.token || null;
    },

    async setToken(token: string): Promise<boolean> {
        // This is now deprecated, but kept for compatibility
        console.warn('setToken is deprecated, use setCredentials instead');
        return false;
    },

    async removeToken(): Promise<boolean> {
        return this.removeCredentials();
    },

    // Synchronous access (only use when you know credentials are loaded)
    getCredentialsSync(): string | null {
        return credentialsCache;
    }
};