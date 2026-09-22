import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/auth/accountRuntime', () => ({ accountIndex: {} }));
import { consumePartyReturn, rememberPartyReturn } from './loginReturn';
afterEach(() => vi.unstubAllGlobals());
it('preserves the fixed login destination once, rejects expired and arbitrary destinations', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { setItem: (key: string, value: string) => store.set(key, value), getItem: (key: string) => store.get(key), removeItem: (key: string) => store.delete(key) });
    rememberPartyReturn('/agent-party-access'); expect(consumePartyReturn()).toBe('/agent-party-access'); expect(consumePartyReturn()).toBeNull();
    rememberPartyReturn('/agent-profiles', 'account-a'); expect(consumePartyReturn()).toBe('/agent-profiles?accountId=account-a');
    store.set('party-login-return', JSON.stringify({ path: 'https://evil.example', expires: Date.now() + 10000 })); expect(consumePartyReturn()).toBeNull();
    store.set('party-login-return', JSON.stringify({ path: '/agent-profiles', expires: Date.now() - 1 })); expect(consumePartyReturn()).toBeNull();
});
