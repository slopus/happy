import type { MarkdownSpan } from "./parseMarkdown";

// Updated pattern to handle nested markdown and asterisks
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))/g;

// Split text that may contain [MM:SS] or `[MM:SS]` timestamps into spans
function splitTimestamps(text: string, styles: MarkdownSpan['styles']): MarkdownSpan[] {
    const tsPattern = /`?\[(\d{1,2}:\d{2}(?::\d{2})?)\]`?/g;
    const result: MarkdownSpan[] = [];
    let last = 0;
    let m;
    while ((m = tsPattern.exec(text)) !== null) {
        if (m.index > last) {
            result.push({ styles, text: text.slice(last, m.index), url: null });
        }
        const parts = m[1].split(':').map(Number);
        const seconds = parts.length === 3
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : parts[0] * 60 + parts[1];
        result.push({ styles: [], text: `[${m[1]}]`, url: `timestamp:${seconds}` });
        last = tsPattern.lastIndex;
    }
    if (last < text.length) {
        result.push({ styles, text: text.slice(last), url: null });
    }
    return result;
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            spans.push(...splitTimestamps(plainText, []));
        }

        if (match[1]) {
            // Bold — also check for embedded timestamps
            if (header) {
                spans.push(...splitTimestamps(match[2], []));
            } else {
                spans.push(...splitTimestamps(match[2], ['bold']));
            }
        } else if (match[3]) {
            // Italic — also check for embedded timestamps
            if (header) {
                spans.push(...splitTimestamps(match[4], []));
            } else {
                spans.push(...splitTimestamps(match[4], ['italic']));
            }
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            if (match[7]) {
                spans.push({ styles: [], text: match[6], url: match[7] });
            } else {
                // Check if it's a timestamp like [00:05] or [1:23:45]
                const tsMatch = match[6].match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
                if (tsMatch) {
                    const seconds = tsMatch[3]
                        ? parseInt(tsMatch[1]) * 3600 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3])
                        : parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2]);
                    spans.push({ styles: [], text: `[${match[6]}]`, url: `timestamp:${seconds}` });
                } else {
                    // If no URL part, treat as plain text with brackets
                    spans.push({ styles: [], text: `[${match[6]}]`, url: null });
                }
            }
        } else if (match[8]) {
            // Inline code — check if it's a timestamp like `[00:05]` or `00:05`
            const codeText = match[9];
            const bracketTs = codeText.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]$/);
            const bareTs = codeText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
            if (bracketTs) {
                const parts = bracketTs[1].split(':').map(Number);
                const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
                spans.push({ styles: [], text: `[${bracketTs[1]}]`, url: `timestamp:${secs}` });
            } else if (bareTs) {
                const secs = bareTs[3] ? parseInt(bareTs[1]) * 3600 + parseInt(bareTs[2]) * 60 + parseInt(bareTs[3]) : parseInt(bareTs[1]) * 60 + parseInt(bareTs[2]);
                spans.push({ styles: [], text: `[${codeText}]`, url: `timestamp:${secs}` });
            } else {
                spans.push({ styles: ['code'], text: codeText, url: null });
            }
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        spans.push(...splitTimestamps(markdown.slice(lastIndex), []));
    }

    return spans;
}