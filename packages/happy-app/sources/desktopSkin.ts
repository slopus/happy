import type { AccentMode } from './themePacksData';
import { WEB_TABLET_MIN_WIDTH } from './utils/deviceCalculations';
import reviewedTokens from './desktopSkinTokens.json';

export type DesktopSkinId = 'default' | 'dreamskin' | 'warmNight';
export const DREAMSKIN_BACKGROUND_URL = '/desktop-skins/dreamskin/background.c3c07e0cc5cb266a.webp';
export const WARM_NIGHT_BACKGROUND_URL = '/desktop-skins/warm-night/background.ae8eb2f7656ee63b.webp';

// DreamSkin cecilylove002 supplies the palette. Paws supplies the interaction
// states that the source package does not define.
export const DREAMSKIN_ACCENT: AccentMode = reviewedTokens;

export const WARM_NIGHT_ACCENT: AccentMode = {
    primary: '#B98864', primaryPressed: '#A77755', onPrimary: '#17151A', link: '#A9C9E7',
    bg: '#17151A', surface: '#221F24', surfaceHigh: '#302B30', surfaceHighest: '#3D363C',
    text: '#F5EFE8', textSecondary: '#C7BBAF', particleA: '#B98864', particleB: '#6489B2',
};

export const isPhotoDesktopSkin = (skin: DesktopSkinId): skin is Exclude<DesktopSkinId, 'default'> => skin !== 'default';

export function desktopSkinBackgroundUrl(skin: DesktopSkinId): string | null {
    if (skin === 'dreamskin') return DREAMSKIN_BACKGROUND_URL;
    if (skin === 'warmNight') return WARM_NIGHT_BACKGROUND_URL;
    return null;
}

export function isPhotoSkinActive(skin: DesktopSkinId, platform: string, viewportWidth: number, pathname = ''): boolean {
    return isPhotoDesktopSkin(skin) && platform === 'web' && viewportWidth >= WEB_TABLET_MIN_WIDTH
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
    return !reducedTransparency && isPhotoSkinActive(skin, platform, viewportWidth)
        ? 'transparent'
        : fallback;
}
