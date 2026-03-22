import type { MarkdownSpan } from "./parseMarkdown";

// Supports bold/italic/code and markdown links.
// Link URL pattern allows balanced single-level parentheses inside URLs
// so paths like /(app)/session/[id]/file.tsx are parsed correctly.
const patternSource = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(((?:[^()]+|\([^()]*\))*)\))?)|(`(.*?)(?:`|$))/g.source;

function normalizeMarkdownLinkUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    // CommonMark supports angle-bracket link destinations: [text](<url>)
    if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    return parseMarkdownSpansWithInheritedStyles(markdown, header, []);
}

function parseMarkdownSpansWithInheritedStyles(markdown: string, header: boolean, inheritedStyles: MarkdownSpan['styles']): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const pattern = new RegExp(patternSource, 'g');

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            spans.push({ styles: [...inheritedStyles], text: plainText, url: null });
        }

        if (match[1]) {
            // Bold
            if (header) {
                spans.push(...parseMarkdownSpansWithInheritedStyles(match[2], header, inheritedStyles));
            } else {
                spans.push(...parseMarkdownSpansWithInheritedStyles(match[2], header, [...inheritedStyles, 'bold']));
            }
        } else if (match[3]) {
            // Italic
            if (header) {
                spans.push(...parseMarkdownSpansWithInheritedStyles(match[4], header, inheritedStyles));
            } else {
                spans.push(...parseMarkdownSpansWithInheritedStyles(match[4], header, [...inheritedStyles, 'italic']));
            }
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            if (match[7]) {
                const normalizedUrl = normalizeMarkdownLinkUrl(match[7]);
                if (normalizedUrl) {
                    spans.push({ styles: [...inheritedStyles], text: match[6], url: normalizedUrl });
                } else {
                    spans.push({ styles: [...inheritedStyles], text: `[${match[6]}]`, url: null });
                }
            } else {
                // If no URL part, treat as plain text with brackets
                spans.push({ styles: [...inheritedStyles], text: `[${match[6]}]`, url: null });
            }
        } else if (match[8]) {
            // Inline code
            spans.push({ styles: [...inheritedStyles, 'code'], text: match[9], url: null });
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        spans.push({ styles: [...inheritedStyles], text: markdown.slice(lastIndex), url: null });
    }

    return spans;
}
