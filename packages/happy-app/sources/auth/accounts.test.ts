import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ vault: new Map<string, any>(), write: vi.fn(), cleanup: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('./accountIndex', () => import('./accountIndex.web'));
vi.mock('./authChallenge', () => ({ authChallenge: () => ({ challenge: new Uint8Array(32), signature: new Uint8Array(64), publicKey: new Uint8Array(32) }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://example.com' }));
vi.mock('./tokenStorage', () => ({ AccountVault: {
    read: async (key: string) => mocks.vault.get(key) ?? null,
    write: async (key: string, value: any) => { mocks.write(); mocks.vault.set(key, value); },
    remove: async (key: string) => { mocks.vault.delete(key); },
    removeLegacy: async () => undefined,
} }));
let data: Map<string, string>;
const credentials = (id: string) => ({ token: `header.${Buffer.from(JSON.stringify({ sub: id })).toString('base64')}.signature`, secret: Buffer.alloc(32).toString('base64url') });
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); mocks.vault.clear();
    data = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
});
describe('account registry', () => {
    it('can leave a damaged active account without deleting its data or other credentials', async () => {
        const api = await import('./accounts');
        const a = await api.saveAccountCredentials(credentials('A'), 'https://example.com');
        const b = await api.saveAccountCredentials(credentials('B'), 'https://example.com');
        await api.selectSavedAccount(a.key);
        const gen = JSON.parse(data.get('paws.accounts.active')!).generation;
        mocks.vault.set(a.key, { ...credentials('A'), secret: 'broken' });
        await expect(api.validateSavedAccount(a.key)).rejects.toThrow('Account unavailable');
        await api.recoverAccountSelection(gen);
        expect(data.has('paws.accounts.active')).toBe(false);
        expect(data.get('paws.accounts.initialized')).toBe('1');
        expect(await api.listSavedAccounts()).toHaveLength(2);
        await api.selectSavedAccount(b.key);
        const repaired = await api.saveAccountCredentials(credentials('A'), 'https://example.com');
        expect(repaired.scope).toBe(a.scope);
        await api.selectSavedAccount(a.key);
    });
    it('saves multiple accounts without switching; isolates same identity across servers', async () => {
        const api = await import('./accounts');
        const a = await api.saveAccountCredentials(credentials('A'), 'https://example.com');
        const b = await api.saveAccountCredentials(credentials('A'), 'https://other.example.com');
        expect(a.key).not.toBe(b.key);
        expect(data.has('paws.accounts.active')).toBe(false);
        expect(data.has('paws.accounts.initialized')).toBe(false);
        await api.selectSavedAccount(a.key);
        await api.removeSavedAccount(b.key);
        expect(mocks.vault.has(a.key)).toBe(true);
        await expect(api.removeSavedAccount(a.key)).rejects.toThrow();
    });
    it('preserves selection on missing target credentials or vault write failure', async () => {
        const api = await import('./accounts');
        const a = await api.saveAccountCredentials(credentials('A'), 'https://example.com');
        await api.selectSavedAccount(a.key);
        const original = data.get('paws.accounts.active');
        await expect(api.selectSavedAccount('missing')).rejects.toThrow();
        mocks.write.mockImplementationOnce(() => { throw new Error('disk full'); });
        await expect(api.saveAccountCredentials(credentials('B'), 'https://example.com')).rejects.toThrow();
        expect(data.get('paws.accounts.active')).toBe(original);
        expect(await api.listSavedAccounts()).toHaveLength(1);
    });
    it('a stale logout cannot clean up or deselect the new account', async () => {
        const api = await import('./accounts');
        const a = await api.saveAccountCredentials(credentials('A'), 'https://example.com');
        const b = await api.saveAccountCredentials(credentials('B'), 'https://example.com');
        await api.selectSavedAccount(a.key);
        const oldGeneration = JSON.parse(data.get('paws.accounts.active')!).generation;
        await api.selectSavedAccount(b.key);
        await api.logoutSavedAccount(oldGeneration, mocks.cleanup);
        expect(mocks.cleanup).not.toHaveBeenCalled();
        expect(JSON.parse(data.get('paws.accounts.active')!).key).toBe(b.key);
        expect(mocks.vault.has(b.key)).toBe(true);
    });
    it('logout retry does not repeat cleanup after committed signout', async () => {
        const api = await import('./accounts');
        const a = await api.saveAccountCredentials(credentials('A'), 'https://example.com');
        await api.selectSavedAccount(a.key);
        const gen = JSON.parse(data.get('paws.accounts.active')!).generation;
        await api.logoutSavedAccount(gen, mocks.cleanup);
        await api.logoutSavedAccount(gen, mocks.cleanup);
        expect(mocks.cleanup).toHaveBeenCalledOnce();
        expect(await api.listSavedAccounts()).toEqual([]);
    });
    it('rejects a recovery key for a different target account before storing', async () => {
        const api = await import('./accounts');
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ token: credentials('B').token }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'B' }) }));
        await expect(api.addSavedAccount({ secret: Buffer.alloc(32).toString('base64url'), serverUrl: 'https://example.com', expectedAccountId: 'A' })).rejects.toThrow('Account does not match');
        expect(mocks.write).not.toHaveBeenCalled();
    });
});
