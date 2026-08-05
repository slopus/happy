import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE_AGENT_STYLE_PRESETS } from './imageAgentPrompt';
import { IMAGE_STYLE_PREVIEW_MANIFEST } from './imageStylePreviewManifest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const previewAssetDir = resolve(currentDir, '../../assets/images/gpt-image-2/skill-examples');
const referencePreviewAssetDir = resolve(currentDir, '../../assets/images/gpt-image-2/reference-examples');
const IMAGE_STYLE_COUNT = 206;
const IMAGE_STYLE_CATEGORY_COUNT = 21;
const GARDEN_CASE_COUNT = 162;
const REFERENCE_CASE_COUNT = 44;

describe('imageStylePreviewManifest', () => {
    it('defines one real preview asset for every GPT Image 2 case style', () => {
        expect(IMAGE_AGENT_STYLE_PRESETS).toHaveLength(IMAGE_STYLE_COUNT);

        const styleIds = IMAGE_AGENT_STYLE_PRESETS.map((style) => style.id).sort();
        const previewStyleIds = Object.keys(IMAGE_STYLE_PREVIEW_MANIFEST).sort();
        const categoryIds = new Set(IMAGE_AGENT_STYLE_PRESETS.map((style) => style.categoryId));
        const sourceSets = Object.values(IMAGE_STYLE_PREVIEW_MANIFEST).reduce((counts, preview) => {
            counts[preview.sourceSet] = (counts[preview.sourceSet] ?? 0) + 1;
            return counts;
        }, {} as Record<string, number>);

        expect(previewStyleIds).toEqual(styleIds);
        expect(categoryIds.size).toBe(IMAGE_STYLE_CATEGORY_COUNT);
        expect(sourceSets['gpt-image-2-101']).toBe(GARDEN_CASE_COUNT);
        expect(sourceSets['curated-reference-examples']).toBe(REFERENCE_CASE_COUNT);

        for (const style of IMAGE_AGENT_STYLE_PRESETS) {
            const preview = IMAGE_STYLE_PREVIEW_MANIFEST[style.id];
            const sourceDir = preview.sourceSet === 'curated-reference-examples'
                ? referencePreviewAssetDir
                : previewAssetDir;

            expect(style.promptContent.length).toBeGreaterThan(200);
            expect(style.title.length).toBeGreaterThan(0);
            expect(style.templateRef).toMatch(/^.+\.md$/);
            expect(preview.width).toBeGreaterThan(0);
            expect(preview.height).toBeGreaterThan(0);
            expect(existsSync(resolve(sourceDir, preview.fileName))).toBe(true);
        }
    });
});
