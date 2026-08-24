import type { AgentLauncher } from './launchAgent';
import {
    IMAGE_EFFECTS_STYLE_CATEGORIES,
    IMAGE_EFFECTS_STYLE_PRESETS,
    resolveImageEffectsStyleId,
} from './imageEffectsCatalogAdapter';
import type {
    ImageAgentStyleCategory,
    ImageAgentStyleLabelKey,
    ImageAgentStylePreset,
    UserImageStyle,
} from './imageStyleTypes';

export type { ImageAgentStyleCategory, ImageAgentStyleLabelKey, ImageAgentStylePreset };

export const USER_IMAGE_STYLE_ID_PREFIX = 'user-reference/';

export const IMAGE_AGENT_STYLE_PRESETS: ImageAgentStylePreset[] = IMAGE_EFFECTS_STYLE_PRESETS;

export const IMAGE_AGENT_STYLE_CATEGORIES: ImageAgentStyleCategory[] = [
    { id: 'user-reference', label: '自定义风格', accent: '#2F7D6B', count: 0 },
    ...IMAGE_EFFECTS_STYLE_CATEGORIES,
];

const STYLE_BY_ID = new Map(IMAGE_AGENT_STYLE_PRESETS.map((style) => [style.id, style]));
const MAX_RECOMMENDED_CONTINUATION_STYLES = 10;
export const MIN_IMAGE_AGENT_VARIANTS_PER_STYLE = 1;
export const MAX_IMAGE_AGENT_VARIANTS_PER_STYLE = 4;

export const IMAGE_AGENT_FIRST_REQUEST_RULES = [
    '首次请求优化（只优化传输与调度，不牺牲效果）：',
    '- 在第一次调用 native image_gen 前就完成参考图传输预处理，不要等第一次调用挂起后再补救。',
    '- 保留原始文件不动，只创建高质量临时传输副本：普通构图/场景参考图使用 1024px 长边，风格、身份、文字、产品细节等敏感参考图使用 1536px 长边（即按内容在 1024–1536px 内选择）；保持方向、色彩和清晰度，不要放大小于目标尺寸的原图，禁止反复压缩。',
    '- 如果参考图数量超过 native 工具上限（通常为 5 张），只合并风格参考图为清晰 contact sheet；主体参考图保持独立，并在 prompt 中明确每张图的角色。',
    '- 这些调整只作用于传输副本；不得减少参考信息、缩短风格分析、简化完整 prompt 或降低最终生成质量。',
    '- native 调用正常可能耗时数分钟；若连续等待 8 分钟仍无图片、错误或进度输出，判定本次调用挂起。终止当前调用，并在同一个 batchId 内重试一次；这不算第二个批处理，生成锁继续有效。',
    '- 重试时只能继续优化输入文件体积或参考板布局，必须保持相同的创意方案、风格约束、主体保真要求和最终生成质量。',
] as const;

export function shouldUseUserImageStyleReferenceImages(style: Pick<UserImageStyle, 'analysisStatus' | 'promptContent' | 'referenceImages'>): boolean {
    return style.referenceImages.length > 0 && !(style.analysisStatus === 'prompt-ready' && !!style.promptContent?.trim());
}

function normalizeLegacyReferenceStyleId(styleId: string): string {
    if (styleId.startsWith('oba-tiramisu/')) {
        return styleId.replace('oba-tiramisu/', 'reference-tiramisu/');
    }
    if (styleId.startsWith('oba-dog/')) {
        return styleId.replace('oba-dog/', 'reference-dog/');
    }
    return styleId;
}

