export type PageContext = {
    title: string;
    url: string;
    selection: string;
};

const MAX_SELECTION_LENGTH = 6_000;

export function composePrompt(message: string, context: PageContext | null, includeContext: boolean): string {
    const prompt = message.trim();
    if (!includeContext || !context) return prompt;
    const selection = normalizeWhitespace(context.selection).slice(0, MAX_SELECTION_LENGTH);
    const lines = [prompt, '', '网页上下文：', `- 标题：${context.title.trim()}`, `- URL：${context.url.trim()}`];
    if (selection) lines.push('', '选中内容：', selection);
    return lines.join('\n');
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
