import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('./accountIndex', () => import('./accountIndex.web'));

let data: Map<string, string>;
beforeEach(() => {
    vi.resetModules();
    data = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
    });
});
const selection = (key: string, generation = key) => ({ key, scope: key, generation, serverUrl: 'https://example.com' });

describe('account runtime isolation', () => {
    it('recovers legacy scope if interrupted between active pointer and migration marker', async () => {
        let runtime = await import('./accountRuntime');
        const setItem = localStorage.setItem;
        localStorage.setItem = (key, value) => {
            if (key.endsWith('initialized')) throw new Error('interrupted');
            setItem(key, value);
        };
        expect(() => runtime.adoptLegacySelection({ ...selection('A'), scope: 'legacy' })).toThrow('interrupted');
        localStorage.setItem = setItem;
        vi.resetModules();
        runtime = await import('./accountRuntime');
        expect(runtime.accountStorageId()).toBeUndefined();
        expect(runtime.getActiveAccountKey()).toBe('A');
    });
    it('keeps legacy storage during adoption, then isolates A → B → A', async () => {
        let runtime = await import('./accountRuntime');
        expect(runtime.accountStorageId()).toBeUndefined();
        runtime.adoptLegacySelection({ ...selection('A'), scope: 'legacy' });
        expect(runtime.accountStorageId()).toBeUndefined();
        runtime.commitAccountSelection(selection('B'));
        expect(() => runtime.assertAccountRuntime()).toThrow();
        expect(runtime.accountStorageId()).toBeUndefined(); // old handles never change
        vi.resetModules();
        runtime = await import('./accountRuntime');
        expect(runtime.accountStorageId()).toBe('default-account-B');
        runtime.commitAccountSelection({ ...selection('A', 'A2'), scope: 'legacy' });
        vi.resetModules();
        runtime = await import('./accountRuntime');
        expect(runtime.accountStorageId()).toBeUndefined();
    });
    it('recovers malformed selection into isolated signed-out storage', async () => {
        data.set('paws.accounts.initialized', '1');
        data.set('paws.accounts.active', '{bad');
        const runtime = await import('./accountRuntime');
        expect(runtime.readAccountSelection()).toBeNull();
        expect(runtime.accountStorageId()).toBe('default-signed-out');
    });
    it('never gives a stale tab another account credentials', async () => {
        data.set('paws.accounts.active', JSON.stringify(selection('A')));
        data.set('paws_account_A', JSON.stringify({ token: 'tokenA', secret: 'secretA' }));
        data.set('paws_account_B', JSON.stringify({ token: 'tokenB', secret: 'secretB' }));
        const { TokenStorage } = await import('./tokenStorage');
        expect((await TokenStorage.getCredentials())?.token).toBe('tokenA');
        data.set('paws.accounts.active', JSON.stringify(selection('B')));
        await expect(TokenStorage.getCredentials()).rejects.toThrow('Account changed');
    });
    it('does not resurrect old credentials after signout or corrupt metadata', async () => {
        data.set('paws.accounts.initialized', '1');
        data.set('auth_credentials', JSON.stringify({ token: 'old', secret: 'old' }));
        const { TokenStorage } = await import('./tokenStorage');
        expect(await TokenStorage.getCredentials()).toBeNull();
    });
    it('validates server origins and freezes the current runtime', async () => {
        const runtime = await import('./accountRuntime');
        expect(runtime.canonicalAccountServer('https://EXAMPLE.com/')).toBe('https://example.com');
        for (const url of ['javascript:x', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=x']) {
            expect(() => runtime.canonicalAccountServer(url)).toThrow();
        }
        runtime.freezeAccountRuntime();
        expect(runtime.accountRuntimeCurrent()).toBe(false);
    });
});