export function createUserImageStylePreset(style: UserImageStyle): ImageAgentStylePreset {
    const extractedPrompt = style.analysisStatus === 'prompt-ready' ? style.promptContent?.trim() : undefined;
    const promptContent = extractedPrompt
        ? [
            `自定义 Prompt 风格：${style.title}`,
            extractedPrompt,
            style.negativePrompt?.trim() ? `避免：${style.negativePrompt.trim()}` : '',
            style.tags?.length ? `标签：${style.tags.join('、')}` : '',
            '把这份沉淀后的风格 Prompt 应用到本次用户素材或用户描述上，不需要再依赖原始参考照片，除非本次用户另外上传了图片。',
        ].filter(Boolean).join('\n')
        : [
            `自定义参考照片风格：${style.title}`,
            style.promptHint,
            '当前风格 Prompt 还在提炼中，先用随任务一起上传的自定义风格参考图作为临时风格来源。',
            '必须从自定义风格参考图中提取视觉语言，包括色彩、光线、材质、镜头/笔触、构图、背景氛围和排版倾向。',
            '把这些风格特征迁移到本次用户素材或用户描述上，不要把参考图主体误当成必须复刻的内容，除非用户明确要求。',
        ].join('\n');

    return {
        id: style.id,
        title: style.title,
        categoryId: 'user-reference',
        categoryLabel: '自定义风格',
        categoryAccent: '#2F7D6B',
        templateRef: 'user-reference/photo-style',
        templateLabel: extractedPrompt ? 'Prompt Ready' : 'Reference Ready',
        promptHint: style.promptHint,
        promptContent,
        promptPath: `user-reference/${style.id}.md`,
        sourceCaseId: style.id,
        sourceRepository: 'user-reference',
        // Always carry the reference images so the gallery card can render its
        // thumbnail. Whether to actually SEND them as attachments (vs. using the
        // extracted text prompt) is a separate decision made on the raw style via
        // shouldUseUserImageStyleReferenceImages — see ComposeHome's
        // selectedCustomReferenceImages. Gating this field too used to blank the
        // thumbnail the moment a prompt was extracted (prompt-ready).
        referenceImages: style.referenceImages,
        analysisStatus: style.analysisStatus,
        analysisError: style.analysisError,
        customPromptContent: style.promptContent,
        customNegativePrompt: style.negativePrompt,
        customCreatedAt: style.createdAt,
        customUpdatedAt: style.updatedAt,
        customAnalyzedAt: style.analyzedAt,
        customAnalysisSessionId: style.analysisSessionId,
        custom: true,
    };
}

function getUserStylePresets(customStyles: UserImageStyle[] = []): ImageAgentStylePreset[] {
    return customStyles
        .filter((style) => style.referenceImages.length > 0 || !!style.promptContent?.trim())
        .map(createUserImageStylePreset);
}

function resolveImageAgentStyle(styleId: string, customStyles: UserImageStyle[] = []): ImageAgentStylePreset | undefined {
    const custom = getUserStylePresets(customStyles).find((style) => style.id === styleId);
    if (custom) return custom;
    const normalizedStyleId = normalizeLegacyReferenceStyleId(styleId);
    const canonicalStyleId = resolveImageEffectsStyleId(normalizedStyleId);
    return canonicalStyleId ? STYLE_BY_ID.get(canonicalStyleId) : undefined;
}

function resolveUniqueImageAgentStyles(styleIds: readonly string[], customStyles: UserImageStyle[] = []): ImageAgentStylePreset[] {
    const stylesByCanonicalId = new Map<string, ImageAgentStylePreset>();
    for (const styleId of styleIds) {
        const style = resolveImageAgentStyle(styleId, customStyles);
        if (style && !stylesByCanonicalId.has(style.id)) {
            stylesByCanonicalId.set(style.id, style);
        }
    }
    return [...stylesByCanonicalId.values()];
}

export function canonicalizeImageAgentStyleIds(styleIds: readonly string[]): string[] {
    return resolveUniqueImageAgentStyles(styleIds).map((style) => style.id);
}

export function getImageAgentStyleLabel(style: ImageAgentStylePreset): string {
    return style.title;
}

export function getImageAgentStyleCategoryLabel(style: ImageAgentStylePreset): string {
    return style.categoryLabel;
}

export function getImageAgentStylePromptHint(style: ImageAgentStylePreset): string {
    return style.promptHint;
}

