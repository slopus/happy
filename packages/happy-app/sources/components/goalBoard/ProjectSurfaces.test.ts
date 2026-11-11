import { describe, expect, it, vi } from 'vitest';
import Color from 'color';
vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (value: Record<string, unknown>) => value.web ?? value.default } }));
import { appThemes } from '@/themePacks';
import { projectSurfaces } from './ProjectSurfaces';
describe('photo workspace theme surfaces', () => {
    it.each(['ginghamDark', 'dreamskinDark', 'fireflyLight'] as const)('preserves the current %s semantic hue and exposes the photo in every state', name => {
        const colors = appThemes[name].colors;
        const surfaces = projectSurfaces(colors);
        for (const [surface, source] of [[surfaces.surface, colors.surface], [surfaces.pressed, colors.surfacePressed], [surfaces.selected, colors.surfaceSelected]]) {
            expect(Color(surface).rgb().array().slice(0, 3)).toEqual(Color(source).rgb().array().slice(0, 3));
            expect(Color(surface).alpha()).toBeGreaterThan(0); expect(Color(surface).alpha()).toBeLessThan(1);
        }
        expect(Color(surfaces.selected).alpha()).toBeGreaterThan(Color(surfaces.surface).alpha());
    });
});
