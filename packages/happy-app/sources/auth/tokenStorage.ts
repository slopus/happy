import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { accountIndex, assertAccountRuntime, readAccountSelection } from './accountRuntime';

export interface AuthCredentials { token: string; secret: string }
const LEGACY_KEY = 'auth_credentials';
let cached: AuthCredentials | null | undefined;
const keyFor = (key: string) => `paws_account_${key}`;
async function read(key: string): Promise<AuthCredentials | null> {
    const raw = Platform.OS === 'web' ? localStorage.getItem(key) : await SecureStore.getItemAsync(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.token !== 'string' || typeof parsed.secret !== 'string') throw new Error('Invalid stored credentials');
    return parsed;
}
async function write(key: string, value: AuthCredentials): Promise<void> {
    const raw = JSON.stringify(value);
    if (Platform.OS === 'web') localStorage.setItem(key, raw);
    else await SecureStore.setItemAsync(key, raw);
}
async function remove(key: string): Promise<void> {
    if (Platform.OS === 'web') localStorage.removeItem(key);
    else await SecureStore.deleteItemAsync(key);
}
export const AccountVault = {
    read: (key: string) => read(keyFor(key)),
    write: (key: string, value: AuthCredentials) => write(keyFor(key), value),
    remove: (key: string) => remove(keyFor(key)),
    readLegacy: () => read(LEGACY_KEY),
    removeLegacy: () => remove(LEGACY_KEY),
};
export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        assertAccountRuntime();
        if (cached === undefined) {
            const selected = readAccountSelection();
            cached = selected ? await AccountVault.read(selected.key) : accountIndex.getString('initialized') ? null : await read(LEGACY_KEY);
        }
        assertAccountRuntime();
        return cached;
    },
    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        assertAccountRuntime();
        await write(LEGACY_KEY, credentials);
        cached = credentials;
        return true;
    },
    async removeCredentials(): Promise<boolean> {
        await remove(LEGACY_KEY);
        cached = null;
        return true;
    },
};
