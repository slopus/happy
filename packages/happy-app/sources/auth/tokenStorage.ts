import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const AUTH_KEY = 'auth_credentials';
const IDB_DB_NAME = 'happy_auth_backup';
const IDB_STORE_NAME = 'credentials';
const IDB_KEY = 'auth';
const IDB_USERID_KEY = 'userId';

// Cache for synchronous access
let credentialsCache: string | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

// IndexedDB helpers for resilient credential storage on web.
// localStorage can be cleared by the browser (Safari ITP, storage pressure),
// so we duplicate credentials in IndexedDB as a backup layer.

function openIDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
                db.createObjectStore(IDB_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbGet<T>(key: string): Promise<T | null> {
    return new Promise(async (resolve) => {
        try {
            const db = await openIDB();
            const tx = db.transaction(IDB_STORE_NAME, 'readonly');
            const store = tx.objectStore(IDB_STORE_NAME);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

function idbSet(key: string, value: unknown): Promise<void> {
    return new Promise(async (resolve) => {
        try {
            const db = await openIDB();
            const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
            const store = tx.objectStore(IDB_STORE_NAME);
            store.put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch {
            resolve();
        }
    });
}

function idbDelete(key: string): Promise<void> {
    return new Promise(async (resolve) => {
        try {
            const db = await openIDB();
            const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
            const store = tx.objectStore(IDB_STORE_NAME);
            store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch {
            resolve();
        }
    });
}

// Refresh token from CLI daemon when current token is invalid (401).
// Returns updated credentials or null if recovery failed.
let refreshPromise: Promise<AuthCredentials | null> | null = null;
export async function refreshTokenFromCLI(): Promise<AuthCredentials | null> {
    if (Platform.OS !== 'web') return null;
    // Deduplicate concurrent refresh attempts
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        try {
            const userId = await idbGet<string>(IDB_USERID_KEY);
            if (!userId) return null;
            const { getServerUrl } = await import('@/sync/serverConfig');
            const response = await fetch(`${getServerUrl()}/v1/auth/web-recover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            if (!response.ok) return null;
            const data = await response.json();
            if (!data.token || !data.secret) return null;
            const creds: AuthCredentials = { token: data.token, secret: data.secret };
            localStorage.setItem(AUTH_KEY, JSON.stringify(creds));
            await idbSet(IDB_KEY, creds);
            // Update runtime sync credentials
            try {
                const { sync } = await import('@/sync/sync');
                sync.updateToken(data.token);
            } catch { /* sync not initialized yet */ }
            console.log('[tokenStorage] Token refreshed from CLI');
            return creds;
        } catch {
            return null;
        } finally {
            refreshPromise = null;
        }
    })();
    return refreshPromise;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            // Try localStorage first (fast, synchronous)
            const stored = localStorage.getItem(AUTH_KEY);
            if (stored) {
                return JSON.parse(stored) as AuthCredentials;
            }

            // Fallback: restore from IndexedDB if localStorage was cleared
            const backup = await idbGet<AuthCredentials>(IDB_KEY);
            if (backup) {
                // Re-populate localStorage from IndexedDB backup
                localStorage.setItem(AUTH_KEY, JSON.stringify(backup));
                return backup;
            }

            return null;
        }
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
        if (Platform.OS === 'web') {
            localStorage.setItem(AUTH_KEY, JSON.stringify(credentials));
            // Backup to IndexedDB
            await idbSet(IDB_KEY, credentials);
            return true;
        }
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
        if (Platform.OS === 'web') {
            localStorage.removeItem(AUTH_KEY);
            await idbDelete(IDB_KEY);
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

    // Store userId separately for CLI recovery (userId is not sensitive)
    async setRecoveryUserId(userId: string): Promise<void> {
        if (Platform.OS === 'web') {
            await idbSet(IDB_USERID_KEY, userId);
        }
    },

    async getRecoveryUserId(): Promise<string | null> {
        if (Platform.OS === 'web') {
            return idbGet<string>(IDB_USERID_KEY);
        }
        return null;
    },
};
