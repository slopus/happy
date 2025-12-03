import type { MarkdownSpan } from "./parseMarkdown";

// Updated pattern to handle nested markdown and asterisks
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))/g;

// URL detection pattern - matches http://, https://, and www. URLs
const urlPattern = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/g;

// Helper function to split text into spans with URLs detected
function splitTextWithUrls(text: string): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    // Reset regex state
    urlPattern.lastIndex = 0;

    while ((match = urlPattern.exec(text)) !== null) {
        // Add text before the URL
        if (match.index > lastIndex) {
            spans.push({ styles: [], text: text.slice(lastIndex, match.index), url: null });
        }

        // Add the URL as a link
        let url = match[1];
        // Add https:// prefix if it starts with www.
        if (url.startsWith('www.')) {
            url = 'https://' + url;
        }
        spans.push({ styles: [], text: match[1], url });

        lastIndex = urlPattern.lastIndex;
    }

    // Add any remaining text
    if (lastIndex < text.length) {
        spans.push({ styles: [], text: text.slice(lastIndex), url: null });
    }

    return spans.length > 0 ? spans : [{ styles: [], text, url: null }];
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            // Split plain text to detect URLs
            spans.push(...splitTextWithUrls(plainText));
        }

        if (match[1]) {
            // Bold
            if (header) {
                spans.push({ styles: [], text: match[2], url: null });
            } else {
                spans.push({ styles: ['bold'], text: match[2], url: null });
            }
        } else if (match[3]) {
            // Italic
            if (header) {
                spans.push({ styles: [], text: match[4], url: null });
            } else {
                spans.push({ styles: ['italic'], text: match[4], url: null });
            }
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            if (match[7]) {
                spans.push({ styles: [], text: match[6], url: match[7] });
            } else {
                // If no URL part, treat as plain text with brackets
                spans.push({ styles: [], text: `[${match[6]}]`, url: null });
            }
        } else if (match[8]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[9], url: null });
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        // Split remaining text to detect URLs
        spans.push(...splitTextWithUrls(markdown.slice(lastIndex)));
    }

    return spans;
}