import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock react-native
vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (obj: any) => obj.default },
}));
vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: any[]) => mockInvoke(...args),
}));

// Setup localStorage mock
const localStorageData = new Map<string, string>();
(global as any).localStorage = {
    getItem: (key: string) => localStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageData.set(key, value),
    removeItem: (key: string) => localStorageData.delete(key),
};

// Tauri environment
(global as any).window = { __TAURI_INTERNALS__: {} };

import { TokenStorage, MIGRATION_FLAG } from './tokenStorage';

describe('tokenStorage (Tauri keychain path)', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
        localStorageData.clear();
    });

    describe('getCredentials', () => {
        it('reads from keychain when available', async () => {
            mockInvoke.mockResolvedValue(JSON.stringify({ token: 't1', secret: 's1' }));
            const creds = await TokenStorage.getCredentials();
            expect(creds).toEqual({ token: 't1', secret: 's1' });
            expect(mockInvoke).toHaveBeenCalledWith('keychain_get', { key: 'auth_credentials' });
        });

        it('migrates from localStorage when keychain is empty', async () => {
            // keychain_get returns null (empty)
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'keychain_get') return Promise.resolve(null);
                if (cmd === 'keychain_set') return Promise.resolve(undefined);
                return Promise.resolve(null);
            });
            localStorageData.set('auth_credentials', JSON.stringify({ token: 't2', secret: 's2' }));

            const creds = await TokenStorage.getCredentials();
            expect(creds).toEqual({ token: 't2', secret: 's2' });
            // Verify migration: keychain_set was called
            expect(mockInvoke).toHaveBeenCalledWith('keychain_set', {
                key: 'auth_credentials',
                value: JSON.stringify({ token: 't2', secret: 's2' }),
            });
            // Migration flag set
            expect(localStorageData.get('_keychain_migrated')).toBe('true');
            // Old localStorage entry removed
            expect(localStorageData.has('auth_credentials')).toBe(false);
        });

        it('skips migration when flag already set', async () => {
            mockInvoke.mockResolvedValue(null);
            localStorageData.set('_keychain_migrated', 'true');
            localStorageData.set('auth_credentials', JSON.stringify({ token: 'old', secret: 'old' }));

            const creds = await TokenStorage.getCredentials();
            expect(creds).toBeNull();
            // keychain_set should NOT be called (migration skipped)
            expect(mockInvoke).not.toHaveBeenCalledWith('keychain_set', expect.anything());
        });

        it('aborts migration if keychain_set fails', async () => {
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'keychain_get') return Promise.resolve(null);
                if (cmd === 'keychain_set') return Promise.reject(new Error('no secret service'));
                return Promise.resolve(null);
            });
            localStorageData.set('auth_credentials', JSON.stringify({ token: 't3', secret: 's3' }));

            const creds = await TokenStorage.getCredentials();
            // Falls back to localStorage data (migration failed, keychain_get returned null, fallback path)
            expect(creds).toBeNull(); // migrateToKeychain returns null on failure, but fallback reads localStorage
            // localStorage should NOT be deleted
            expect(localStorageData.has('auth_credentials')).toBe(true);
            // Migration flag should NOT be set
            expect(localStorageData.has('_keychain_migrated')).toBe(false);
        });
    });

    describe('setCredentials', () => {
        it('writes to keychain', async () => {
            mockInvoke.mockResolvedValue(undefined);
            const result = await TokenStorage.setCredentials({ token: 'nt', secret: 'ns' });
            expect(result).toBe(true);
            expect(mockInvoke).toHaveBeenCalledWith('keychain_set', {
                key: 'auth_credentials',
                value: JSON.stringify({ token: 'nt', secret: 'ns' }),
            });
        });

        it('falls back to localStorage if keychain fails', async () => {
            mockInvoke.mockRejectedValue(new Error('fail'));
            const result = await TokenStorage.setCredentials({ token: 'nt', secret: 'ns' });
            expect(result).toBe(true);
            expect(localStorageData.get('auth_credentials')).toBe(JSON.stringify({ token: 'nt', secret: 'ns' }));
        });
    });

    describe('removeCredentials', () => {
        it('deletes from keychain and cleans up localStorage', async () => {
            mockInvoke.mockResolvedValue(undefined);
            localStorageData.set('auth_credentials', 'leftover');
            localStorageData.set('_keychain_migrated', 'true');

            const result = await TokenStorage.removeCredentials();
            expect(result).toBe(true);
            expect(mockInvoke).toHaveBeenCalledWith('keychain_delete', { key: 'auth_credentials' });
            expect(localStorageData.has('auth_credentials')).toBe(false);
            expect(localStorageData.has('_keychain_migrated')).toBe(false);
        });
    });
});
