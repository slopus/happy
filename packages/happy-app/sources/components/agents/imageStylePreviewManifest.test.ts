import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE_AGENT_STYLE_PRESETS } from './imageAgentPrompt';
import { IMAGE_STYLE_PREVIEW_MANIFEST } from './imageStylePreviewManifest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const previewAssetDir = resolve(currentDir, '../../assets/images/gpt-image-2/skill-examples');
const referencePreviewAssetDir = resolve(currentDir, '../../assets/images/gpt-image-2/reference-examples');
const IMAGE_STYLE_COUNT = 180;
const IMAGE_STYLE_CATEGORY_COUNT = 21;
const GARDEN_CASE_COUNT = 162;
const REFERENCE_CASE_COUNT = 9;
const GITHUB_SKILL_CASE_COUNT = 9;

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
        expect(sourceSets['github-skill']).toBe(GITHUB_SKILL_CASE_COUNT);

        const sourceCaseIds = Object.values(IMAGE_STYLE_PREVIEW_MANIFEST).map((preview) => preview.sourceCaseId);
        expect(new Set(sourceCaseIds).size).toBe(sourceCaseIds.length);
        const githubSourceIndices = Object.values(IMAGE_STYLE_PREVIEW_MANIFEST)
            .filter((preview) => preview.sourceSet === 'github-skill')
            .map((preview) => preview.sourceIndex);
        expect(new Set(githubSourceIndices).size).toBe(githubSourceIndices.length);

        for (const style of IMAGE_AGENT_STYLE_PRESETS) {
            const preview = IMAGE_STYLE_PREVIEW_MANIFEST[style.id];
            const sourceDir = preview.sourceSet === 'gpt-image-2-101'
                ? previewAssetDir
                : referencePreviewAssetDir;

            expect(style.promptContent.length).toBeGreaterThan(200);
            expect(style.title.length).toBeGreaterThan(0);
            expect(style.templateRef).toMatch(/^.+\.md$/);
            expect(preview.width).toBeGreaterThan(0);
            expect(preview.height).toBeGreaterThan(0);
            const previewPath = resolve(sourceDir, preview.fileName);
            expect(existsSync(previewPath)).toBe(true);
            const bytes = readFileSync(previewPath);
            expect(decodeImageDimensions(bytes)).toEqual({ width: preview.width, height: preview.height });
            if (preview.sourceSet === 'github-skill') {
                expect(bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
                expect(bytes.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))).toBe(false);
                for (const marker of ['eXIf', 'iTXt', 'tEXt', 'zTXt']) {
                    expect(bytes.includes(Buffer.from(marker))).toBe(false);
                }
                expect(bytes.includes(Buffer.from([0xff, 0xed]))).toBe(false);
            }
        }
    });
});
