import type { ModeOption } from './modelModeOptions';

const families = [
    ['GPT', /^(?:gpt(?:[- ._0-9]|$)|chatgpt|openai$|o[134](?:[- ._]|$))/i],
    ['Gemini', /^(?:gemini|google$)/i],
    ['Claude Code', /^(?:claude|anthropic$|opus(?:[- ._]|$)|sonnet(?:[- ._]|$)|haiku(?:[- ._]|$))/i],
    ['DeepSeek', /^deepseek/i],
    ['GLM', /^(?:glm(?:[- ._0-9]|$)|z-ai$|zhipu)/i],
    ['Kimi', /^(?:kimi(?:[- ._0-9]|$)|moonshot)/i],
    ['Qwen', /^(?:qwen|alibaba$)/i],
    ['Grok', /^(?:grok|x-ai$|xai$)/i],
    ['MiniMax', /^minimax/i],
    ['Mistral', /^(?:mistral|codestral)/i],
] as const;

// Strip the picker-only connection prefix. Prefer the model ID/author over
// the gateway name (e.g. openrouter/anthropic/... belongs to Claude).
function getFamily(option: ModeOption): string {
    const id = option.key.split('::').at(-1)!;
    if (id.startsWith('group/') || id === 'default') return 'automatic';
    const path = id.split('/');
    for (const part of [path.at(-1)!, path.length > 2 ? path.at(-2)! : '', option.name.split(' · ')[0]]) {
        const match = families.find(([, pattern]) => pattern.test(part));
        if (match) return match[0];
    }
    // Magpie routes with an explicit upstream namespace can use it as a heading.
    return path.length > 2 ? path.at(-2)! : 'other';
}

export function groupComposerModels(options: ModeOption[], search: string, formatName: (name: string) => string) {
    const query = search.trim().toLocaleLowerCase();
    const groups = new Map<string, ModeOption[]>();
    for (const option of options) {
        const family = getFamily(option);
        if (!`${family} ${option.key} ${option.name} ${formatName(option.name)} ${option.description ?? ''} ${option.connectionLabel ?? ''}`
            .toLocaleLowerCase().includes(query)) continue;
        const entries = groups.get(family);
        if (entries) entries.push(option);
        else groups.set(family, [option]);
    }
    const order = [...families.map(([name]) => name), 'automatic'];
    return [...groups].sort(([left], [right]) => {
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        if (leftIndex >= 0 || rightIndex >= 0) {
            return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex);
        }
        if (left === 'other' || right === 'other') return left === 'other' ? 1 : -1;
        return left.localeCompare(right);
    });
}
