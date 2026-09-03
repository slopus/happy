import {
    IMAGE_AGENT_STYLE_PRESETS,
    getImageAgentStyleCategoryLabel,
    getImageAgentStyleLabel,
    getImageAgentStylePromptHint,
    normalizeImageAgentVariantCount,
    type ImageAgentStylePreset,
} from './imageAgentPrompt';
import type { AgentLauncher } from './launchAgent';

export const IMAGE_STYLE_MODE_PARAM = 'image-styles';
export const IMAGE_STYLE_COMPOSE_ROUTE = `/new?mode=${IMAGE_STYLE_MODE_PARAM}`;
export const BUILTIN_IMAGE_STYLE_AGENT_ID = 'builtin-image-styles';

const DEFAULT_IMAGE_STYLE_IDS = IMAGE_AGENT_STYLE_PRESETS.map((style) => style.id);

function firstParam(value: unknown): string | null {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
    }
    return null;
}

export function isImageStyleComposeMode(routeMode: unknown): boolean {
    return firstParam(routeMode) === IMAGE_STYLE_MODE_PARAM;
}

export function createBuiltinImageStyleAgent(): AgentLauncher {
    return {
        id: BUILTIN_IMAGE_STYLE_AGENT_ID,
        name: 'Image Effects',
        glyph: 'P',
        color: '#8A5A2B',
        machineId: '',
        path: '~',
        presets: [],
        kind: 'image-styles',
        spaceType: 'default',
        imageStyleIds: DEFAULT_IMAGE_STYLE_IDS,
        imageVariantsPerStyle: 1,
    };
}

export function resolveComposeImageAgent(args: {
    routeMode: unknown;
    agent: AgentLauncher | null;
    imagePluginInstalled: boolean;
}): AgentLauncher | null {
    if (!args.imagePluginInstalled) {
        return null;
    }
    if (args.agent?.kind === 'image-styles') {
        return args.agent;
    }
    if (!args.agent && isImageStyleComposeMode(args.routeMode)) {
        return createBuiltinImageStyleAgent();
    }
    return null;
}

export function selectImageAgentStyle(agent: AgentLauncher, styleId: string): AgentLauncher {
    return {
        ...agent,
        imageStyleIds: [styleId],
    };
}

export function setImageAgentStyles(agent: AgentLauncher, styleIds: string[]): AgentLauncher {
    return {
        ...agent,
        imageStyleIds: [...new Set(styleIds)],
    };
}

export function setImageAgentVariantCount(agent: AgentLauncher, count: number): AgentLauncher {
    return {
        ...agent,
        imageVariantsPerStyle: normalizeImageAgentVariantCount(count),
    };
}

export function toggleImageAgentStyle(agent: AgentLauncher, styleId: string): AgentLauncher {
    const current = agent.imageStyleIds ?? [];
    const next = current.includes(styleId)
        ? current.filter((id) => id !== styleId)
        : [...current, styleId];
    return setImageAgentStyles(agent, next);
}

export function createImageStyleSelectionPrompt(style: ImageAgentStylePreset): string {
    return [
        '使用 $gpt-image-2 skill 生成或编辑图片，并以下面选中的 Image Effects 效果作为目标风格。',
        '',
        `已选择的 Image Effects 效果：${style.id}`,
        `效果标题：${getImageAgentStyleLabel(style)}`,
        `模板：${style.templateRef}`,
        `分类：${getImageAgentStyleCategoryLabel(style)}`,
        `风格说明：${getImageAgentStylePromptHint(style)}`,
        '',
        '除非我明确要求改变，否则请保留上传主体的身份特征、关键几何结构、重要文字，以及用户提供的所有约束。',
        '请把上面的效果规则转写成中文图像生成 prompt 后执行，不要在最终 prompt 中保留英文 JSON 字段名。',
    ].join('\n');
}