export function getImageAgentResponseInstructions(styles: ImageAgentStylePreset[]): string {
    const baseInstructions = '如有失败的风格，只简短说明失败的风格 id 和原因。不要输出 prompt 文件路径、图片文件路径或清单；也不要输出完整 prompt、私有源文件路径或完整命令日志。';
    const customInstructions = styles
        .map((style) => style.responseInstructions?.trim()
            ? `[${style.id}] ${style.responseInstructions.trim()}`
            : null)
        .filter((value): value is string => !!value);
    return customInstructions.length > 0
        ? `${baseInstructions}\n${customInstructions.join('\n')}`
        : `如果全部成功，先只写“完成。”；${baseInstructions}`;
}

export function getImageAgentExecutionLead(styles: ImageAgentStylePreset[], continuation: boolean = false): string {
    const hasDeterministicGrade = styles.some((style) => style.executionKind === 'deterministic-grade');
    const hasGenerativeStyle = styles.some((style) => style.executionKind !== 'deterministic-grade');
    const verb = continuation ? '继续执行' : '执行';
    if (hasDeterministicGrade && hasGenerativeStyle) {
        return `${verb}一次混合图片批处理：生成型风格使用 $gpt-image-2；deterministic-grade 风格必须使用其 $grade-images 确定性管线，绝不能交给生成式图片编辑器。`;
    }
    if (hasDeterministicGrade) {
        return `使用 $grade-images skill ${verb}一次确定性、非生成式照片调色批处理。`;
    }
    return `使用 $gpt-image-2 skill ${verb}一次 GPT Image 2 图片编辑 / 生成批处理。`;
}

export function getImageAgentFirstRequestRules(styles: ImageAgentStylePreset[]): readonly string[] {
    const hasDeterministicGrade = styles.some((style) => style.executionKind === 'deterministic-grade');
    const hasGenerativeStyle = styles.some((style) => style.executionKind !== 'deterministic-grade');
    if (!hasGenerativeStyle) return [];
    return hasDeterministicGrade
        ? ['以下首次请求优化只适用于生成型风格，不得用于 deterministic-grade：', ...IMAGE_AGENT_FIRST_REQUEST_RULES]
        : IMAGE_AGENT_FIRST_REQUEST_RULES;
}

export function getImageAgentMixedEngineRules(styles: ImageAgentStylePreset[]): readonly string[] {
    const hasDeterministicGrade = styles.some((style) => style.executionKind === 'deterministic-grade');
    const hasGenerativeStyle = styles.some((style) => style.executionKind !== 'deterministic-grade');
    if (!hasDeterministicGrade || !hasGenerativeStyle) return [];

    return [
        '混合引擎顺序：',
        '- 生成型风格可以在当前批次中正常完成并发送成片。',
        '- deterministic-grade 风格先只生成带标签的低分辨率原图/结果预览；除非用户当前消息已经明确确认该预览，否则必须暂停，不得开始全分辨率或批量调色，也不得声称整个混合批次已经完成。',
        '- 用户确认预览后，在同一 batchId 下继续 deterministic-grade 的全分辨率或批量阶段，再按其 Skill 交付 recipe、质量报告与结果图。',
    ];
}

export function getImageAgentContinuationInputRules(styles: ImageAgentStylePreset[]): readonly string[] {
    const imageRequiredStyles = styles.filter((style) => style.inputMode === 'image-required');
    const singleImageStyles = styles.filter((style) => style.multiInputMode === 'single');
    const originalUploadStyles = styles.filter((style) => style.continuationSourceMode === 'original-upload');
    const rules: string[] = [];

    if (imageRequiredStyles.length > 0) {
        rules.push(`- 这些风格必须有源图片：${imageRequiredStyles.map((style) => style.id).join('、')}。如果当前会话找不到最近一次生成或上传的相关图片，立即停止并请用户先上传一张；不要用纯文字猜测场景，也不要启动图片工具。`);
    }
    if (singleImageStyles.length > 0) {
        rules.push(`- 这些风格一次只能处理一张源图片：${singleImageStyles.map((style) => style.id).join('、')}。存在多张候选素材时按顺序逐张独立处理；每个结果只绑定当前对应的一张素材，禁止把多张素材共同输入同一次生成、拼图或混合场景。`);
    }
    if (originalUploadStyles.length > 0) {
        rules.push(`- 这些风格必须复用当前批次最初的用户上传源图：${originalUploadStyles.map((style) => style.id).join('、')}。原始上传图优先于当前会话中的已生成结果；除非用户明确要求把某张生成图作为新源图，否则禁止把已经合成的海报或风格化结果再次当作源图，以免裁切、比例和风格误差逐轮累积。如果找不到原始上传图，立即停止并请用户重新上传。`);
    }

    return rules;
}

