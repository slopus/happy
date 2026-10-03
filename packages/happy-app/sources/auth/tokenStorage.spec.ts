import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    policy: {} as { serverUrl?: string },
    unmanagedUrl: 'https://personal.example',
    stored: null as string | null,
    remove: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/sync/managedConfiguration', () => ({ managedConfiguration: state.policy }));
vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => state.policy.serverUrl ?? state.unmanagedUrl,
    getUnmanagedServerUrl: () => state.unmanagedUrl,
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => state.stored,
    setItemAsync: async (_key: string, value: string) => { state.stored = value; },
    deleteItemAsync: state.remove,
}));
import { TokenStorage } from './tokenStorage';
const credentials = { token: 'test-token', secret: 'test-secret' };

beforeEach(() => {
    state.stored = JSON.stringify(credentials);
    state.unmanagedUrl = 'https://personal.example';
    delete state.policy.serverUrl;
    state.remove.mockClear();
});

describe('credentials across managed server changes', () => {
    it('preserves unmanaged credential behavior', async () => {
        expect(await TokenStorage.getCredentials()).toEqual(credentials);
        expect(await TokenStorage.setCredentials(credentials)).toBe(true);
        expect(JSON.parse(state.stored!)).toEqual(credentials);
    });

    it('does not forward a legacy token to a new managed server or delete the account key', async () => {
        state.policy.serverUrl = 'https://managed.example';
        expect(await TokenStorage.getCredentials()).toBeNull();
        expect(state.stored).toBe(JSON.stringify(credentials));
        expect(state.remove).not.toHaveBeenCalled();
    });

    it('reuses a legacy token if the managed server matches its original server', async () => {
        state.unmanagedUrl = 'https://managed.example/';
        state.policy.serverUrl = 'https://managed.example';
        expect(await TokenStorage.getCredentials()).toEqual(credentials);
    });

    it('records the managed server when saving newly paired credentials', async () => {
        state.policy.serverUrl = 'https://managed.example';
        expect(await TokenStorage.setCredentials(credentials)).toBe(true);
        expect(JSON.parse(state.stored!)).toEqual({ ...credentials, managedServerUrl: 'https://managed.example' });
        expect(await TokenStorage.getCredentials()).toMatchObject(credentials);
    });

    it('requires reconnecting when a managed server changes', async () => {
        state.policy.serverUrl = 'https://managed.example';
        await TokenStorage.setCredentials(credentials);
        state.policy.serverUrl = 'https://different.example';
        expect(await TokenStorage.getCredentials()).toBeNull();
    });

    it('requires reconnecting when policy removal restores a different server', async () => {
        state.policy.serverUrl = 'https://managed.example';
        await TokenStorage.setCredentials(credentials);
        delete state.policy.serverUrl;
        expect(await TokenStorage.getCredentials()).toBeNull();
        state.unmanagedUrl = 'https://managed.example';
        expect(await TokenStorage.getCredentials()).toMatchObject(credentials);
    });
});
