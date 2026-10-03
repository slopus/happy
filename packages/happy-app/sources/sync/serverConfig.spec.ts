import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ policy: {} as { serverUrl?: string }, storage: new Map<string, unknown>() }));
vi.mock('./managedConfiguration', () => ({ managedConfiguration: state.policy }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return state.storage.get(key); }
    getBoolean(key: string) { return state.storage.get(key); }
    set(key: string, value: unknown) { state.storage.set(key, value); }
    delete(key: string) { state.storage.delete(key); }
} }));
import { getServerUrl, getUnmanagedServerUrl, setServerUrl } from './serverConfig';

beforeEach(() => {
    delete state.policy.serverUrl;
    state.storage.clear();
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('__HAPPY_CONFIG__', undefined);
    vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('managed server precedence', () => {
    it('overrides local, web and build configuration without overwriting the local choice', () => {
        state.storage.set('custom-server-url', 'https://personal.example');
        vi.stubGlobal('__HAPPY_CONFIG__', { serverUrl: 'https://web.example' });
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', 'https://build.example');
        state.policy.serverUrl = 'https://managed.example';
        expect(getServerUrl()).toBe('https://managed.example');
        expect(getUnmanagedServerUrl()).toBe('https://personal.example');
        setServerUrl('https://override.example');
        setServerUrl(null);
        expect(state.storage.get('custom-server-url')).toBe('https://personal.example');
        delete state.policy.serverUrl; // Next runtime after policy removal.
        expect(getServerUrl()).toBe('https://personal.example');
    });

    it('retains all existing fallbacks when no managed server is present', () => {
        expect(getServerUrl()).toBe('https://api.cluster-fluster.com');
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', 'https://build.example');
        expect(getServerUrl()).toBe('https://build.example');
        vi.stubGlobal('__HAPPY_CONFIG__', { serverUrl: 'https://web.example' });
        expect(getServerUrl()).toBe('https://web.example');
        setServerUrl(' https://personal.example ');
        expect(getServerUrl()).toBe('https://personal.example');
        setServerUrl(null);
        expect(getServerUrl()).toBe('https://web.example');
    });
});
