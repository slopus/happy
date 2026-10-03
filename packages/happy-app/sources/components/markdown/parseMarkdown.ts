import { parseMarkdownBlock } from "./parseMarkdownBlock"
import type { SessionOtaPreview } from '@/utils/sessionOtaPreviews';
import type { SessionFinanceChart } from '@/utils/sessionFinanceCharts';

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
} | {
    type: 'ota-preview',
    preview: SessionOtaPreview
} | {
    type: 'finance-chart',
    chart: SessionFinanceChart
}

export type MarkdownSpan = {
    styles: ('italic' | 'bold' | 'semibold' | 'code')[],
    text: string,
    url: string | null
}

export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}

/** External history is inert: keep formatting without network images or actionable Paws cards. */
export function parseReadOnlyMarkdown(markdown: string): MarkdownBlock[] {
    return parseMarkdown(markdown).map(block => {
        switch (block.type) {
            case 'text': case 'header': case 'list': case 'numbered-list': case 'code-block': case 'horizontal-rule': case 'table':
                return block;
            case 'image': return { type: 'text', content: [{ text: `![${block.alt}](${block.url})`, styles: [], url: null }] };
            case 'mermaid': return { type: 'code-block', language: 'mermaid', content: block.content };
            case 'options': return { type: 'text', content: [{ text: block.items.join('\n'), styles: [], url: null }] };
            case 'ota-preview': return { type: 'code-block', language: null, content: JSON.stringify(block.preview, null, 2) };
            case 'finance-chart': return { type: 'code-block', language: null, content: JSON.stringify(block.chart, null, 2) };
        }
    });
}
