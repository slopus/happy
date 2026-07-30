import { describe, expect, it } from 'vitest';
import * as glassPolicy from './glassInteractionPolicy';

describe('native GlassView interaction policy', () => {
    it('keeps native GlassView interaction disabled for both requested states', () => {
        expect(glassPolicy.getNativeGlassInteractivity(true)).toBe(false);
        expect(glassPolicy.getNativeGlassInteractivity(false)).toBe(false);
    });

    it('uses Expo-native settings menus across iPhone and iPad but not Mac, web, or Android', () => {
        const shouldUseExpoNativeSettingsMenu = (
            glassPolicy as typeof glassPolicy & {
                shouldUseExpoNativeSettingsMenu?: (platform: string, runningOnMac: boolean) => boolean;
            }
        ).shouldUseExpoNativeSettingsMenu;

        expect(shouldUseExpoNativeSettingsMenu?.('ios', false)).toBe(true);
        expect(shouldUseExpoNativeSettingsMenu?.('ios', true)).toBe(false);
        expect(shouldUseExpoNativeSettingsMenu?.('web', false)).toBe(false);
        expect(shouldUseExpoNativeSettingsMenu?.('android', false)).toBe(false);
    });
});
