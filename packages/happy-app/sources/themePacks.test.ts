import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
}));

import { appThemes, resolveDesktopThemeName, resolveThemeName, THEME_PACK_IDS } from './themePacks';
import { desktopNavigationBackground, desktopSkinBackgroundPosition } from './desktopSkin';

function relativeLuminance(color: string): number {
    const [red, green, blue] = color
        .slice(1)
        .match(/.{2}/g)!
        .map((channel) => Number.parseInt(channel, 16) / 255)
        .map((channel) => (
            channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4
        ));
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(first: string, second: string): number {
    const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
        .sort((left, right) => right - left);
    return (lighter + 0.05) / (darker + 0.05);
}

function blendReadingSurface(surface: string, imageColor: '#000000' | '#FFFFFF'): string {
    const match = surface.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
    if (!match) throw new Error(`Expected a translucent reading surface: ${surface}`);
    const alpha = Number(match[4]);
    const imageChannel = imageColor === '#FFFFFF' ? 255 : 0;
    return `#${[1, 2, 3].map((index) => Math.round(Number(match[index]) * alpha + imageChannel * (1 - alpha))
        .toString(16).padStart(2, '0')).join('')}`;
}

describe('theme pack interactive surfaces', () => {
    it('keeps the seven public-share packs separate from the PC-only skin', () => {
        expect(THEME_PACK_IDS).toEqual([
            'caramel', 'gingham', 'terminal', 'acorn', 'sage', 'sakura', 'grape',
        ]);
        expect(Object.keys(appThemes)).toEqual([
            'caramelLight', 'caramelDark',
            'ginghamLight', 'ginghamDark',
            'terminalLight', 'terminalDark',
            'acornLight', 'acornDark',
            'sageLight', 'sageDark',
            'sakuraLight', 'sakuraDark',
            'grapeLight', 'grapeDark',
            'dreamskinDark',
            'warmNightDark',
            'wukongDark',
            'fireflyLight',
            'evaWarmLight',
            'meadowSkyDark',
        ]);
        expect(resolveThemeName('gingham', false)).toBe('ginghamLight');
        expect(resolveThemeName('gingham', true)).toBe('ginghamDark');
    });

    it('uses gingham dark surfaces for pressed and selected states', () => {
        const theme = appThemes.ginghamDark;

        expect(theme.colors.surfacePressed).toBe('#1F2A38');
        expect(theme.colors.surfaceSelected).toBe('#283544');
    });

    it('keeps destructive button text readable in gingham dark', () => {
        const { background, backgroundPressed, tint } = appThemes.ginghamDark.colors.button.destructive;

        expect(background).toBe('#FF8A80');
        expect(backgroundPressed).toBe('#E05A52');
        expect(contrastRatio(background, tint)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(backgroundPressed, tint)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('DreamSkin desktop theme', () => {
    it('opens the outer navigation background only for a normal-transparency PC workspace', () => {
        expect(desktopNavigationBackground('#131313', 'dreamskin', 'web', 1200, false)).toBe('transparent');
        expect(desktopNavigationBackground('#131313', 'dreamskin', 'web', 799, false)).toBe('#131313');
        expect(desktopNavigationBackground('#131313', 'dreamskin', 'ios', 1200, false)).toBe('#131313');
        expect(desktopNavigationBackground('#131313', 'dreamskin', 'web', 1200, true)).toBe('#131313');
        expect(desktopNavigationBackground('#17151A', 'warmNight', 'web', 1200, false)).toBe('transparent');
    });
    it('uses the independent dark skin only on Web and restores the saved theme otherwise', () => {
        expect(resolveDesktopThemeName('gingham', false, 'dreamskin', 'web', 1200)).toBe('dreamskinDark');
        expect(resolveDesktopThemeName('gingham', false, 'default', 'web', 1200)).toBe('ginghamLight');
        expect(resolveDesktopThemeName('gingham', true, 'dreamskin', 'ios', 1200)).toBe('ginghamDark');
        expect(resolveDesktopThemeName('gingham', false, 'dreamskin', 'web', 799)).toBe('ginghamLight');
        expect(resolveDesktopThemeName('gingham', false, 'dreamskin', 'web', 1200, '/share/public-id')).toBe('ginghamLight');
        expect(resolveDesktopThemeName('gingham', false, 'warmNight', 'web', 1200)).toBe('warmNightDark');
        expect(resolveDesktopThemeName('gingham', false, 'warmNight', 'web', 799)).toBe('ginghamLight');
        expect(resolveDesktopThemeName('gingham', false, 'warmNight', 'web', 1200, '/share/public-id')).toBe('ginghamLight');
    });

    it('maps interactive surfaces to the DreamSkin palette', () => {
        const colors = appThemes.dreamskinDark.colors;
        expect(colors.groupped.background).toBe('#131313');
        expect(colors.surface).toBe('#2A2A2A');
        expect(colors.surfacePressed).toBe('#343A41');
        expect(colors.surfaceSelected).toBe('#404A55');
        expect(contrastRatio(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
        expect(colors.desktopSkin.rail).toMatch(/^rgba\(/);
        expect(colors.desktopSkin.sidebar).toMatch(/^rgba\(/);
        expect(colors.modal.backdrop).toBe('rgba(0, 0, 0, 0.66)');
    });
    it('maps the second photo skin to warm interactive surfaces', () => {
        const colors = appThemes.warmNightDark.colors;
        expect(colors.groupped.background).toBe('#17151A');
        expect(colors.surface).toBe('#221F24');
        expect(colors.surfacePressed).toBe('#302B30');
        expect(colors.surfaceSelected).toBe('#3D363C');
        expect(colors.accent).toBe('#B98864');
        expect(contrastRatio(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
        expect(colors.desktopSkin.sidebar).toMatch(/^rgba\(/);
    });
    it('registers all four imported skins with their source light or dark appearance', () => {
        const names = [
            ['wukong', 'wukongDark'],
            ['firefly', 'fireflyLight'],
            ['evaWarm', 'evaWarmLight'],
            ['meadowSky', 'meadowSkyDark'],
        ] as const;
        for (const [skin, name] of names) {
            expect(resolveDesktopThemeName('gingham', false, skin, 'web', 1200)).toBe(name);
            const colors = appThemes[name].colors;
            expect(contrastRatio(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
            expect(colors.surfacePressed).not.toBe(colors.surface);
            expect(colors.surfaceSelected).not.toBe(colors.surfacePressed);
            expect(colors.desktopSkin.sidebar).toMatch(/^rgba\(/);
            const worstImage = name.endsWith('Dark') ? '#FFFFFF' : '#000000';
            expect(contrastRatio(colors.text, blendReadingSurface(colors.desktopSkin.readingWide, worstImage))).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(colors.text, blendReadingSurface(colors.desktopSkin.sidebar, worstImage))).toBeGreaterThanOrEqual(4.5);
            for (const surface of [colors.surface, colors.surfacePressed, colors.surfaceSelected,
                blendReadingSurface(colors.desktopSkin.readingWide, worstImage),
                blendReadingSurface(colors.desktopSkin.sidebar, worstImage)]) {
                expect(contrastRatio(colors.textSecondary, surface)).toBeGreaterThanOrEqual(4.5);
            }
            expect(contrastRatio(colors.textLink, colors.surface)).toBeGreaterThanOrEqual(4.5);
            expect(resolveDesktopThemeName('gingham', false, skin, 'ios', 1200)).toBe('ginghamLight');
        }
        expect(appThemes.fireflyLight.colors.text).toBe('#263B42');
        expect(appThemes.evaWarmLight.colors.text).toBe('#3D3A33');
        expect(desktopSkinBackgroundPosition('wukong')).toBe('0% 50%');
        expect(desktopSkinBackgroundPosition('firefly')).toBe('8% 50%');
        expect(desktopSkinBackgroundPosition('dreamskin')).toBe('50% 50%');
    });
});
