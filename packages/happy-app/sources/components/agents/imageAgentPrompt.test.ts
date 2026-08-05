import { describe, expect, it } from 'vitest';
import {
    IMAGE_AGENT_STYLE_PRESETS,
    buildImageAgentPrompt,
    createUserImageStylePreset,
    getImageAgentStyleOptionsForAgent,
    getImageAgentStylesForAgent,
    shouldUseUserImageStyleReferenceImages,
} from './imageAgentPrompt';
import { createImageStyleSelectionPrompt } from './imageAgentMode';
import type { AgentLauncher } from './launchAgent';

const agent: AgentLauncher = {
    id: 'img1',
    name: 'Tiramisu Lab',
    glyph: 'T',
    color: '#8B5E3C',
    machineId: 'm1',
    path: '~/work',
    kind: 'image-styles',
    spaceType: 'default',
    imageStyleIds: ['premium-studio', 'white-product'],
    imageVariantsPerStyle: 2,
    presets: [],
};

describe('imageAgentPrompt', () => {
    it('resolves legacy GPT Image 2 style ids to Garden case styles for saved agents', () => {
        const styles = getImageAgentStylesForAgent(agent);

        expect(styles).toHaveLength(2);
        expect(styles[0].templateRef).toBe('product-visuals/premium-studio-product.md');
        expect(styles[1].templateRef).toBe('product-visuals/white-background-product.md');
        expect(styles.map((style) => style.promptContent ?? '').every((prompt) => prompt.length > 200)).toBe(true);
    });

    it('builds a composer prompt from the selected Garden case prompt', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'product-visuals/white-background-product/1');
        expect(style).toBeTruthy();

        const prompt = createImageStyleSelectionPrompt(style!);

        expect(prompt).toContain('使用 $gpt-image-2 skill');
        expect(prompt).toContain('已选择的 Garden 案例：product-visuals/white-background-product/1');
        expect(prompt).toContain(`风格说明：${style!.promptHint}`);
        expect(prompt).not.toContain(style!.promptContent.slice(0, 120));
        expect(prompt).not.toContain('"typography"');
    });

    it('includes curated reference article styles without local Obsidian labels', () => {
        const mountainStyle = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'reference-voxcat/wild-mountain-sketchbook/1');
        const graphiteCyanStyle = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'reference-graphite-cyan/dark-urban-grade/1');
        const tiramisuStyle = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'reference-tiramisu/vintage-film-cafe/1');
        const dogStyle = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'reference-dog/healing-watercolor/1');

        expect(mountainStyle?.sourceRepository).toBe('curated-reference-examples');
        expect(mountainStyle?.promptPath).toContain('voxcat-wild-mountain-sketchbook');
        expect(mountainStyle?.promptContent).toContain('outdoor travel sketchbook');
        expect(mountainStyle?.templateRef).not.toContain('local-obsidian');
        expect(mountainStyle?.promptHint).not.toMatch(/OBA|Obsidian/i);
        expect(graphiteCyanStyle?.sourceRepository).toBe('curated-reference-examples');
        expect(graphiteCyanStyle?.promptPath).toContain('graphite-cyan-dark-tone');
        expect(graphiteCyanStyle?.promptContent).toContain('低饱和石墨灰青色');
        expect(graphiteCyanStyle?.promptContent).toContain('不会压成死黑');
        expect(graphiteCyanStyle?.templateRef).not.toContain('local-obsidian');
        expect(tiramisuStyle?.sourceRepository).toBe('curated-reference-examples');
        expect(tiramisuStyle?.promptPath).toContain('tiramisu-vintage-film-cafe');
        expect(tiramisuStyle?.promptContent).toContain('nostalgic 35mm film');
        expect(tiramisuStyle?.templateRef).not.toContain('local-obsidian');
        expect(tiramisuStyle?.promptHint).not.toMatch(/OBA|Obsidian/i);
        expect(dogStyle?.sourceRepository).toBe('curated-reference-examples');
        expect(dogStyle?.promptPath).toContain('dog-healing-watercolor');
        expect(dogStyle?.promptContent).toContain('cream-colored curly dog');
        expect(dogStyle?.templateRef).not.toContain('local-obsidian');
        expect(dogStyle?.promptHint).not.toMatch(/OBA|Obsidian/i);
    });

    it('resolves legacy reference ids to the renamed reference styles for saved agents', () => {
        const styles = getImageAgentStylesForAgent({
            ...agent,
            imageStyleIds: ['oba-tiramisu/vintage-film-cafe/1', 'oba-dog/healing-watercolor/1'],
        });

        expect(styles.map((style) => style.id)).toEqual([
            'reference-tiramisu/vintage-film-cafe/1',
            'reference-dog/healing-watercolor/1',
        ]);
    });

    it('builds a locked multi-image GPT Image 2 batch prompt', () => {
        const prompt = buildImageAgentPrompt({
            agent,
            userPrompt: '使用乳制品参考照片，并保留盘子的形状。',
            imageCount: 3,
        });

        expect(prompt).toContain('$gpt-image-2');
        expect(prompt).toContain('生成锁');
        expect(prompt).toContain('已上传 3 张参考图');
        expect(prompt).toContain('product-visuals/premium-studio-product/1');
        expect(prompt).toContain('product-visuals/white-background-product/1');
        expect(prompt).toContain('各生成 2 张变体');
        expect(prompt).toContain('garden-gpt-image-2/image/');
        expect(prompt).toContain('mcp__happy__send_image');
        expect(prompt).toContain('完整 prompt 和 batchId');
        expect(prompt).toContain('~/.codex/generated_images/<任务 id>/');
        expect(prompt).toContain('不要在未检查该目录前声称');
        expect(prompt).toContain('使用乳制品参考照片，并保留盘子的形状。');
    });

    it('optimizes only reference transport before the first native image request', () => {
        const prompt = buildImageAgentPrompt({
            agent,
            userPrompt: '保留完整风格和主体细节。',
            imageCount: 6,
            styleReferenceImageCount: 3,
            userImageCount: 3,
        });

        expect(prompt).toContain('首次请求优化');
        expect(prompt).toContain('第一次调用 native image_gen 前');
        expect(prompt).toContain('1024–1536px');
        expect(prompt).toContain('风格、身份、文字、产品细节等敏感参考图使用 1536px');
        expect(prompt).toContain('不要放大小于目标尺寸的原图');
        expect(prompt).toContain('只合并风格参考图');
        expect(prompt).toContain('连续等待 8 分钟');
        expect(prompt).toContain('同一个 batchId 内重试一次');
        expect(prompt).toContain('不得减少参考信息、缩短风格分析、简化完整 prompt 或降低最终生成质量');
    });

    it('puts user styles above built-in gallery styles and uses reference images until prompt extraction is ready', () => {
        const customStyles = [{
            id: 'user-reference/u1',
            title: '山野速写',
            promptHint: '用户参考照片风格：山野速写。',
            tags: [],
            analysisStatus: 'reference-ready' as const,
            promptSource: 'reference-image' as const,
            createdAt: 1,
            updatedAt: 1,
            referenceImages: [{
                id: 'r1',
                uri: 'file:///style.jpg',
                width: 800,
                height: 1000,
                mimeType: 'image/jpeg',
                size: 123,
                name: 'style.jpg',
            }],
        }];

        const options = getImageAgentStyleOptionsForAgent(agent, customStyles);
        expect(options[0]).toMatchObject({
            id: 'user-reference/u1',
            title: '山野速写',
            sourceRepository: 'user-reference',
            custom: true,
        });

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['user-reference/u1'] },
            customStyles,
            userPrompt: '套到产品图上。',
            imageCount: 2,
            styleReferenceImageCount: 1,
            userImageCount: 1,
        });

        expect(options[0].templateLabel).toBe('Reference Ready');
        expect(prompt).toContain('前 1 张是自定义风格的临时参考图');
        expect(prompt).toContain('后 1 张是本次用户素材');
        expect(prompt).toContain('user-reference/photo-style');
        expect(prompt).toContain('山野速写');
    });

    it('uses extracted prompts for prompt-ready user styles without requiring saved reference images', () => {
        const customStyles = [{
            id: 'user-reference/u2',
            title: '低饱和胶片',
            promptHint: '用户参考照片风格：低饱和胶片。',
            promptContent: '低饱和暖色胶片、柔和窗光、轻微颗粒、自然阴影。',
            negativePrompt: '过曝，高锐化',
            tags: ['film', 'warm'],
            analysisStatus: 'prompt-ready' as const,
            promptSource: 'extracted-prompt' as const,
            referenceImages: [],
            createdAt: 1,
            updatedAt: 2,
        }];

        const options = getImageAgentStyleOptionsForAgent(agent, customStyles);
        expect(options[0]).toMatchObject({
            id: 'user-reference/u2',
            templateLabel: 'Prompt Ready',
            referenceImages: [],
        });

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['user-reference/u2'] },
            customStyles,
            userPrompt: '套到产品图上。',
            imageCount: 1,
            styleReferenceImageCount: 0,
            userImageCount: 1,
        });

        expect(prompt).toContain('低饱和暖色胶片');
        expect(prompt).toContain('避免：过曝，高锐化');
        expect(prompt).not.toContain('临时参考图');
    });

    it('keeps reference images on the preset for the gallery thumbnail even after the prompt is extracted', () => {
        // Regression: a prompt-ready style with saved reference images must still
        // expose them so the gallery card renders its thumbnail. The SEND decision
        // (use extracted prompt, not attachments) is made separately via
        // shouldUseUserImageStyleReferenceImages and must stay unaffected.
        const referenceImages = [{
            id: 'r1',
            uri: 'file:///ref.jpg',
            width: 800,
            height: 1000,
            mimeType: 'image/jpeg',
            size: 123,
            name: 'ref.jpg',
        }];
        const style = {
            id: 'user-reference/u3',
            title: '胶片风',
            promptHint: '用户参考照片风格：胶片风。',
            promptContent: '柔和逆光、巨幅圆形散景、通透胶片色彩。',
            tags: [],
            analysisStatus: 'prompt-ready' as const,
            promptSource: 'extracted-prompt' as const,
            referenceImages,
            createdAt: 1,
            updatedAt: 2,
        };

        // Display: preset carries the reference images for the thumbnail.
        const preset = createUserImageStylePreset(style);
        expect(preset.referenceImages).toHaveLength(1);
        expect(preset.referenceImages?.[0].uri).toBe('file:///ref.jpg');

        // Send: still gated off once a prompt is extracted (uses the text prompt).
        expect(shouldUseUserImageStyleReferenceImages(style)).toBe(false);
    });

    it('keeps generated images visible without asking the agent to print path checklists', () => {
        const prompt = buildImageAgentPrompt({
            agent,
            userPrompt: '生成漫画头像。',
            imageCount: 1,
        });

        expect(prompt).toContain('最终回复');
        expect(prompt).toContain('不要输出 prompt 文件路径、图片文件路径或清单');
        expect(prompt).not.toContain('结束时给出一份简洁清单');
    });

    it('asks the image agent to include encoded Gallery continuation options', () => {
        const prompt = buildImageAgentPrompt({
            agent,
            userPrompt: '生成漫画头像。',
            imageCount: 1,
        });

        expect(prompt).toContain('<options>');
        expect(prompt).toContain('[[gpt-image-style:');
        expect(prompt).toContain('客户端会把它们渲染成可多选风格推荐');
    });
});
