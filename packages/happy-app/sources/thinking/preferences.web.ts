import * as React from 'react';
import { accountStorageId } from '@/auth/accountRuntime';
import { isThinkingMethod, type ThinkingMethodId } from './catalog';

export const THINKING_ENABLED_KEY = 'paws.thinking-mode.enabled.v1';
const listeners = new Set<() => void>();
function read(key: string): string | null {
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); }
    catch { return null; }
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    window.addEventListener('storage', listener);
    return () => { listeners.delete(listener); window.removeEventListener('storage', listener); };
}
function write(key: string, value: string): boolean {
    try { localStorage.setItem(key, value); }
    catch { return false; }
    listeners.forEach(listener => listener());
    return true;
}
function sessionKey(sessionId: string) {
    return `${accountStorageId('paws.thinking-mode.session.v1')}:${sessionId}`;
}
export function thinkingEnabled() { return read(THINKING_ENABLED_KEY) === 'true'; }
export function selectedThinkingMethod(sessionId: string): ThinkingMethodId | null {
    const value = read(sessionKey(sessionId));
    return isThinkingMethod(value) ? value : null;
}
export function hasThinkingHistory(sessionId: string) { return read(sessionKey(sessionId)) !== null; }
export function useThinkingPreferences(sessionId?: string) {
    const enabled = React.useSyncExternalStore(subscribe, thinkingEnabled, () => false);
    const method = React.useSyncExternalStore(subscribe, () => sessionId ? selectedThinkingMethod(sessionId) : null, () => null);
    return {
        enabled, method,
        setEnabled: (value: boolean) => write(THINKING_ENABLED_KEY, String(value)),
        setMethod: (value: ThinkingMethodId | null) => sessionId ? write(sessionKey(sessionId), value ?? 'none') : false,
    };
}
