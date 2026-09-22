import { Platform } from 'react-native';
import { accountIndex } from '@/auth/accountRuntime';
const key = 'party-login-return';
export function rememberPartyReturn(path: '/agent-party-access' | '/agent-profiles', accountId?: string) {
    const target = path + (accountId && /^[a-zA-Z0-9_-]{1,128}$/.test(accountId) ? `?accountId=${accountId}` : '');
    const value = JSON.stringify({ path: target, expires: Date.now() + 15 * 60_000 });
    if (Platform.OS === 'web') sessionStorage.setItem(key, value);
    else accountIndex.set(key, value);
}
export function consumePartyReturn(): string | null {
    const raw = Platform.OS === 'web' ? sessionStorage.getItem(key) : accountIndex.getString(key);
    if (Platform.OS === 'web') sessionStorage.removeItem(key); else accountIndex.delete(key);
    try {
        const value = JSON.parse(raw || 'null');
        return value?.expires > Date.now() && /^\/agent-(party-access|profiles)(\?accountId=[a-zA-Z0-9_-]{1,128})?$/.test(value.path) ? value.path : null;
    } catch { return null; }
}
