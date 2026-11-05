import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({
    values: new Map<string, string>(),
}));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString = (key: string) => disk.values.get(key);
    getBoolean = () => undefined;
    set = (key: string, value: string) => { disk.values.set(key, value); };
    delete = (key: string) => { disk.values.delete(key); };
} }));

import { getServerUrl, isUsingCustomServer, setServerUrl } from './serverConfig';

beforeEach(() => {
    (globalThis as any).__DEV__ = false;
    disk.values.clear();
});

afterEach(() => {
    delete (globalThis as any).__HAPPY_CONFIG__;
});

describe('server URL trailing slashes', () => {
    it('drops a trailing slash when a custom server is saved', () => {
        setServerUrl('https://happy.example.com/');
        expect(getServerUrl()).toBe('https://happy.example.com');
        expect(disk.values.get('custom-server-url')).toBe('https://happy.example.com');
    });

    it('drops trailing slashes from a stored URL', () => {
        disk.values.set('custom-server-url', 'https://happy.example.com//');
        expect(getServerUrl()).toBe('https://happy.example.com');
    });

    it('drops a trailing slash from the injected web config', () => {
        (globalThis as any).__HAPPY_CONFIG__ = { serverUrl: 'https://happy.example.com/' };
        expect(getServerUrl()).toBe('https://happy.example.com');
    });

    it('keeps a path prefix', () => {
        setServerUrl('https://example.com/happy/');
        expect(getServerUrl()).toBe('https://example.com/happy');
    });

    it('treats a bare slash as no custom server', () => {
        setServerUrl('/');
        expect(disk.values.has('custom-server-url')).toBe(false);
        expect(isUsingCustomServer()).toBe(false);
    });

    it('leaves the default server alone', () => {
        expect(getServerUrl()).toBe('https://api.cluster-fluster.com');
        expect(isUsingCustomServer()).toBe(false);
    });
});
