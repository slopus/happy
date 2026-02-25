import { parseMarkdownBlock } from "./parseMarkdownBlock"

/**
 * Strip XML system tags injected by Claude Code (e.g. <system-reminder>...</system-reminder>).
 * Code blocks are protected so legitimate tag content inside ``` fences is preserved.
 * Unclosed tags are left as-is (safe side).
 */
export function stripSystemTags(markdown: string): string {
    // 1. Protect code blocks by replacing them with placeholders
    const codeBlocks: string[] = [];
    const withPlaceholders = markdown.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return `\0CODEBLOCK_${codeBlocks.length - 1}\0`;
    });

    // 2. Remove <system-*>...</system-*> tags (multiline, non-greedy)
    const stripped = withPlaceholders.replace(/<system-\w+>[\s\S]*?<\/system-\w+>/g, '');

    // 3. Restore code blocks
    const restored = stripped.replace(/\0CODEBLOCK_(\d+)\0/g, (_, index) => {
        return codeBlocks[parseInt(index, 10)];
    });

    // 4. Collapse excessive blank lines (3+ newlines → 2)
    return restored.replace(/\n{3,}/g, '\n\n').trim();
}

export type MarkdownBlock = {
    type: 'text'
    content: MarkdownSpan[]
} | {
    type: 'header'
    level: 1 | 2 | 3 | 4 | 5 | 6
    content: MarkdownSpan[]
} | {
    type: 'list',
    items: MarkdownSpan[][]
} | {
    type: 'numbered-list',
    items: { number: number, spans: MarkdownSpan[] }[]
} | {
    type: 'code-block',
    language: string | null,
    content: string
} | {
    type: 'mermaid',
    content: string
} | {
    type: 'horizontal-rule'
} | {
    type: 'options',
    items: string[]
} | {
    type: 'table',
    headers: string[],
    rows: string[][]
}

export type MarkdownSpan = {
    styles: ('italic' | 'bold' | 'semibold' | 'code')[],
    text: string,
    url: string | null
}

export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(stripSystemTags(markdown));
}