export function getImageAgentStylesForAgent(agent: Pick<AgentLauncher, 'imageStyleIds'>, customStyles: UserImageStyle[] = []): ImageAgentStylePreset[] {
    const ids = agent.imageStyleIds ?? [];
    const selected = resolveUniqueImageAgentStyles(ids, customStyles);
    return selected.length > 0 ? selected : IMAGE_AGENT_STYLE_PRESETS;
}

export function getImageAgentStyleOptionsForAgent(agent: Pick<AgentLauncher, 'imageStyleIds'>, customStyles: UserImageStyle[] = []): ImageAgentStylePreset[] {
    const builtinStyles = getImageAgentStylesForAgent(agent, []);
    return [
        ...getUserStylePresets(customStyles),
        ...builtinStyles,
    ];
}

export function normalizeImageAgentVariantCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_IMAGE_AGENT_VARIANTS_PER_STYLE;
    return Math.max(MIN_IMAGE_AGENT_VARIANTS_PER_STYLE, Math.min(MAX_IMAGE_AGENT_VARIANTS_PER_STYLE, Math.floor(value)));
}

export function getImageAgentVariantCount(agent: Pick<AgentLauncher, 'imageVariantsPerStyle'>): number {
    return normalizeImageAgentVariantCount(agent.imageVariantsPerStyle);
}

