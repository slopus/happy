import { describe, expect, it } from 'vitest';

import {
    IMAGE_EFFECTS_CATALOG_SNAPSHOT,
    IMAGE_EFFECTS_LEGACY_ALIASES,
    IMAGE_EFFECTS_STYLE_CATEGORIES,
    IMAGE_EFFECTS_STYLE_PRESETS,
    resolveImageEffectsStyleId,
} from './imageEffectsCatalogAdapter';

describe('image-effects catalog snapshot adapter', () => {
    it('exposes the complete canonical executable snapshot', () => {
        const effectCount = IMAGE_EFFECTS_CATALOG_SNAPSHOT.effects.length;

        expect(IMAGE_EFFECTS_CATALOG_SNAPSHOT.schemaVersion).toBe(1);
        expect(effectCount).toBeGreaterThanOrEqual(94);
        expect(IMAGE_EFFECTS_STYLE_PRESETS).toHaveLength(effectCount);
        expect(new Set(IMAGE_EFFECTS_STYLE_PRESETS.map((style) => style.id)).size).toBe(effectCount);
        expect(IMAGE_EFFECTS_STYLE_CATEGORIES.reduce((sum, category) => sum + category.count, 0)).toBe(effectCount);
        expect(IMAGE_EFFECTS_STYLE_PRESETS.every((style) => style.promptContent.length > 200)).toBe(true);
    });

    it('keeps the previous executable catalog as compatibility aliases', () => {
        expect(Object.keys(IMAGE_EFFECTS_LEGACY_ALIASES)).toHaveLength(177);
        expect(resolveImageEffectsStyleId('academic-figures/graphical-abstract/2'))
            .toBe('image-effects/graphical-abstract@1.0.0');
        expect(resolveImageEffectsStyleId('github-skills/photo-illustration-diptych/3'))
            .toBe('image-effects/photo-illustration-editorial-echo@1.0.0');
        expect(resolveImageEffectsStyleId('reference-dog/anime-key-visual/1'))
            .toBe('image-effects/anime-key-visual@1.0.0');
    });

    it('does not publish color grades or the unlicensed mountain reference', () => {
        const serialized = JSON.stringify({
            effects: IMAGE_EFFECTS_CATALOG_SNAPSHOT.effects,
            aliases: IMAGE_EFFECTS_LEGACY_ALIASES,
        });
        expect(serialized).not.toContain('grade-images');
        expect(serialized).not.toContain('dark-urban-grade');
        expect(serialized).not.toContain('wild-mountain-sketchbook');
    });
});
