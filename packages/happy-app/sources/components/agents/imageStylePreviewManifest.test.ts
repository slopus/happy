import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE_EFFECTS_CATALOG_SNAPSHOT } from './imageEffectsCatalogAdapter';
import { IMAGE_AGENT_STYLE_PRESETS } from './imageAgentPrompt';
import { IMAGE_STYLE_PREVIEW_MANIFEST } from './imageStylePreviewManifest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const previewAssetDir = resolve(currentDir, '../../../assets/images/image-effects');
const previewAssetModulePath = resolve(currentDir, 'imageStylePreviewAssets.ts');
const IMAGE_STYLE_COUNT = IMAGE_EFFECTS_CATALOG_SNAPSHOT.effects.length;
const IMAGE_STYLE_CATEGORY_COUNT = new Set(
    IMAGE_EFFECTS_CATALOG_SNAPSHOT.effects.map((effect) => effect.category),
).size;

function decodeImageDimensions(bytes: Buffer): { width: number; height: number } {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) { offset += 1; continue; }
            const marker = bytes[offset + 1];
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
            }
            if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
            offset += 2 + bytes.readUInt16BE(offset + 2);
        }
    }
    throw new Error('Preview is not a decodable JPEG or PNG');
}

describe('imageStylePreviewManifest', () => {
    it('uses Metro-resolvable relative paths for every bundled preview', () => {
        const source = readFileSync(previewAssetModulePath, 'utf8');
        const assetSpecifiers = [...source.matchAll(/require\('([^']+)'\)/g)]
            .map((match) => match[1]);

        expect(assetSpecifiers).toHaveLength(IMAGE_STYLE_COUNT);
        for (const specifier of assetSpecifiers) {
            expect(specifier.startsWith('../../../assets/images/image-effects/')).toBe(true);
            expect(existsSync(resolve(currentDir, specifier))).toBe(true);
        }
    });

    it('defines one bundled preview asset for every canonical image effect', () => {
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
        expect(sourceSets).toEqual({ 'image-effects-snapshot': IMAGE_STYLE_COUNT });

        const sourceCaseIds = Object.values(IMAGE_STYLE_PREVIEW_MANIFEST).map((preview) => preview.sourceCaseId);
        expect(new Set(sourceCaseIds).size).toBe(sourceCaseIds.length);
        const sourceIndices = Object.values(IMAGE_STYLE_PREVIEW_MANIFEST).map((preview) => preview.sourceIndex);
        expect(new Set(sourceIndices).size).toBe(sourceIndices.length);

        for (const style of IMAGE_AGENT_STYLE_PRESETS) {
            const preview = IMAGE_STYLE_PREVIEW_MANIFEST[style.id];
            expect(style.promptContent.length).toBeGreaterThan(200);
            expect(style.title.length).toBeGreaterThan(0);
            expect(style.templateRef).toMatch(/^image-effects\/.+@\d+\.\d+\.\d+$/);
            expect(preview.width).toBeGreaterThan(0);
            expect(preview.height).toBeGreaterThan(0);
            const previewPath = resolve(previewAssetDir, preview.fileName);
            expect(existsSync(previewPath)).toBe(true);
            const bytes = readFileSync(previewPath);
            expect(decodeImageDimensions(bytes)).toEqual({ width: preview.width, height: preview.height });
            expect(bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
            expect(bytes.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))).toBe(false);
            for (const marker of ['eXIf', 'iTXt', 'tEXt', 'zTXt']) {
                expect(bytes.includes(Buffer.from(marker))).toBe(false);
            }
        }
    });
});
