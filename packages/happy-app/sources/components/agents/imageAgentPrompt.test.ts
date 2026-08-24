import { describe, expect, it } from 'vitest';
import {
    IMAGE_AGENT_STYLE_CATEGORIES,
    IMAGE_AGENT_STYLE_PRESETS,
    buildImageAgentPrompt,
    canonicalizeImageAgentStyleIds,
    createUserImageStylePreset,
    getImageAgentStyleOptionsForAgent,
    getImageAgentStylesForAgent,
    shouldUseUserImageStyleReferenceImages,
} from './imageAgentPrompt';
import { createImageStyleSelectionPrompt } from './imageAgentMode';
import { IMAGE_EFFECTS_CATALOG_SNAPSHOT } from './imageEffectsCatalogAdapter';
import type { AgentLauncher } from './launchAgent';

const agent: AgentLauncher = {
    id: 'img1',
    name: 'Image Effects',
    glyph: 'I',
    color: '#315D86',
    machineId: 'm1',
    path: '~/work',
    kind: 'image-styles',
    spaceType: 'default',
    imageStyleIds: ['premium-studio', 'white-product'],
    imageVariantsPerStyle: 2,
    presets: [],
};

describe('imageAgentPrompt', () => {
    it('publishes the complete effect snapshot and resolves saved legacy ids', () => {
        const effectCount = IMAGE_EFFECTS_CATALOG_SNAPSHOT.effects.length;

        expect(effectCount).toBeGreaterThanOrEqual(94);
        expect(IMAGE_AGENT_STYLE_PRESETS).toHaveLength(effectCount);
        expect(IMAGE_AGENT_STYLE_CATEGORIES.slice(1).reduce((sum, category) => sum + category.count, 0)).toBe(effectCount);

        const styles = getImageAgentStylesForAgent(agent);
        expect(styles.map((style) => style.id)).toEqual([
            'image-effects/premium-studio-product@1.0.0',
            'image-effects/white-background-product@1.0.0',
        ]);
        expect(styles.every((style) => style.promptContent.length > 200)).toBe(true);
    });

    it('builds a compact composer prompt from a canonical image-effects style', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find(
            (preset) => preset.id === 'image-effects/white-background-product@1.0.0',
        );
        expect(style).toBeTruthy();

        const prompt = createImageStyleSelectionPrompt(style!);
        expect(prompt).toContain('使用 $gpt-image-2 skill');
        expect(prompt).toContain(style!.id);
        expect(prompt).toContain(`风格说明：${style!.promptHint}`);
        expect(prompt).not.toContain(style!.promptContent.slice(0, 120));
    });

    it('keeps independently sourced effects but excludes grades and the risky mountain reference', () => {
        const healing = IMAGE_AGENT_STYLE_PRESETS.find(
            (preset) => preset.id === 'image-effects/healing-anime-scribble-v3@1.0.0',
        );
        const torn = IMAGE_AGENT_STYLE_PRESETS.find(
            (preset) => preset.id === 'image-effects/torn-paper-editorial-photo-collage@1.0.0',
        );
        const serialized = JSON.stringify(IMAGE_AGENT_STYLE_PRESETS);

        expect(healing).toMatchObject({ inputMode: 'image-required', continuationSourceMode: 'original-upload' });
        expect(torn).toMatchObject({ inputMode: 'image-required', multiInputMode: 'single' });
        expect(serialized).not.toContain('grade-images');
        expect(serialized).not.toContain('dark-urban-grade');
        expect(serialized).not.toContain('wild-mountain-sketchbook');
    });

    it('resolves old dog and tiramisu buckets directly to canonical effect classes', () => {
        const ids = ['oba-tiramisu/vintage-film-cafe/1', 'oba-dog/healing-watercolor/1'];
        expect(getImageAgentStylesForAgent({ ...agent, imageStyleIds: ids }).map((style) => style.id)).toEqual([
            'image-effects/vintage-film-editorial@1.0.0',
            'image-effects/healing-scene@1.0.0',
        ]);
        expect(canonicalizeImageAgentStyleIds(ids)).toHaveLength(2);
        expect(IMAGE_AGENT_STYLE_CATEGORIES.some((category) => category.id === 'reference-dog')).toBe(false);
        expect(IMAGE_AGENT_STYLE_CATEGORIES.some((category) => category.id === 'reference-tiramisu')).toBe(false);
    });

    it('builds a locked source-by-style-by-variant batch using canonical ids', () => {
        const prompt = buildImageAgentPrompt({
            agent,
            userPrompt: '保留产品结构与材质。',
            imageCount: 3,
        });

        expect(prompt).toContain('源素材 3 张 × 风格 2 个 × 每风格变体 2 张 = 预计输出总数 12 张');
        expect(prompt).toContain('image-effects/premium-studio-product@1.0.0');
        expect(prompt).toContain('image-effects/white-background-product@1.0.0');
        expect(prompt).toContain('每完成 1 张就立即调用 mcp__happy__send_image');
        expect(prompt).toContain('~/.codex/generated_images/<任务 id>/');
    });

    it('requires an uploaded source before running image-only effects', () => {
        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['image-effects/background-replacement@1.0.0'] },
            userPrompt: '替换背景。',
            imageCount: 0,
        });
        expect(prompt).toContain('请先上传一张源照片');
        expect(prompt).toContain('不要启动生成式或确定性图片工具');
    });

    it('keeps first-request transport optimization without weakening output quality', () => {
        const prompt = buildImageAgentPrompt({
            agent,
            userPrompt: '保持细节。',
            imageCount: 6,
            styleReferenceImageCount: 3,
            userImageCount: 3,
        });
        expect(prompt).toContain('第一次调用 native image_gen 前');
        expect(prompt).toContain('1024–1536px');
        expect(prompt).toContain('连续等待 8 分钟');
        expect(prompt).toContain('同一个 batchId 内重试一次');
    });

    it('puts usable custom styles above the fixed built-in snapshot', () => {
        const customStyles = [{
            id: 'user-reference/u1',
            title: '山野速写',
            promptHint: '用户参考照片风格。',
            tags: [],
            analysisStatus: 'reference-ready' as const,
            promptSource: 'reference-image' as const,
            createdAt: 1,
            updatedAt: 1,
            referenceImages: [{
                id: 'r1', uri: 'file:///style.jpg', width: 800, height: 1000,
                mimeType: 'image/jpeg', size: 123, name: 'style.jpg',
            }],
        }];
        const options = getImageAgentStyleOptionsForAgent(agent, customStyles);
        expect(options[0]).toMatchObject({ id: 'user-reference/u1', custom: true });
        expect(options).toHaveLength(3);
    });

    it('uses extracted custom prompts without sending saved references again', () => {
        const style = {
            id: 'user-reference/u2',
            title: '低饱和胶片',
            promptHint: '低饱和胶片风格。',
            promptContent: '低饱和暖色胶片、柔和窗光、轻微颗粒、自然阴影。',
            negativePrompt: '过曝，高锐化',
            tags: ['film'],
            analysisStatus: 'prompt-ready' as const,
            promptSource: 'extracted-prompt' as const,
            referenceImages: [{
                id: 'r2', uri: 'file:///film.jpg', width: 800, height: 1000,
                mimeType: 'image/jpeg', size: 123, name: 'film.jpg',
            }],
            createdAt: 1,
            updatedAt: 2,
        };
        expect(shouldUseUserImageStyleReferenceImages(style)).toBe(false);
        expect(createUserImageStylePreset(style)).toMatchObject({
            templateLabel: 'Prompt Ready',
            referenceImages: style.referenceImages,
        });
    });

    it('falls back to the complete built-in snapshot only when no selected id resolves', () => {
        expect(getImageAgentStylesForAgent({ ...agent, imageStyleIds: ['unknown'] }))
            .toHaveLength(IMAGE_EFFECTS_CATALOG_SNAPSHOT.effects.length);
    });
});
