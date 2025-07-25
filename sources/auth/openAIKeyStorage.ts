import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const OPENAI_KEY = 'openai_api_key';

// Cache for synchronous access
let keyCache: string | null = null;

export const OpenAIKeyStorage = {
    async getAPIKey(): Promise<string | null> {
        if (Platform.OS === 'web') {
            return localStorage.getItem(OPENAI_KEY);
        }
        try {
            const stored = await SecureStore.getItemAsync(OPENAI_KEY);
            if (stored) {
                keyCache = stored; // Update cache
            }
            return stored;
        } catch (error) {
            console.error('Error getting OpenAI API key:', error);
            return null;
        }
    },

    async setAPIKey(key: string): Promise<boolean> {
        if (Platform.OS === 'web') {
            localStorage.setItem(OPENAI_KEY, key);
            keyCache = key;
            return true;
        }
        try {
            await SecureStore.setItemAsync(OPENAI_KEY, key);
            keyCache = key; // Update cache
            return true;
        } catch (error) {
            console.error('Error setting OpenAI API key:', error);
            return false;
        }
    },

    async removeAPIKey(): Promise<boolean> {
        if (Platform.OS === 'web') {
            localStorage.removeItem(OPENAI_KEY);
            keyCache = null;
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(OPENAI_KEY);
            keyCache = null; // Clear cache
            return true;
        } catch (error) {
            console.error('Error removing OpenAI API key:', error);
            return false;
        }
    },

    // Synchronous access (only use when you know key is loaded)
    getAPIKeySync(): string | null {
        return keyCache;
    }
};