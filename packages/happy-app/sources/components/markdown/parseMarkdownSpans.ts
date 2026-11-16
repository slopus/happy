import type { MarkdownSpan } from "./parseMarkdown";

const spanPattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\((<[^>\r\n]+>|[^)]+)\))?)|(`(.*?)(?:`|$))/g;
// Within emphasis, preserve bare URLs before interpreting their query characters.
const emphasisPattern = new RegExp(spanPattern.source + '|(https?://[^\\s<]+)', spanPattern.flags);

function pushTextWithAutoLinks(spans: MarkdownSpan[], text: string, styles: MarkdownSpan['styles']) {
    const urlPattern = /https?:\/\/[^\s<]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(text)) !== null) {
        const plainText = text.slice(lastIndex, match.index);
        if (plainText) {
            spans.push({ styles, text: plainText, url: null });
        }

        let url = match[0];
        let trailing = '';
        while (/[),.;:!?]$/.test(url)) {
            trailing = url.slice(-1) + trailing;
            url = url.slice(0, -1);
        }

        if (url) {
            spans.push({ styles, text: url, url });
        }
        if (trailing) {
            spans.push({ styles, text: trailing, url: null });
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        spans.push({ styles, text: text.slice(lastIndex), url: null });
    }
}

function pushFormattedSpans(spans: MarkdownSpan[], markdown: string, styles: MarkdownSpan['styles'], header: boolean) {
    for (const span of parseSpans(markdown, header, emphasisPattern)) {
        spans.push({ ...span, styles: [...new Set([...styles, ...span.styles])] });
    }
}

export function parseMarkdownSpans(markdown: string, header: boolean): MarkdownSpan[] {
    return parseSpans(markdown, header, spanPattern);
}

function parseSpans(markdown: string, header: boolean, tokenPattern: RegExp): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    // Each recursive emphasis parse owns its cursor, preserving the outer scan.
    const pattern = new RegExp(tokenPattern);

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            pushTextWithAutoLinks(spans, plainText, []);
        }

        if (match[1]) {
            pushFormattedSpans(spans, match[2], header ? [] : ['bold'], header);
        } else if (match[3]) {
            pushFormattedSpans(spans, match[4], header ? [] : ['italic'], header);
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            if (match[7]) {
                const destination = match[7];
                const url = destination.startsWith('<') && destination.endsWith('>') ? destination.slice(1, -1) : destination;
                spans.push({ styles: [], text: match[6], url });
            } else {
                // If no URL part, treat as plain text with brackets
                pushTextWithAutoLinks(spans, `[${match[6]}]`, []);
            }
        } else if (match[8]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[9], url: null });
        } else if (match[10]) {
            pushTextWithAutoLinks(spans, match[10], []);
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        pushTextWithAutoLinks(spans, markdown.slice(lastIndex), []);
    }

    return spans;
}
