import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ os: 'ios', module: null as { configuration: unknown } | null }));
vi.mock('react-native', () => ({ Platform: { get OS() { return native.os; } } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: vi.fn(() => native.module) }));

beforeEach(() => { vi.resetModules(); native.os = 'ios'; native.module = null; });
afterEach(() => vi.restoreAllMocks());

describe('managed configuration', () => {
    it('reads and freezes the iOS policy before its consumers initialize', async () => {
        native.module = { configuration: { server_url: ' https://RELAY.example:8443/ ', analytics_enabled: false } };
        const { managedConfiguration } = await import('./managedConfiguration');
        expect(managedConfiguration).toEqual({ serverUrl: 'https://relay.example:8443', analyticsEnabled: false });
        expect(Object.isFrozen(managedConfiguration)).toBe(true);
        native.module.configuration = { server_url: 'https://other.example', analytics_enabled: true };
        expect(managedConfiguration.serverUrl).toBe('https://relay.example:8443');
        expect(managedConfiguration.analyticsEnabled).toBe(false);
    });

    it('reads policy updates and removal on the next runtime', async () => {
        native.module = { configuration: { analytics_enabled: false } };
        expect((await import('./managedConfiguration')).managedConfiguration.analyticsEnabled).toBe(false);
        native.module.configuration = {};
        vi.resetModules();
        expect((await import('./managedConfiguration')).managedConfiguration).toEqual({});
    });

    it.each(['android', 'web'])('ignores native policy on %s', async (os) => {
        native.os = os;
        native.module = { configuration: { analytics_enabled: false } };
        expect((await import('./managedConfiguration')).managedConfiguration).toEqual({});
    });

    it('supports older native binaries without the module', async () => {
        expect((await import('./managedConfiguration')).managedConfiguration).toEqual({});
    });

    it.each([null, undefined, [], 'invalid', 1, false])('ignores a malformed dictionary: %s', async (value) => {
        const { parseManagedConfiguration } = await import('./managedConfiguration');
        expect(parseManagedConfiguration(value)).toEqual({});
    });

    it.each(['http://relay.example', 'https:relay.example', 'file:///tmp/config', 'not a url', '',
        'https://user:password@relay.example', 'https://relay.example/api',
        'https://relay.example?token=secret', 'https://relay.example#fragment', 42])(
        'rejects an invalid server independently of analytics: %s', async (server_url) => {
            const { parseManagedConfiguration } = await import('./managedConfiguration');
            expect(parseManagedConfiguration({ server_url, analytics_enabled: false })).toEqual({ analyticsEnabled: false });
        }
    );

    it.each(['false', 'true', 0, 1, null, undefined])('does not coerce analytics_enabled: %s', async (analytics_enabled) => {
        const { parseManagedConfiguration } = await import('./managedConfiguration');
        expect(parseManagedConfiguration({ analytics_enabled })).toEqual({});
    });

    it('accepts true but ignores unknown and incorrectly cased keys', async () => {
        const { parseManagedConfiguration } = await import('./managedConfiguration');
        expect(parseManagedConfiguration({ analytics_enabled: true, Server_URL: 'https://relay.example', telemetry_enabled: false }))
            .toEqual({ analyticsEnabled: true });
    });
});
