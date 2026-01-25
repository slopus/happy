import type { MarkdownSpan } from "./parseMarkdown";

// Updated pattern to handle nested markdown and asterisks
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))/g;

// URL pattern for detecting bare URLs in plain text
// Matches http:// or https:// URLs, handling parentheses properly and avoiding trailing punctuation
const urlPattern = /(https?:\/\/[^\s<>\[\]]+(?:\([^\s<>\[\]]*\)|[^\s<>\[\](),.:;!?'">\])]+)*)/gi;

/**
 * Splits plain text to detect and extract bare URLs
 * Returns an array of spans where URLs have the url property set
 */
function splitTextWithUrls(text: string, styles: MarkdownSpan['styles']): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    // Reset regex state
    urlPattern.lastIndex = 0;

    while ((match = urlPattern.exec(text)) !== null) {
        // Add text before the URL
        if (match.index > lastIndex) {
            spans.push({ styles: [...styles], text: text.slice(lastIndex, match.index), url: null });
        }

        // Add the URL as a link
        const url = match[1];
        spans.push({ styles: [...styles], text: url, url: url });

        lastIndex = urlPattern.lastIndex;
    }

    // Add remaining text after last URL
    if (lastIndex < text.length) {
        spans.push({ styles: [...styles], text: text.slice(lastIndex), url: null });
    }

    return spans;
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            // Check for bare URLs in plain text
            const textSpans = splitTextWithUrls(plainText, []);
            spans.push(...textSpans);
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
        const remainingText = markdown.slice(lastIndex);
        // Check for bare URLs in remaining text
        const textSpans = splitTextWithUrls(remainingText, []);
        spans.push(...textSpans);
    }

    return spans;
}