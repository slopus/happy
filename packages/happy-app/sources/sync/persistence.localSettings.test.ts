import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistence, loadDesktopSkinId, loadLocalSettings, saveLocalSettings } from './persistence';

afterEach(() => {
    vi.unstubAllEnvs();
    clearPersistence();
});

describe('device-local sidebar group expansion persistence', () => {
    it('round-trips project and List expansion states through MMKV-backed local settings', () => {
        const settings = loadLocalSettings();
        expect(settings.sidebarGroupExpansion).toEqual({});

        saveLocalSettings({
            ...settings,
            sidebarGroupExpansion: {
                'lists:unassigned': true,
                'lists:happy': true,
                'projects:mac--%2Frepo': false,
            },
        });

        expect(loadLocalSettings().sidebarGroupExpansion).toEqual({
            'lists:unassigned': true,
            'lists:happy': true,
            'projects:mac--%2Frepo': false,
        });
    });
});

describe('independent DreamSkin test build', () => {
    it('enables DreamSkin once for an existing account without discarding other local settings', () => {
        const settings = loadLocalSettings();
        saveLocalSettings({ ...settings, sidebarGroupExpansion: { 'lists:happy': true } });

        vi.stubEnv('EXPO_PUBLIC_DREAMSKIN_STAGING_DEFAULT', '1');
        expect(loadDesktopSkinId()).toBe('dreamskin');
        expect(loadLocalSettings().sidebarGroupExpansion).toEqual({ 'lists:happy': true });

        saveLocalSettings({ ...loadLocalSettings(), desktopSkinId: 'default' });
        expect(loadDesktopSkinId()).toBe('default');
    });

    it('uses DreamSkin for a fresh account in the test build, and leaves normal builds unchanged', () => {
        vi.stubEnv('EXPO_PUBLIC_DREAMSKIN_STAGING_DEFAULT', '1');
        expect(loadDesktopSkinId()).toBe('dreamskin');

        vi.unstubAllEnvs();
        clearPersistence();
        expect(loadDesktopSkinId()).toBe('default');
    });
});
