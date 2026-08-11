import { describe, expect, it } from 'vitest';
import { IMAGE_AGENT_STYLE_PRESETS } from './imageAgentPrompt';
import {
    buildImageStyleContinuationPrompt,
    formatImageStyleOption,
    parseImageStyleOptions,
} from './imageStyleOptions';

describe('imageStyleOptions', () => {
    it('round-trips the Torn Paper Editorial Gallery option and keeps its compiler', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'reference-torn-paper-editorial/torn-paper-photo-collage/1');
        expect(style).toBeTruthy();

        const option = formatImageStyleOption(style!);
        const parsed = parseImageStyleOptions([option]);
        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.style.id).toBe(style!.id);
        expect(parsed[0]?.title).toBe('撕纸编辑影像拼贴');
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain(style!.id);
        expect(prompt).toContain('45% to 65% of the poster');
        expect(prompt).toContain('black-and-white halftone');
        expect(prompt).toContain('一次只能处理一张源图片');
    });

    it('parses encoded GPT Image Gallery options, removes duplicates, and caps at ten', () => {
        const styles = IMAGE_AGENT_STYLE_PRESETS.slice(0, 12);
        const options = [
            formatImageStyleOption(styles[0]),
            ...styles.map(formatImageStyleOption),
            '普通选项',
        ];

        const parsed = parseImageStyleOptions(options);

        expect(parsed).toHaveLength(10);
        expect(parsed[0]?.style.id).toBe(styles[0].id);
        expect(parsed.map((item) => item.style.id)).toEqual(
            styles.slice(0, 10).map((style) => style.id),
        );
    });

    it('builds one continuation prompt for multiple selected Gallery styles', () => {
        const styles = IMAGE_AGENT_STYLE_PRESETS.slice(0, 3);

        const prompt = buildImageStyleContinuationPrompt(styles, { variantsPerStyle: 3 });

        expect(prompt).toContain('$gpt-image-2');
        expect(prompt).toContain('同一个批处理');
        expect(prompt).toContain('不限制多风格');
        expect(prompt).toContain('各生成 3 张变体');
        expect(prompt).toContain('<options>');
        expect(prompt).toContain('[[gpt-image-style:');
        for (const style of styles) {
            expect(prompt).toContain(style.id);
            expect(prompt).toContain(style.promptHint);
        }
    });

    it('keeps the first-request transport policy for continuation batches', () => {
        const prompt = buildImageStyleContinuationPrompt(IMAGE_AGENT_STYLE_PRESETS.slice(0, 1));

        expect(prompt).toContain('首次请求优化');
        expect(prompt).toContain('第一次调用 native image_gen 前');
        expect(prompt).toContain('连续等待 8 分钟');
        expect(prompt).toContain('同一个 batchId 内重试一次');
        expect(prompt).toContain('不得减少参考信息、缩短风格分析、简化完整 prompt 或降低最终生成质量');
    });

    it('keeps the complete Minimal Zine Poster compiler in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/minimal-zine-poster/1');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Minimal Zine Poster v0.1 Standard Mode compiler');
        expect(prompt).toContain('70%-90% plain paper');
        expect(prompt).toContain('variation recipe');
        expect(prompt).toContain('high-chroma hue');
    });

    it('keeps the complete Photo–Illustration Diptych compiler in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/photo-illustration-diptych/1');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('github-skills/photo-illustration-diptych/1');
        expect(prompt).toContain('Photo–Illustration Diptych v1 visual compiler');
        expect(prompt).toContain('build a Scene Map');
        expect(prompt).toContain('Apply one uniform, isotropic scale factor');
        expect(prompt).toContain('Build one normalized, content-space Framing Map');
        expect(prompt).toContain('same-aspect-ratio content rectangle');
        expect(prompt).toContain('Prefer breathing paper over distorted content');
        expect(prompt).toContain('必须复用当前批次最初的用户上传源图');
        expect(prompt).toContain('原始上传图优先于当前会话中的已生成结果');
        expect(prompt).not.toContain('输入：优先使用当前会话中最近一次生成的图片作为视觉参考');
        expect(prompt).toContain('Default to a text-free poster');
        expect(prompt).toContain('regenerate at most once');
        expect(prompt).toContain('必须有源图片');
        expect(prompt).toContain('一次只能处理一张源图片');
        expect(prompt).toContain('selected illustration medium');
    });

    it('keeps the complete Lakeside Minimal Diptych variant in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/photo-illustration-diptych/2');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('github-skills/photo-illustration-diptych/2');
        expect(prompt).toContain('Photo–Illustration Diptych v1 visual compiler');
        expect(prompt).toContain('Apply the Lakeside Minimal Diptych variant');
        expect(prompt).toContain("within the base compiler's chosen proportional crop or warm-paper inset");
        expect(prompt).toContain('never force it to fill by stretching');
        expect(prompt).toContain('path or boardwalk curve, dock rhythm, vessel position');
        expect(prompt).toContain('Remove roughly 85–95%');
        expect(prompt).toContain('必须有源图片');
        expect(prompt).toContain('一次只能处理一张源图片');
        expect(prompt).toContain('source-derived palette, and geometric reduction');
    });

    it('keeps the complete Editorial Echo compiler in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/photo-illustration-diptych/3');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('github-skills/photo-illustration-diptych/3');
        expect(prompt).toContain('Editorial Echo visual compiler');
        expect(prompt).toContain('Use landscape 5:3');
        expect(prompt).toContain('Stage A — generate the illustrated echo only');
        expect(prompt).toContain('Stage B — compose and rasterize with HTML/CSS');
        expect(prompt).toContain('Render every character as real HTML text');
        expect(prompt).toContain('not a second rectangular photo');
        expect(prompt).toContain('必须有源图片');
        expect(prompt).toContain('一次只能处理一张源图片');
        expect(prompt).toContain('selected orientation');
    });

    it('keeps the complete Scene Distillation compiler in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/scene-distillation-zine/1');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Scene Distillation Zine v1.3 visual compiler');
        expect(prompt).toContain('semantic evidence and creative stimulus');
        expect(prompt).toContain('exact trigger 单色块模式');
        expect(prompt).toContain('exactly one contiguous fully saturated color field');
        expect(prompt).toContain('Do not browse, search, share, or upload the source anywhere else');
        expect(prompt).toContain('without visual inspection, quality-gate review, or automatic regeneration');
        expect(prompt).toContain("user's current conversation language");
        expect(prompt).toContain('creative-concept and art-direction notes');
        expect(prompt).toContain('generation service received the final prompt and reference image');
    });

    it('keeps grade-images deterministic in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/grade-images/1');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain('使用 $grade-images skill 继续执行一次确定性、非生成式照片调色批处理');
        expect(prompt).toContain('engine=deterministic-grade');
        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Never use GPT Image, image_gen, neural style transfer');
        expect(prompt).toContain('版本化 recipe、质量报告和对比图');
        expect(prompt).not.toContain('第一次调用 native image_gen 前');
        expect(prompt).toContain('必须有源图片');
    });

    it('keeps the complete Gathered Scenes compiler in continuation batches', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/scenes-gathered-zine/1');
        expect(style).toBeTruthy();

        const prompt = buildImageStyleContinuationPrompt([style!]);

        expect(prompt).toContain(style!.promptContent);
        expect(prompt).toContain('Gathered Scenes Zine v1.3 visual compiler');
        expect(prompt).toContain('truthful photography as anchor');
        expect(prompt).toContain('hand-torn fibrous edge');
        expect(prompt).toContain('exactly one high-chroma print hue');
        expect(prompt).toContain("user's current conversation language");
        expect(prompt).toContain('一次只能处理一张源图片');
        expect(prompt).toContain('存在多张候选素材时按顺序逐张独立处理');
        expect(prompt).toContain('禁止把多张素材共同输入同一次生成');

        const seaStyle = IMAGE_AGENT_STYLE_PRESETS.find((preset) => preset.id === 'github-skills/scenes-gathered-zine/2');
        expect(seaStyle).toBeTruthy();
        const seaPrompt = buildImageStyleContinuationPrompt([seaStyle!]);
        expect(seaPrompt).toContain(seaStyle!.promptContent);
        expect(seaPrompt).toContain('github-skills/scenes-gathered-zine/2');
        expect(seaPrompt).toContain('truthful coastal photo anchor');
    });
});
