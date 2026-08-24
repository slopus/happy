import { describe, expect, it } from 'vitest';
import { IMAGE_AGENT_STYLE_PRESETS } from './imageAgentPrompt';
import {
    buildImageStyleContinuationPrompt,
    formatImageStyleOption,
    parseImageStyleOptions,
} from './imageStyleOptions';

describe('imageStyleOptions', () => {
    it('round-trips a canonical versioned image-effects option', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find(
            (preset) => preset.id === 'image-effects/torn-paper-editorial-photo-collage@1.0.0',
        );
        expect(style).toBeTruthy();
        const parsed = parseImageStyleOptions([formatImageStyleOption(style!)]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.style.id).toBe(style!.id);
        expect(parsed[0]?.title).toBe(style!.title);
    });

    it('removes duplicates and caps encoded options at ten', () => {
        const styles = IMAGE_AGENT_STYLE_PRESETS.slice(0, 12);
        const parsed = parseImageStyleOptions([
            formatImageStyleOption(styles[0]),
            ...styles.map(formatImageStyleOption),
            '普通选项',
        ]);
        expect(parsed).toHaveLength(10);
        expect(parsed.map((item) => item.style.id)).toEqual(styles.slice(0, 10).map((style) => style.id));
    });

    it('builds one continuation prompt for multiple canonical effects', () => {
        const styles = IMAGE_AGENT_STYLE_PRESETS.slice(0, 3);
        const prompt = buildImageStyleContinuationPrompt(styles, { variantsPerStyle: 3 });
        expect(prompt).toContain('$gpt-image-2');
        expect(prompt).toContain('同一个批处理');
        expect(prompt).toContain('各生成 3 张变体');
        expect(prompt).toContain('<options>');
        for (const style of styles) {
            expect(prompt).toContain(style.id);
            expect(prompt).toContain(style.promptContent);
        }
    });

    it('preserves source-image continuation rules for image-only effects', () => {
        const style = IMAGE_AGENT_STYLE_PRESETS.find(
            (preset) => preset.id === 'image-effects/background-replacement@1.0.0',
        );
        const prompt = buildImageStyleContinuationPrompt([style!]);
        expect(prompt).toContain('必须有源图片');
        expect(prompt).toContain('一次只能处理一张源图片');
        expect(prompt).toContain('必须复用当前批次最初的用户上传源图');
        expect(prompt).toContain(style!.promptContent);
    });

    it('keeps first-request transport policy for continuation batches', () => {
        const prompt = buildImageStyleContinuationPrompt(IMAGE_AGENT_STYLE_PRESETS.slice(0, 1));
        expect(prompt).toContain('首次请求优化');
        expect(prompt).toContain('第一次调用 native image_gen 前');
        expect(prompt).toContain('连续等待 8 分钟');
    });

    it('does not expose the deferred grade-images integration', () => {
        expect(IMAGE_AGENT_STYLE_PRESETS.some((style) => style.executionKind === 'deterministic-grade')).toBe(false);
        expect(JSON.stringify(IMAGE_AGENT_STYLE_PRESETS)).not.toContain('grade-images');
    });
});
