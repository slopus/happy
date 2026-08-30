import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
}));

import { appThemes } from './themePacks';

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

describe('theme pack interactive surfaces', () => {
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
