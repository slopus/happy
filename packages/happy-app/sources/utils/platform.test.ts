import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock react-native Platform
vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        isPad: false,
        Version: '',
        select: (obj: any) => obj.default,
    },
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

describe('platform detection', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    describe('isTauri', () => {
        it('returns true when __TAURI_INTERNALS__ is defined on web', async () => {
            (global as any).window = { __TAURI_INTERNALS__: {} };

            const { isTauri } = await import('./platform');
            expect(isTauri()).toBe(true);

            delete (global as any).window.__TAURI_INTERNALS__;
        });

        it('returns false when __TAURI_INTERNALS__ is not defined', async () => {
            (global as any).window = {};

            const { isTauri } = await import('./platform');
            expect(isTauri()).toBe(false);
        });

        it('returns false on native platforms', async () => {
            const rn = await import('react-native');
            Object.defineProperty(rn.Platform, 'OS', { value: 'ios', configurable: true });
            (global as any).window = { __TAURI_INTERNALS__: {} };

            const { isTauri } = await import('./platform');
            expect(isTauri()).toBe(false);

            // Restore
            Object.defineProperty(rn.Platform, 'OS', { value: 'web', configurable: true });
            delete (global as any).window.__TAURI_INTERNALS__;
        });
    });

    describe('isDesktop', () => {
        it('returns true when isTauri() is true', async () => {
            (global as any).window = { __TAURI_INTERNALS__: {} };

            const { isDesktop } = await import('./platform');
            expect(isDesktop()).toBe(true);

            delete (global as any).window.__TAURI_INTERNALS__;
        });

        it('returns false for plain web without Tauri', async () => {
            (global as any).window = {};

            const { isDesktop } = await import('./platform');
            expect(isDesktop()).toBe(false);
        });
    });
});
