import type { MarkdownSpan } from "./parseMarkdown";

// Single-pass inline tokenizer. Math delimiters lead the alternation so
// `$$…$$` / `\[…\]` / `\(…\)` / `$…$` are recognized before markdown styling.
// Because this is ONE left-to-right scan, a `` `code` `` or `[link](url)` region
// is consumed as a single unit — so a `$` *inside* code or link text is never
// mistaken for a math delimiter (the way a separate math pre-pass would).
// Math bodies are length-capped ({1,1000}) so an unclosed `\(`/`\[`/`$$` on a
// pathological single line fails fast instead of lazily scanning to end-of-line
// at every opener (that would be O(n²) UI-thread work — inline math is short).
// A bare `http(s)://…` URL is a leading-consumed alternative too, so a `$` inside
// a URL stays part of the URL rather than opening an equation.
const pattern = /(\$\$([\s\S]{1,1000}?)\$\$)|(\\\[([\s\S]{1,1000}?)\\\])|(\\\(([\s\S]{1,1000}?)\\\))|(\$([^$\n]{1,1000}?)\$)|(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))|(https?:\/\/[^\s<]+)/g;

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

// A `$` is escaped only when preceded by an ODD number of backslashes, so a
// literal `\\` before real math (`\\$x$`) isn't misread as an escaped dollar.
function isEscapedDollar(markdown: string, index: number): boolean {
    let count = 0;
    for (let i = index - 1; i >= 0 && markdown[i] === '\\'; i--) count++;
    return count % 2 === 1;
}

// A `$…$` candidate is prose/currency, not math, when: the `$` is escaped, the
// content opens or closes on whitespace ("$ x$", "$x $" — the latter is what
// rejects "$5 and $10"), or a bare-number content abuts a following digit
// ("$5$5"). A digit after non-numeric content (e.g. "$x$2") is left as math.
function isCurrencyLike(markdown: string, match: RegExpExecArray): boolean {
    const content = match[8];
    const after = markdown[match.index + match[0].length];
    return (
        isEscapedDollar(markdown, match.index) ||
        /\s/.test(content[0]) ||
        /\s/.test(content[content.length - 1]) ||
        (after !== undefined && /\d/.test(after) && /^[\d.,]/.test(content))
    );
}

export function parseMarkdownSpans(markdown: string, header: boolean, enableMath: boolean = true): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(markdown)) !== null) {
        // Math rendering disabled: leave `$$…$$` / `\[…\]` / `\(…\)` / `$…$`
        // as literal text by skipping the match without advancing lastIndex, so
        // the delimiters fold into the surrounding plain text (upstream behavior).
        if (!enableMath && (match[1] !== undefined || match[3] !== undefined || match[5] !== undefined || match[7] !== undefined)) {
            continue;
        }

        // Reject a `$…$` currency/escape candidate and rewind one char past its
        // opening `$`, so the candidate's CLOSING `$` can still open a following
        // real equation ("You owe $5 but $x$" → text "$5" + math "x").
        if (match[7] !== undefined && isCurrencyLike(markdown, match)) {
            pattern.lastIndex = match.index + 1;
            continue;
        }

        // Text between the previous accepted match and this one (rejected
        // currency candidates fold into this plain text, since lastIndex only
        // advances on accepted matches).
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            pushTextWithAutoLinks(spans, plainText, []);
        }

        if (match[1] !== undefined) {
            spans.push({ styles: [], text: match[2].trim(), url: null, math: true }); // $$…$$
        } else if (match[3] !== undefined) {
            spans.push({ styles: [], text: match[4].trim(), url: null, math: true }); // \[…\]
        } else if (match[5] !== undefined) {
            spans.push({ styles: [], text: match[6].trim(), url: null, math: true }); // \(…\)
        } else if (match[7] !== undefined) {
            spans.push({ styles: [], text: match[8].trim(), url: null, math: true }); // $…$
        } else if (match[9]) {
            // Bold (stripped to plain in headers)
            pushTextWithAutoLinks(spans, match[10], header ? [] : ['bold']);
        } else if (match[11]) {
            // Italic (stripped to plain in headers)
            pushTextWithAutoLinks(spans, match[12], header ? [] : ['italic']);
        } else if (match[13]) {
            // Link — handle incomplete links (no URL part)
            if (match[15]) {
                spans.push({ styles: [], text: match[14], url: match[15] });
            } else {
                pushTextWithAutoLinks(spans, `[${match[14]}]`, []);
            }
        } else if (match[16]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[17], url: null });
        } else if (match[18]) {
            // Bare autolink — consumed as a unit so an interior `$` isn't math.
            // Reuse the autolink helper for trailing-punctuation trimming.
            pushTextWithAutoLinks(spans, match[18], []);
        }

        lastIndex = pattern.lastIndex;
    }

    // Any text remaining after the last match is plain
    if (lastIndex < markdown.length) {
        pushTextWithAutoLinks(spans, markdown.slice(lastIndex), []);
    }

    return spans;
}
