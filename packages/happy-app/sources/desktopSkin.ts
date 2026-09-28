import type { AccentMode } from './themePacksData';
import { WEB_TABLET_MIN_WIDTH } from './utils/deviceCalculations';
import reviewedTokens from './desktopSkinTokens.json';

export type DesktopSkinId = 'default' | 'dreamskin';
export const DREAMSKIN_BACKGROUND_URL = '/desktop-skins/dreamskin/background.c3c07e0cc5cb266a.webp';

// DreamSkin cecilylove002 supplies the palette. Paws supplies the interaction
// states that the source package does not define.
export const DREAMSKIN_ACCENT: AccentMode = reviewedTokens;

export function isDreamSkinActive(skin: DesktopSkinId, platform: string, viewportWidth: number, pathname = ''): boolean {
    return skin === 'dreamskin' && platform === 'web' && viewportWidth >= WEB_TABLET_MIN_WIDTH
        && !pathname.startsWith('/share/');
}

/** Native-stack draws a navigation background outside each screen's contentStyle. */
export function desktopNavigationBackground(
    fallback: string,
    skin: DesktopSkinId,
    platform: string,
    viewportWidth: number,
    reducedTransparency: boolean,
): string {
    return !reducedTransparency && isDreamSkinActive(skin, platform, viewportWidth)
        ? 'transparent'
        : fallback;
}