export function buildImageAgentPrompt(args: {
    agent: AgentLauncher;
    customStyles?: UserImageStyle[];
    userPrompt: string;
    imageCount: number;
    styleReferenceImageCount?: number;
    userImageCount?: number;
}): string {
    const styles = getImageAgentStylesForAgent(args.agent, args.customStyles);
    const sourceImageCount = args.userImageCount ?? args.imageCount;
    const imageRequiredStyles = styles.filter((style) => style.inputMode === 'image-required');
    if (sourceImageCount === 0 && imageRequiredStyles.length > 0) {
        return `暂不执行图片任务。请先上传一张源照片，再使用这些必须以图片为输入的风格：${imageRequiredStyles.map((style) => style.id).join('、')}。不要改用纯文字猜测场景，也不要启动生成式或确定性图片工具。`;
    }
    const variants = getImageAgentVariantCount(args.agent);
    const batchSourceCount = Math.max(1, sourceImageCount);
    const expectedOutputCount = batchSourceCount * styles.length * variants;
    const userPrompt = args.userPrompt.trim() || '请把上传的参考图作为主体参考，生成一组可复用的风格效果总览。';
    const styleList = styles.map((style, index) => [
        `${index + 1}. ${style.id} (${style.templateRef}; engine=${style.executionKind ?? 'gpt-image-2'}) - ${getImageAgentStyleLabel(style)}: ${getImageAgentStylePromptHint(style)}`,
        style.promptContent,
    ].filter(Boolean).join('\n')).join('\n');
    const recommendedOptions = getRecommendedContinuationStyles(styles)
        .map((style) => `<option>[[gpt-image-style:${style.id}]] ${getImageAgentStyleLabel(style)}</option>`)
        .join('\n');
    const responseInstructions = getImageAgentResponseInstructions(styles);

    const styleReferenceImageCount = args.styleReferenceImageCount ?? 0;
    const userImageCount = args.userImageCount ?? args.imageCount;
    const inputLine = styleReferenceImageCount > 0
        ? `输入：已上传 ${args.imageCount} 张图片。其中前 ${styleReferenceImageCount} 张是自定义风格的临时参考图，只用于提取风格；后 ${userImageCount} 张是本次用户素材，并按附件顺序编号。`
        : `输入：已上传 ${args.imageCount} 张参考图，均为本次用户素材，并按附件顺序编号。`;
    const batchMatrixLine = sourceImageCount > 0
        ? `- 批次矩阵：源素材 ${sourceImageCount} 张 × 风格 ${styles.length} 个 × 每风格变体 ${variants} 张 = 预计输出总数 ${expectedOutputCount} 张。`
        : `- 批次矩阵：文字任务 1 组 × 风格 ${styles.length} 个 × 每风格变体 ${variants} 张 = 预计输出总数 ${expectedOutputCount} 张。`;
    const multiSourceRules = sourceImageCount > 1
        ? [
            '- 按用户素材顺序逐张遍历，再遍历全部选中风格与变体；自动完成整个笛卡尔积，不要逐张向用户确认。',
            '- 每个结果只能使用当前对应的 1 张用户素材作为源图片；自定义风格参考图仍只承担风格角色。禁止把多张用户素材拼图、混合或共同输入同一次图片生成。',
        ]
        : [];

    return [
        getImageAgentExecutionLead(styles),
        '',
        '生成锁：',
        '- 将这次请求视为一个已锁定的图片生成任务。这个锁只用于避免并发图片任务，不限制多风格或多图片输出。',
        '- 在每个选中风格的输出都保存完成，或任务明确失败之前，不要启动第二个批处理。',
        '- 如果当前会话里已经有另一个图片生成任务在运行，请报告图片生成器已被锁定，不要重复启动新的任务。',
        '',
        ...getImageAgentFirstRequestRules(styles),
        '',
        ...getImageAgentMixedEngineRules(styles),
        '',
        inputLine,
        styleReferenceImageCount > 0 ? '自定义风格规则：先分析前面的临时风格参考图，抽取可复用的视觉风格，再应用到本次用户素材或用户描述；不要把风格参考图里的主体误替换成本次主体。Prompt 已提炼完成的自定义风格会直接出现在风格清单里，不需要额外参考图。' : '',
        `用户目标：${userPrompt}`,
        '',
        '输出要求：',
        batchMatrixLine,
        ...multiSourceRules,
        `- 对下面每个选中的风格，各生成 ${variants} 张变体。`,
        '- 生成型风格将 prompt 保存到 garden-gpt-image-2/prompt/、图片保存到 garden-gpt-image-2/image/；deterministic-grade 风格按其 Skill 输出契约保存无损图片、版本化 recipe、质量报告和对比图。',
        '- 为本次批处理生成一个稳定 batchId（例如 gpt-image-2-YYYYMMDD-HHMMSS），同一批所有图片都使用这个 batchId。',
        '- 每完成 1 张就立即调用 mcp__happy__send_image 内联发送，再继续下一个组合；传入本张图片对应的绝对本地路径、完整 prompt 和 batchId。不要对本地文件使用 Markdown 图片语法。',
        `- 不要等 ${expectedOutputCount} 张全部完成后再集中发送；客户端需要用同一个 batchId 增量展示进度。`,
        '- 如果切到 native / 宿主图像工具，工具可能会把 PNG/JPEG 先保存到 ~/.codex/generated_images/<任务 id>/；生成后必须用 find/ls 确认实际文件，复制一份到 garden-gpt-image-2/image/，再调用 mcp__happy__send_image。不要在未检查该目录前声称“没有本地路径”或“无法返回”。',
        '- 不要在对话里展示生成过程、命令输出、完整 prompt 或路径清单。',
        `- 最终回复：${responseInstructions}`,
        '- 最终回复末尾附上下面这些 GPT Image Gallery 推荐选项，保持 option 内容原样，不要改写 style id；客户端会把它们渲染成可多选风格推荐。',
        '',
        '已选择的 GPT Image 2 风格：',
        styleList,
        '',
        '推荐续生成选项：',
        '<options>',
        recommendedOptions,
        '</options>',
    ].join('\n');
}

function getRecommendedContinuationStyles(styles: ImageAgentStylePreset[]): ImageAgentStylePreset[] {
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

    return ordered.slice(0, MAX_RECOMMENDED_CONTINUATION_STYLES);
}
