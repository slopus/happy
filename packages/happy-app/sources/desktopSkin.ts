import type { AccentMode } from './themePacksData';
import { WEB_TABLET_MIN_WIDTH } from './utils/deviceCalculations';
import reviewedTokens from './desktopSkinTokens.json';
import { importedDesktopSkins } from './importedDesktopSkins.generated';

export const DREAMSKIN_BACKGROUND_URL = '/desktop-skins/dreamskin/background.c3c07e0cc5cb266a.webp';
export const WARM_NIGHT_BACKGROUND_URL = '/desktop-skins/warm-night/background.ae8eb2f7656ee63b.webp';
export const DREAMSKIN_ACCENT: AccentMode = reviewedTokens;
export const WARM_NIGHT_ACCENT: AccentMode = {
    primary: '#B98864', primaryPressed: '#A77755', onPrimary: '#17151A', link: '#A9C9E7',
    bg: '#17151A', surface: '#221F24', surfaceHigh: '#302B30', surfaceHighest: '#3D363C',
    text: '#F5EFE8', textSecondary: '#C7BBAF', particleA: '#B98864', particleB: '#6489B2',
};

type Rgb = [number, number, number];
function rgb(color: string): Rgb {
    if (/^#[0-9a-f]{6}$/i.test(color)) return [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16)) as Rgb;
    const match = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i);
    if (!match) throw new Error(`Unsupported imported skin color: ${color}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
const hex = (color: string) => `#${rgb(color).map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const rgba = (color: string, alpha: number) => `rgba(${rgb(color).join(',')},${alpha})`;
function mix(first: string, second: string, amount: number): string {
    const a = rgb(first), b = rgb(second);
    return `#${a.map((value, index) => Math.round(value * (1 - amount) + b[index] * amount).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
function luminance(color: string): number {
    const [r, g, b] = rgb(color).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(first: string, second: string): number {
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
}

// DreamSkin's CSS selectors do not exist in Paws. Map the verified source
// tokens to Paws surfaces and give light skins genuinely light reading glass.
function importedPalette(source: typeof importedDesktopSkins[number]) {
    const light = source.appearance === 'light';
    const colors = source.colors;
    const surface = hex(light && colors.panel.startsWith('rgba(') ? colors.panelAlt : colors.panel);
    const background = hex(colors.background.startsWith('rgba(') ? colors.panelAlt : colors.background);
    const text = hex(colors.text);
    const secondary = hex(colors.muted);
    let subdued = contrast(secondary, surface) > contrast(text, surface) ? mix(text, surface, 0.35) : secondary;
    const high = light ? mix(surface, text, 0.055) : hex(colors.panelAlt);
    const highest = mix(high, text, light ? 0.09 : 0.11);
    const primary = hex(colors.accent);
    const onPrimary = contrast(primary, '#111111') >= contrast(primary, '#FFFFFF') ? '#111111' : '#FFFFFF';
    let link = hex(colors.secondary);
    for (let step = 0; step < 8 && contrast(link, surface) < 4.5; step++) link = mix(link, light ? '#172A32' : '#FFFFFF', 0.16);
    const desktopSkin = {
        frame: 'transparent', border: rgba(text, light ? 0.17 : 0.15),
        rail: rgba(surface, light ? 0.94 : 0.92), sidebar: rgba(surface, light ? 0.85 : 0.82),
        reducedFrame: background, reducedRail: surface, reducedSidebar: surface,
        canvas: background, readingSolid: surface,
        readingHidden: rgba(surface, 0.96), readingCompact: rgba(surface, light ? 0.86 : 0.81),
        readingWide: rgba(surface, light ? 0.75 : 0.72),
    };
    const worstBackdrop = light ? '#000000' : '#FFFFFF';
    const secondarySurfaces = [surface, high, highest,
        mix(surface, worstBackdrop, light ? 0.25 : 0.28),
        mix(surface, worstBackdrop, light ? 0.15 : 0.18)];
    for (let step = 0; step < 24 && secondarySurfaces.some((target) => contrast(subdued, target) < 4.5); step++) {
        subdued = mix(subdued, text, 0.18);
    }
    const accent: AccentMode = {
        primary, primaryPressed: mix(primary, light ? text : surface, 0.16), onPrimary, link,
        bg: background, surface, surfaceHigh: high, surfaceHighest: highest,
        text, textSecondary: subdued, particleA: primary, particleB: hex(colors.secondary),
    };
    return {
        ...source, themeName: `${source.id}${light ? 'Light' : 'Dark'}` as `${typeof source.id}${'Light' | 'Dark'}`, accent, desktopSkin,
        divider: hex(colors.line), headerBackground: surface,
        modalBackdrop: light ? 'rgba(18, 25, 28, 0.38)' : 'rgba(0, 0, 0, 0.68)',
        photoFallback: 'none',
        photoScrim: light
            ? 'linear-gradient(90deg, rgba(255,255,255,.15) 0%, rgba(255,255,255,.09) 50%, rgba(255,255,255,.05) 100%)'
            : `linear-gradient(90deg, ${rgba(background, 0.74)} 0%, ${rgba(background, 0.65)} 55%, ${rgba(background, 0.42)} 100%)`,
        photoOpacity: light ? 0.98 : 0.92,
    };
}

const reviewedSkins = [
    {
        id: 'dreamskin', assetId: 'dreamskin', name: 'Cozy interior', appearance: 'dark',
        themeName: 'dreamskinDark', backgroundUrl: DREAMSKIN_BACKGROUND_URL, accent: DREAMSKIN_ACCENT,
        desktopSkin: {
            frame: 'transparent', border: 'rgba(255, 255, 255, 0.12)',
            rail: 'rgba(16, 20, 25, 0.90)', sidebar: 'rgba(24, 29, 36, 0.78)',
            reducedFrame: '#171C23', reducedRail: '#101419', reducedSidebar: '#181D24',
            canvas: '#13171D', readingSolid: '#151A21', readingHidden: 'rgba(21,26,33,0.92)',
            readingCompact: 'rgba(21,26,33,0.70)', readingWide: 'rgba(21,26,33,0.51)',
        },
        divider: '#3F3F3F', headerBackground: '#1D2024', modalBackdrop: 'rgba(0, 0, 0, 0.66)',
        photoFallback: 'linear-gradient(135deg, #151B22, #1D252E)',
        photoScrim: 'linear-gradient(90deg, rgba(13,17,23,.50) 0%, rgba(13,17,23,.34) 51%, rgba(13,17,23,.10) 100%)', photoOpacity: 0.88,
    },
    {
        id: 'warmNight', assetId: 'warm-night', name: 'Warm night by the window', appearance: 'dark',
        themeName: 'warmNightDark', backgroundUrl: WARM_NIGHT_BACKGROUND_URL, accent: WARM_NIGHT_ACCENT,
        desktopSkin: {
            frame: 'transparent', border: 'rgba(245, 239, 232, 0.14)',
            rail: 'rgba(23, 21, 26, 0.90)', sidebar: 'rgba(34, 31, 36, 0.78)',
            reducedFrame: '#17151A', reducedRail: '#17151A', reducedSidebar: '#221F24',
            canvas: '#17151A', readingSolid: '#221F24', readingHidden: 'rgba(34,31,36,0.94)',
            readingCompact: 'rgba(34,31,36,0.78)', readingWide: 'rgba(34,31,36,0.62)',
        },
        divider: '#514A4B', headerBackground: '#221F24', modalBackdrop: 'rgba(12, 10, 14, 0.70)',
        photoFallback: 'linear-gradient(135deg, #17151A, #302B30)',
        photoScrim: 'linear-gradient(90deg, rgba(23,21,26,.58) 0%, rgba(23,21,26,.43) 51%, rgba(23,21,26,.30) 100%)', photoOpacity: 0.88,
    },
] as const;

export const PHOTO_DESKTOP_SKINS = [...reviewedSkins, ...importedDesktopSkins.map(importedPalette)] as const;
export type DesktopSkinId = 'default' | typeof PHOTO_DESKTOP_SKINS[number]['id'];
export const DESKTOP_SKIN_IDS = ['default', ...PHOTO_DESKTOP_SKINS.map((skin) => skin.id)] as [DesktopSkinId, ...DesktopSkinId[]];
export const isPhotoDesktopSkin = (skin: DesktopSkinId): skin is Exclude<DesktopSkinId, 'default'> => skin !== 'default';
export const photoDesktopSkin = (skin: DesktopSkinId) => PHOTO_DESKTOP_SKINS.find((item) => item.id === skin);
export const isPhotoDesktopTheme = (themeName: string) => PHOTO_DESKTOP_SKINS.some((skin) => skin.themeName === themeName);
export function desktopSkinBackgroundUrl(skin: DesktopSkinId): string | null { return photoDesktopSkin(skin)?.backgroundUrl ?? null; }
export function desktopSkinBackgroundPosition(skin: DesktopSkinId): string {
    const visual = photoDesktopSkin(skin);
    const x = visual && 'focusX' in visual ? visual.focusX : 0.5;
    const y = visual && 'focusY' in visual ? visual.focusY : 0.5;
    return `${Math.round(x * 100)}% ${Math.round(y * 100)}%`;
}

export function isPhotoSkinActive(skin: DesktopSkinId, platform: string, viewportWidth: number, pathname = ''): boolean {
    return isPhotoDesktopSkin(skin) && platform === 'web' && viewportWidth >= WEB_TABLET_MIN_WIDTH
        && !pathname.startsWith('/share/');
}

/** Native-stack draws a navigation background outside each screen's contentStyle. */
export function desktopNavigationBackground(
    fallback: string, skin: DesktopSkinId, platform: string, viewportWidth: number, reducedTransparency: boolean,
): string {
    return !reducedTransparency && isPhotoSkinActive(skin, platform, viewportWidth) ? 'transparent' : fallback;
}
