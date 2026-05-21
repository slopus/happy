/**
 * Secure storage for basic-auth credentials used with a custom happy server.
 *
 * Keychain on iOS, Keystore on Android, encrypted file on macOS, localStorage
 * on Web (the only platform without OS-backed secret storage — accepted
 * trade-off for the desktop / web build).
 *
 * The credentials are kept *separate* from the URL in MMKV (which stays
 * unencrypted but contains only the public endpoint). When the user toggles
 * "Remember credentials securely" off, the secure-store entry is deleted but
 * the URL is left intact (with credentials inlined in it for the current
 * session only).
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'server_credentials_v1';

export interface ServerCredentials {
    username: string;
    password: string;
}

export const ServerCredentialsStore = {
    async get(): Promise<ServerCredentials | null> {
        try {
            if (Platform.OS === 'web') {
                const raw = localStorage.getItem(KEY);
                return raw ? (JSON.parse(raw) as ServerCredentials) : null;
            }
            const raw = await SecureStore.getItemAsync(KEY);
            return raw ? (JSON.parse(raw) as ServerCredentials) : null;
        } catch (e) {
            console.error('ServerCredentialsStore.get failed', e);
            return null;
        }
    },

    async set(credentials: ServerCredentials): Promise<boolean> {
        try {
            const json = JSON.stringify(credentials);
            if (Platform.OS === 'web') {
                localStorage.setItem(KEY, json);
                return true;
            }
            await SecureStore.setItemAsync(KEY, json);
            return true;
        } catch (e) {
            console.error('ServerCredentialsStore.set failed', e);
            return false;
        }
    },

    async clear(): Promise<boolean> {
        try {
            if (Platform.OS === 'web') {
                localStorage.removeItem(KEY);
                return true;
            }
            await SecureStore.deleteItemAsync(KEY);
            return true;
        } catch (e) {
            console.error('ServerCredentialsStore.clear failed', e);
            return false;
        }
    },
};

/**
 * Compose a URL with basic-auth credentials inlined. Returns the original
 * URL unchanged if either field is empty.
 */
export function inlineCredentials(url: string, creds: ServerCredentials | null): string {
    if (!creds || !creds.username || !creds.password) return url;
    try {
        const parsed = new URL(url);
        parsed.username = encodeURIComponent(creds.username);
        parsed.password = encodeURIComponent(creds.password);
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Strip user:pass@ from a URL for display purposes.
 */
export function stripCredentials(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Extract user/pass from a URL if present. Returns null if none.
 */
export function extractCredentials(url: string): ServerCredentials | null {
    try {
        const parsed = new URL(url);
        if (!parsed.username && !parsed.password) return null;
        return {
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
        };
    } catch {
        return null;
    }
}
