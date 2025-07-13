import * as SecureStore from 'expo-secure-store';

const AUTH_KEY = 'auth_credentials';

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        try {
            await SecureStore.setItemAsync(AUTH_KEY, JSON.stringify(credentials));
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
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
};