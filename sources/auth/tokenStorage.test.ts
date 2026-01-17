import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

function installLocalStorage() {
    const store = new Map<string, string>();
    const getItem = vi.fn((key: string) => store.get(key) ?? null);
    const setItem = vi.fn((key: string, value: string) => {
        store.set(key, value);
    });
    const removeItem = vi.fn((key: string) => {
        store.delete(key);
    });

    Object.defineProperty(globalThis, 'localStorage', {
        value: { getItem, setItem, removeItem },
        configurable: true,
    });

    return { store, getItem, setItem, removeItem };
}

describe('TokenStorage (web)', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null when localStorage JSON is invalid', async () => {
        const { setItem } = installLocalStorage();
        setItem('auth_credentials', '{not valid json');

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });

    it('returns false when localStorage.setItem throws', async () => {
        installLocalStorage();
        (globalThis.localStorage.setItem as any).mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.setCredentials({ token: 't', secret: 's' })).resolves.toBe(false);
    });

    it('returns false when localStorage.removeItem throws', async () => {
        installLocalStorage();
        (globalThis.localStorage.removeItem as any).mockImplementation(() => {
            throw new Error('SecurityError');
        });

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.removeCredentials()).resolves.toBe(false);
    });

    it('calls localStorage.getItem at most once per getCredentials call', async () => {
        const { getItem, setItem } = installLocalStorage();
        setItem('auth_credentials', JSON.stringify({ token: 't', secret: 's' }));

        const { TokenStorage } = await import('./tokenStorage');
        await TokenStorage.getCredentials();
        expect(getItem).toHaveBeenCalledTimes(1);
    });
});
