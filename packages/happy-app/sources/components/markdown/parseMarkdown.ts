import { parseMarkdownBlock } from "./parseMarkdownBlock"

export type MarkdownBlock = {
    type: 'text'
    content: MarkdownSpan[]
} | {
    type: 'header'
    level: 1 | 2 | 3 | 4 | 5 | 6
    content: MarkdownSpan[]
} | {
    type: 'list',
    items: { depth: number, spans: MarkdownSpan[] }[]
} | {
    type: 'numbered-list',
    items: { number: number, depth: number, spans: MarkdownSpan[] }[]
} | {
    type: 'code-block',
    language: string | null,
    content: string
} | {
    type: 'mermaid',
    content: string
} | {
    // Display (block) LaTeX math: `$$ ... $$` or `\[ ... \]`
    type: 'math',
    content: string
} | {
    type: 'horizontal-rule'
} | {
    type: 'options',
    items: string[]
} | {
    type: 'table',
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][]
} | {
    type: 'image',
    alt: string,
    url: string
}

export type MarkdownSpan = {
    styles: ('italic' | 'bold' | 'semibold' | 'code')[],
    text: string,
    url: string | null,
    // When true, `text` holds raw LaTeX to render as inline math (KaTeX). Inline
    // math always renders in inline mode — an inline `$$…$$` still flows with the
    // text rather than breaking out as a centered block.
    math?: boolean
}

export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}
