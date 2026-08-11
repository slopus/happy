import {
    IMAGE_AGENT_STYLE_PRESETS,
    getImageAgentStyleLabel,
    getImageAgentStylePromptHint,
    getImageAgentExecutionLead,
    getImageAgentFirstRequestRules,
    getImageAgentContinuationInputRules,
    getImageAgentMixedEngineRules,
    getImageAgentResponseInstructions,
    normalizeImageAgentVariantCount,
    type ImageAgentStylePreset,
} from './imageAgentPrompt';

export const IMAGE_STYLE_OPTION_PREFIX = 'gpt-image-style:';
export const MAX_IMAGE_STYLE_OPTION_COUNT = 10;

const STYLE_BY_ID = new Map(IMAGE_AGENT_STYLE_PRESETS.map((style) => [style.id, style]));

export type ParsedImageStyleOption = {
    raw: string;
    title: string;
    style: ImageAgentStylePreset;
};

export function formatImageStyleOption(style: ImageAgentStylePreset): string {
    return `[[${IMAGE_STYLE_OPTION_PREFIX}${style.id}]] ${getImageAgentStyleLabel(style)}`;
}

export function parseImageStyleOption(raw: string): ParsedImageStyleOption | null {
    const match = raw.match(/^\[\[gpt-image-style:([^\]]+)\]\]\s*(.*)$/);
    if (!match) return null;
    const style = STYLE_BY_ID.get(match[1]);
    if (!style) return null;
    const title = match[2].trim() || getImageAgentStyleLabel(style);
    return { raw, title, style };
}

export function parseImageStyleOptions(items: string[], limit: number = MAX_IMAGE_STYLE_OPTION_COUNT): ParsedImageStyleOption[] {
    const result: ParsedImageStyleOption[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const parsed = parseImageStyleOption(item);
        if (!parsed || seen.has(parsed.style.id)) continue;
        seen.add(parsed.style.id);
        result.push(parsed);
        if (result.length >= limit) break;
    }
    return result;
}

export function buildImageStyleContinuationPrompt(
    styles: ImageAgentStylePreset[],
    options: { variantsPerStyle?: number } = {},
): string {
    const variants = normalizeImageAgentVariantCount(options.variantsPerStyle ?? 1);
    const styleList = styles.map((style, index) => [
        `${index + 1}. ${style.id} (${style.templateRef}; engine=${style.executionKind ?? 'gpt-image-2'}) - ${getImageAgentStyleLabel(style)}: ${getImageAgentStylePromptHint(style)}`,
        style.promptContent,
    ].filter(Boolean).join('\n')).join('\n');
    const recommendedOptions = getRecommendedImageStyleOptions(styles).map((option) => `<option>${option}</option>`).join('\n');
    const responseInstructions = getImageAgentResponseInstructions(styles);

    return [
        getImageAgentExecutionLead(styles, true),
        '',
        '生成锁：',
        '- 这是同一个批处理的并发锁，只用于避免两个图片任务同时运行，不限制多风格生成。',
        '- 请在同一个批处理中依次完成下面所有选中风格，不要拆成多个新任务。',
        '- 如果当前会话里已经有另一个图片生成任务在运行，请报告图片生成器已被锁定，不要重复启动新的任务。',
        '',
        ...getImageAgentFirstRequestRules(styles),
        '',
        ...getImageAgentContinuationInputRules(styles),
        '',
        ...getImageAgentMixedEngineRules(styles),
        '',
        '输入：按上面的风格级续生成素材规则选择参考图；没有声明原始上传优先的风格，才优先使用当前会话中最近一次生成的相关图片，找不到时再使用最近一次上传的相关图片。',
        '用户目标：基于当前结果继续生成下面选中的 GPT Image Gallery 风格。',
        '',
        '输出要求：',
        `- 对下面每个选中的风格，各生成 ${variants} 张变体。`,
        '- 生成型风格将 prompt 保存到 garden-gpt-image-2/prompt/、图片保存到 garden-gpt-image-2/image/；deterministic-grade 风格按其 Skill 输出契约保存无损图片、版本化 recipe、质量报告和对比图。',
        '- 复用或生成一个稳定 batchId；每保存一张 PNG/JPEG 后，立即用绝对本地路径调用 mcp__happy__send_image 内联发送，并传入本张图片对应的完整 prompt 和 batchId。不要对本地文件使用 Markdown 图片语法。',
        '- 不要在对话里展示生成过程、命令输出、完整 prompt 或路径清单。',
        `- 最终回复：${responseInstructions}`,
        '- 最终回复末尾附上下面这些 GPT Image Gallery 推荐选项，保持 option 内容原样，不要改写 style id；客户端会把它们渲染成可多选风格推荐。',
        '',
        '已选择的 GPT Image Gallery 风格：',
        styleList,
        '',
        '推荐续生成选项：',
        '<options>',
        recommendedOptions,
        '</options>',
    ].join('\n');
}

export function getRecommendedImageStyleOptions(styles: ImageAgentStylePreset[], limit: number = MAX_IMAGE_STYLE_OPTION_COUNT): string[] {
    const selectedIds = new Set(styles.map((style) => style.id));
    const selectedCategoryIds = new Set(styles.map((style) => style.categoryId));
    const ordered: ImageAgentStylePreset[] = [];
    const push = (style: ImageAgentStylePreset) => {
        if (ordered.some((item) => item.id === style.id)) return;
        ordered.push(style);
    };

    styles.forEach(push);
    IMAGE_AGENT_STYLE_PRESETS
        .filter((style) => !selectedIds.has(style.id) && selectedCategoryIds.has(style.categoryId))
        .forEach(push);
    IMAGE_AGENT_STYLE_PRESETS
        .filter((style) => !selectedIds.has(style.id))
        .forEach(push);

    return ordered.slice(0, limit).map(formatImageStyleOption);
}
