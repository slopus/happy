import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
}));

import { appThemes } from './themePacks';

describe('theme pack interactive surfaces', () => {
    it('uses gingham dark surfaces for pressed and selected states', () => {
        const theme = appThemes.ginghamDark;

        expect(theme.colors.surfacePressed).toBe('#1F2A38');
        expect(theme.colors.surfaceSelected).toBe('#283544');
    });
});
