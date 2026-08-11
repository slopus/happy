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

    it('integrates the Torn Paper Editorial collage as a reusable single-photo style', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'reference-torn-paper-editorial/torn-paper-photo-collage/1');

        expect(style).toMatchObject({
            title: '撕纸编辑影像拼贴',
            categoryId: 'reference-torn-paper-editorial',
            sourceRepository: 'curated-reference-examples',
            templateRef: 'reference-examples/torn-paper-editorial-reference/torn-paper-editorial.md',
            promptPath: 'garden-gpt-image-2/prompt/torn-paper-editorial-v1.md',
            sourceCaseId: 'torn-paper-editorial-reference/01-close-portrait',
            executionKind: 'gpt-image-2',
            inputMode: 'image-required',
            multiInputMode: 'single',
        });
        expect(style?.promptContent).toContain('45% to 65% of the poster');
        expect(style?.promptContent).toContain('exposed white paper fibers');
        expect(style?.promptContent).toContain('black-and-white halftone');
        expect(style?.promptContent).toContain('cobalt blue, vermilion red, or coral');
        expect(style?.promptContent).toContain('tiny letter-spaced typewriter caption');
        expect(style?.promptContent).toContain('flat matte paper scan');
        expect(style?.promptContent).toContain('status bar, timestamp, watermark, logo');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: [style!.id] },
            userPrompt: '把上传的人像做成大面积撕纸编辑拼贴。',
            imageCount: 1,
        });

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('把上传的人像做成大面积撕纸编辑拼贴。');
        expect(prompt).toContain('mcp__happy__send_image');
        expect(prompt).toContain('Transform exactly one supplied source photo');

        const multiSourcePrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: [style!.id] },
            userPrompt: '分别做成撕纸编辑拼贴。',
            imageCount: 2,
        });
        expect(multiSourcePrompt).toContain('每个结果只能使用当前对应的 1 张用户素材作为源图片');
        expect(multiSourcePrompt).toContain('禁止把多张用户素材拼图、混合或共同输入同一次图片生成');
    });

    it('integrates the Minimal Zine Poster GitHub skill as a portable gallery style', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/minimal-zine-poster/1');
        expect(style).toMatchObject({
            title: 'Minimal Zine Paper Poster',
            categoryId: 'github-skills',
            sourceRepository: 'LiamGvchi/gc-minimal-zine-poster',
            sourceRevision: '4cb0396ad4e834019f753b37e1c4f415f5e02026',
            templateRef: 'skills/gc-minimal-zine-poster-v0-1/SKILL.md',
        });
        expect(style?.promptContent).toContain('70%-90% plain paper');
        expect(style?.promptContent).toContain('variation recipe');
        expect(style?.promptContent).toContain('high-chroma hue');
        expect(style?.sourceLicenseNotice).toContain('Copyright (c) 2026 LiamGvchi');
        expect(style?.sourceLicenseNotice).toContain('MIT License');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/minimal-zine-poster/1'] },
            userPrompt: '把上传的街景照片做成安静的黄昏纸张海报。',
            imageCount: 1,
        });

        expect(prompt).toContain('github-skills/minimal-zine-poster/1');
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Minimal Zine Poster v0.1 Standard Mode compiler');
        expect(prompt).toContain('把上传的街景照片做成安静的黄昏纸张海报。');
        expect(prompt).toContain('mcp__happy__send_image');
    });

    it('integrates the Photo–Illustration Diptych compiler with one-photo semantics', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/photo-illustration-diptych/1');
        expect(style).toMatchObject({
            title: 'Photo–Illustration Diptych',
            categoryId: 'github-skills',
            sourceRepository: 'wangjs-jacky/happy',
            sourceRevision: '532e49bb711283cbe2738439039298f9cea1ef7b',
            templateRef: 'skills/photo-illustration-diptych/SKILL.md',
            promptPath: 'garden-gpt-image-2/prompt/photo-illustration-diptych-v1.md',
            sourceCaseId: 'photo-illustration-diptych/user-reference-20260806',
            executionKind: 'gpt-image-2',
            inputMode: 'image-required',
            multiInputMode: 'single',
            continuationSourceMode: 'original-upload',
        });
        expect(style?.promptContent).toContain('Photo–Illustration Diptych v1 visual compiler');
        expect(style?.promptContent).toContain('build a Scene Map');
        expect(style?.promptContent).toContain('Simplify buildings, boats, paths, vehicles');
        expect(style?.promptContent).toContain('Compress foliage, water, crowds, clouds');
        expect(style?.promptContent).toContain('modern skyline or dusk city');
        expect(style?.promptContent).toContain('dramatic night architecture or castle-like forms');
        expect(style?.promptContent).toContain('Apply one uniform, isotropic scale factor');
        expect(style?.promptContent).toContain('Build one normalized, content-space Framing Map');
        expect(style?.promptContent).toContain('same-aspect-ratio content rectangle');
        expect(style?.promptContent).toContain('turning circles into ovals');
        expect(style?.promptContent).toContain('Default to a text-free poster');
        expect(style?.promptContent).toContain('regenerate at most once');
        expect(style?.sourceLicenseNotice).toContain('Happy Coder Contributors');
        expect(style?.responseInstructions).toContain("user's current conversation language");

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/1'] },
            userPrompt: '把上传的城市黄昏做成实景与几何插画上下对照海报。',
            imageCount: 1,
        });
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('把上传的城市黄昏做成实景与几何插画上下对照海报。');
        expect(prompt).toContain('Prefer breathing paper over distorted content');
        expect(prompt).toContain('share one Framing Map');
        expect(prompt).toContain('mcp__happy__send_image');
        expect(prompt).toContain('selected illustration medium');

        const missingInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/1'] },
            userPrompt: '做实景插画对照海报。',
            imageCount: 0,
        });
        expect(missingInputPrompt).toContain('请先上传一张源照片');

        const extraInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/1'] },
            userPrompt: '做实景插画对照海报。',
            imageCount: 2,
        });
        expect(extraInputPrompt).toContain('源素材 2 张 × 风格 1 个 × 每风格变体 2 张 = 预计输出总数 4 张');
        expect(extraInputPrompt).toContain('每个结果只能使用当前对应的 1 张用户素材作为源图片');
        expect(extraInputPrompt).toContain('禁止把多张用户素材拼图、混合或共同输入同一次图片生成');
        expect(extraInputPrompt).not.toContain('暂不执行图片任务');

        const mixedPrompt = buildImageAgentPrompt({
            agent: {
                ...agent,
                imageStyleIds: ['github-skills/photo-illustration-diptych/1', 'github-skills/grade-images/1'],
            },
            userPrompt: '分别生成实景插画海报和严格保真的调色版本。',
            imageCount: 1,
        });
        expect(mixedPrompt).toContain('执行一次混合图片批处理');
        expect(mixedPrompt).toContain('[github-skills/photo-illustration-diptych/1]');
        expect(mixedPrompt).toContain('[github-skills/grade-images/1]');
        expect(mixedPrompt).toContain('selected illustration medium');
        expect(mixedPrompt).toContain('deterministic-grade 风格先只生成带标签的低分辨率原图/结果预览');
    });

    it('integrates the Lakeside Minimal Diptych variant with complete scene correspondence rules', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/photo-illustration-diptych/2');
        expect(style).toMatchObject({
            title: 'Lakeside Minimal Diptych',
            categoryId: 'github-skills',
            sourceRepository: 'wangjs-jacky/happy',
            sourceRevision: '532e49bb711283cbe2738439039298f9cea1ef7b',
            templateRef: 'skills/photo-illustration-diptych/SKILL.md',
            promptPath: 'garden-gpt-image-2/prompt/photo-illustration-diptych-lakeside-v1.md',
            sourceCaseId: 'photo-illustration-diptych/user-reference-lakeside-20260808',
            executionKind: 'gpt-image-2',
            inputMode: 'image-required',
            multiInputMode: 'single',
            continuationSourceMode: 'original-upload',
        });
        expect(style?.promptContent).toContain('Photo–Illustration Diptych v1 visual compiler');
        expect(style?.promptContent).toContain('Apply the Lakeside Minimal Diptych variant');
        expect(style?.promptContent).toContain("within the base compiler's chosen proportional crop or warm-paper inset");
        expect(style?.promptContent).toContain('never force it to fill by stretching');
        expect(style?.promptContent).toContain('path or boardwalk curve, dock rhythm, vessel position');
        expect(style?.promptContent).toContain('simple geometric shapes, flat source-derived color fields');
        expect(style?.promptContent).toContain('Remove roughly 85–95%');
        expect(style?.promptContent).toContain('premium international design-studio system');
        expect(style?.sourceLicenseNotice).toContain('Happy Coder Contributors');
        expect(style?.responseInstructions).toContain('preserved waterside correspondences');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/2'] },
            userPrompt: '把上传的湖景做成上方实景、下方极简几何设计的高级海报。',
            imageCount: 1,
        });
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('把上传的湖景做成上方实景、下方极简几何设计的高级海报。');
        expect(prompt).toContain('mcp__happy__send_image');
        expect(prompt).toContain('source-derived palette, and geometric reduction');

        const missingInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/2'] },
            userPrompt: '做湖景极简二联画。',
            imageCount: 0,
        });
        expect(missingInputPrompt).toContain('请先上传一张源照片');

        const extraInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/2'] },
            userPrompt: '做湖景极简二联画。',
            imageCount: 2,
        });
        expect(extraInputPrompt).toContain('源素材 2 张 × 风格 1 个 × 每风格变体 2 张 = 预计输出总数 4 张');
        expect(extraInputPrompt).toContain('每个结果只能使用当前对应的 1 张用户素材作为源图片');
        expect(extraInputPrompt).toContain('禁止把多张用户素材拼图、混合或共同输入同一次图片生成');
        expect(extraInputPrompt).not.toContain('暂不执行图片任务');
    });

    it('integrates Editorial Echo with adaptive orientation, authored copy, and HTML composition', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/photo-illustration-diptych/3');
        expect(style).toMatchObject({
            title: 'Editorial Echo',
            categoryId: 'github-skills',
            sourceRepository: 'wangjs-jacky/happy',
            sourceRevision: 'e8716a0a0c949f8e2b45e1e3d7c8d36ad7bba17c',
            templateRef: 'skills/photo-illustration-diptych/SKILL.md',
            promptPath: 'garden-gpt-image-2/prompt/photo-illustration-editorial-echo-v1.md',
            sourceCaseId: 'photo-illustration-diptych/editorial-echo-20260809',
            executionKind: 'gpt-image-2',
            inputMode: 'image-required',
            multiInputMode: 'single',
            continuationSourceMode: 'original-upload',
        });
        expect(style?.promptContent).toContain('Editorial Echo visual compiler');
        expect(style?.promptContent).toContain('Scene Map');
        expect(style?.promptContent).toContain('Copy Map');
        expect(style?.promptContent).toContain('Use portrait 3:5');
        expect(style?.promptContent).toContain('Use landscape 5:3');
        expect(style?.promptContent).toContain('Use 4:3 only');
        expect(style?.promptContent).toContain('Stage A — generate the illustrated echo only');
        expect(style?.promptContent).toContain('Stage B — compose and rasterize with HTML/CSS');
        expect(style?.promptContent).toContain('Render every character as real HTML text');
        expect(style?.promptContent).toContain('Avoid empty labels such as PORTRAIT');
        expect(style?.promptContent).toContain('not a second rectangular photo');
        expect(style?.promptContent).toContain('regenerate that motif at most once');
        expect(style?.sourceLicenseNotice).toContain('Happy Coder Contributors');
        expect(style?.responseInstructions).toContain('selected orientation');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/3'] },
            userPrompt: '根据照片构图选择横版或竖版，并写一句真正贴合画面的标题。',
            imageCount: 1,
        });
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('根据照片构图选择横版或竖版，并写一句真正贴合画面的标题。');
        expect(prompt).toContain('mcp__happy__send_image');
        expect(prompt).toContain('selected orientation');

        const missingInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/3'] },
            userPrompt: '做画面回声海报。',
            imageCount: 0,
        });
        expect(missingInputPrompt).toContain('请先上传一张源照片');

        const extraInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/photo-illustration-diptych/3'] },
            userPrompt: '做画面回声海报。',
            imageCount: 2,
        });
        expect(extraInputPrompt).toContain('每个结果只能使用当前对应的 1 张用户素材作为源图片');
        expect(extraInputPrompt).toContain('禁止把多张用户素材拼图、混合或共同输入同一次图片生成');
    });

    it('integrates Scene Distillation Zine with source privacy and exact color-block semantics', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/scene-distillation-zine/1');
        expect(style).toMatchObject({
            title: 'Scene Distillation Zine',
            categoryId: 'github-skills',
            sourceRepository: 'Zeejay0/scene-distillation-zine-v1-3',
            sourceRevision: '921390baac518c85d60a6d98709f1dd657eec720',
            templateRef: 'skills/scene-distillation-zine-v1-3/SKILL.md',
        });
        expect(style?.promptContent).toContain('semantic evidence and creative stimulus');
        expect(style?.promptContent).toContain('do not reproduce, embed, crop, collage, trace');
        expect(style?.promptContent).toContain('Do not browse, search, share, or upload the source anywhere else');
        expect(style?.promptContent).toContain('without visual inspection, quality-gate review, or automatic regeneration');
        expect(style?.promptContent).toContain('combined area stays below 25% of the total accent area');
        expect(style?.promptContent).toContain('A distributed set replaces the ordinary main-accent-plus-echo system');
        expect(style?.promptContent).toContain('exact trigger 单色块模式');
        expect(style?.promptContent).toContain('exactly one contiguous fully saturated color field');
        expect(style?.promptContent).toContain('Typography may use the neutral ink system, the single saturated hue, or both');
        expect(style?.responseInstructions).toContain("user's current conversation language");
        expect(style?.responseInstructions).toContain('creative-concept and art-direction notes');
        expect(style?.responseInstructions).toContain('generation service received the final prompt and reference image');
        expect(style?.sourceLicenseNotice).toContain('Scene Distillation Zine contributors');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/scene-distillation-zine/1'] },
            userPrompt: '用单色块模式把上传的城市照片提炼成原创纸刊插画。',
            imageCount: 1,
        });

        expect(prompt).toContain('$gpt-image-2');
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Scene Distillation Zine v1.3 visual compiler');
        expect(prompt).toContain('单色块模式');
        expect(prompt).toContain('Do not browse, search, share, or upload the source anywhere else');
        expect(prompt).toContain('without visual inspection, quality-gate review, or automatic regeneration');
        expect(prompt).toContain("user's current conversation language");
        expect(prompt).toContain('creative-concept and art-direction notes');
        expect(prompt).toContain('generation service received the final prompt and reference image');
        expect(prompt).toContain('mcp__happy__send_image');
    });

    it('routes grade-images through its pinned deterministic pipeline instead of a generative editor', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/grade-images/1');
        expect(style).toMatchObject({
            title: 'Deterministic Photo Grade',
            categoryId: 'github-skills',
            sourceRepository: 'liwushu128-debug/grade-images',
            sourceRevision: '3e8ecd3b8c2636c7286a052ad147a77549ab9660',
            templateRef: 'skills/grade-images/SKILL.md',
            templateLabelKey: 'agents.imageStyleGradeImages',
            executionKind: 'deterministic-grade',
            inputMode: 'image-required',
            supportedInputFormats: ['jpeg', 'png'],
        });
        expect(style?.promptContent).toContain('Never use GPT Image, image_gen, neural style transfer');
        expect(style?.promptContent).toContain('preservation.mode to strict');
        expect(style?.promptContent).toContain('Source-derived highlight diffusion requires separate explicit user approval');
        expect(style?.promptContent).toContain('exact versioned JSON recipe');
        expect(style?.promptContent).toContain('Do not execute an already discovered or globally installed $grade-images Skill');
        expect(style?.sourceLicenseNotice).toContain('Apache License, Version 2.0');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/grade-images/1'] },
            userPrompt: '把上传的湖景照片做成电影感 bold 调色，不改变任何内容。',
            imageCount: 1,
        });

        expect(prompt).toContain('使用 $grade-images skill 执行一次确定性、非生成式照片调色批处理');
        expect(prompt).toContain('engine=deterministic-grade');
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Never use GPT Image, image_gen, neural style transfer');
        expect(prompt).toContain('版本化 recipe、质量报告和对比图');
        expect(prompt).toContain('把上传的湖景照片做成电影感 bold 调色，不改变任何内容。');
        expect(prompt).not.toContain('第一次调用 native image_gen 前');

        const missingInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/grade-images/1'] },
            userPrompt: '做电影感调色',
            imageCount: 0,
        });
        expect(missingInputPrompt).toContain('请先上传一张源照片');
        expect(missingInputPrompt).toContain('github-skills/grade-images/1');
        expect(missingInputPrompt).toContain('不要启动生成式或确定性图片工具');

        const batchPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/grade-images/1'] },
            userPrompt: '把三张照片统一成同一电影感调色。',
            imageCount: 3,
        });
        expect(batchPrompt).toContain('已上传 3 张参考图');
        expect(batchPrompt).toContain('使用 $grade-images skill 执行一次确定性、非生成式照片调色批处理');
    });

    it('integrates Gathered Scenes Zine with truthful photo anchoring and structural color', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/scenes-gathered-zine/1');
        expect(style).toMatchObject({
            title: 'Gathered Scenes Zine',
            categoryId: 'github-skills',
            sourceRepository: 'Zeejay0/gathered-scenes-zine-skill',
            sourceRevision: 'e764b7fd243d7cc501723b9d325279bf6dd852c2',
            templateRef: 'skills/scenes-gathered-zine-v1-3/SKILL.md',
            templateLabelKey: 'agents.imageStyleScenesGatheredZine',
            inputMode: 'image-required',
        });
        expect(style?.promptContent).toContain('truthful photography as anchor');
        expect(style?.promptContent).toContain('remove roughly 60–80%');
        expect(style?.promptContent).toContain('omit roughly 85–95%');
        expect(style?.promptContent).toContain('hand-torn fibrous edge');
        expect(style?.promptContent).toContain('exactly one high-chroma print hue');
        expect(style?.promptContent).toContain('English-only by default');
        expect(style?.promptContent).toContain('Regenerate at most once');
        expect(style?.sourceLicenseNotice).toContain('Gathered Scenes Zine contributors');

        const prompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/scenes-gathered-zine/1'] },
            userPrompt: '把上传的丹霞照片做成拾景纸刊，保留真实山体作为锚点。',
            imageCount: 1,
        });

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Gathered Scenes Zine v1.3 visual compiler');
        expect(prompt).toContain("user's current conversation language");
        expect(prompt).toContain('mcp__happy__send_image');

        const seaStyle = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/scenes-gathered-zine/2');
        expect(seaStyle).toMatchObject({
            title: 'Gathered Scenes Zine · Sea',
            sourceRepository: style!.sourceRepository,
            sourceRevision: style!.sourceRevision,
            inputMode: 'image-required',
            templateLabelKey: 'agents.imageStyleScenesGatheredZineSea',
        });
        expect(seaStyle?.promptContent).toBe(style!.promptContent);
        expect(seaStyle?.sourceCaseId).toBe('scenes-gathered-zine-v1-3/user-reference-sea');

        const extraInputPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/scenes-gathered-zine/1'] },
            userPrompt: '做拾景纸刊。',
            imageCount: 2,
        });
        expect(extraInputPrompt).toContain('源素材 2 张 × 风格 1 个 × 每风格变体 2 张 = 预计输出总数 4 张');
        expect(extraInputPrompt).toContain('每个结果只能使用当前对应的 1 张用户素材作为源图片');
        expect(extraInputPrompt).not.toContain('暂不执行图片任务');

        const styleReferenceOnlyPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/scenes-gathered-zine/1'] },
            userPrompt: '做拾景纸刊。',
            imageCount: 1,
            styleReferenceImageCount: 1,
            userImageCount: 0,
        });
        expect(styleReferenceOnlyPrompt).toContain('请先上传一张源照片');

        const splitCountPrompt = buildImageAgentPrompt({
            agent: { ...agent, imageStyleIds: ['github-skills/scenes-gathered-zine/1'] },
            userPrompt: '做拾景纸刊。',
            imageCount: 2,
            styleReferenceImageCount: 1,
            userImageCount: 1,
        });
        expect(splitCountPrompt).toContain('后 1 张是本次用户素材');
        expect(splitCountPrompt).not.toContain('一次只接受一张源照片');
    });

    it('composes mixed generative and deterministic styles without weakening either engine contract', () => {
        const prompt = buildImageAgentPrompt({
            agent: {
                ...agent,
                imageStyleIds: ['github-skills/scene-distillation-zine/1', 'github-skills/grade-images/1'],
            },
            userPrompt: '分别生成纸刊版本与严格保真的调色版本。',
            imageCount: 1,
        });

        expect(prompt).toContain('执行一次混合图片批处理');
        expect(prompt).toContain('生成型风格使用 $gpt-image-2');
        expect(prompt).toContain('deterministic-grade 风格必须使用其 $grade-images 确定性管线');
        expect(prompt).toContain('以下首次请求优化只适用于生成型风格，不得用于 deterministic-grade');
        expect(prompt).toContain('deterministic-grade 风格先只生成带标签的低分辨率原图/结果预览');
        expect(prompt).toContain('必须暂停，不得开始全分辨率或批量调色');
        expect(prompt).toContain('用户确认预览后，在同一 batchId 下继续');
        expect(prompt).toContain('[github-skills/scene-distillation-zine/1]');
        expect(prompt).toContain('[github-skills/grade-images/1]');
        expect(prompt).toContain('如有失败的风格，只简短说明失败的风格 id 和原因');
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
        expect(prompt).toContain('源素材 3 张 × 风格 2 个 × 每风格变体 2 张 = 预计输出总数 12 张');
        expect(prompt).toContain('每完成 1 张就立即调用 mcp__happy__send_image');
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

    it('builds the full source-by-style-by-variant cartesian batch without per-image confirmation', () => {
        const prompt = buildImageAgentPrompt({
            agent: {
                ...agent,
                imageStyleIds: [
                    'github-skills/photo-illustration-diptych/1',
                    'github-skills/scenes-gathered-zine/2',
                    'github-skills/scenes-gathered-zine/1',
                    'github-skills/scene-distillation-zine/1',
                ],
            },
            userPrompt: '全部批量生成。',
            imageCount: 7,
            userImageCount: 7,
        });

        expect(prompt).toContain('源素材 7 张 × 风格 4 个 × 每风格变体 2 张 = 预计输出总数 56 张');
        expect(prompt).toContain('按用户素材顺序逐张遍历，再遍历全部选中风格与变体');
        expect(prompt).toContain('每完成 1 张就立即调用 mcp__happy__send_image');
        expect(prompt).toContain('不要等 56 张全部完成后再集中发送');
        expect(prompt).not.toContain('请只保留或明确选择其中一张图片后再继续');
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
