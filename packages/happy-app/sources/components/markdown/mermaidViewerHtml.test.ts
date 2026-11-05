import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { jsLiteral, mermaidViewerHtml } from './mermaidViewerHtml';

// Diagram text arrives from chat, so it can say anything. This one ends the
// viewer's inline script, starts a second script and leaves an HTML comment open.
const HOSTILE = 'graph TD\n  A[start] --> B[end]\n</script><script>window.__x=1</script><!--';

const AWKWARD: Array<[string, string]> = [
    ['a closing script tag', '</script>'],
    ['a closing script tag in capitals', '</SCRIPT>'],
    ['a closing script tag followed by a space', '</script >'],
    ['a closing script tag with a slash', '</script/>'],
    ['an HTML comment around a script', '<!--<script>'],
    ['an HTML comment end', '-->'],
    ['both line separators', 'a\u2028b\u2029c'],
    ['quotes and backslashes', 'say "hi" \\ \\" \\n'],
    ['text that already looks like an escape', '\\u003c/script>'],
    ['an empty diagram', ''],
    ['characters outside the BMP', 'node \u{1F600} e\u0301'],
];

// An HTML tokenizer ends a script element at `</script` followed by whitespace,
// `/` or `>`, and `<!--` changes how it looks for that end.
const SCRIPT_OPEN = /<script[\s/>]/gi;
const SCRIPT_CLOSE = /<\/script[\s/>]/gi;

function count(text: string, pattern: RegExp): number {
    return (text.match(pattern) ?? []).length;
}

// The string literal the page hands to `mermaid.render`, exactly as the HTML source spells it.
function embeddedLiteral(html: string): string {
    const marker = "mermaid.render('m',";
    const markerAt = html.indexOf(marker);
    if (markerAt < 0) throw new Error(`the page no longer contains ${marker}`);
    const open = markerAt + marker.length;
    if (html[open] !== '"') throw new Error('the diagram is not embedded as a string literal');
    let end = open + 1;
    while (end < html.length && html[end] !== '"') {
        end += html[end] === '\\' ? 2 : 1;
    }
    return html.slice(open, end + 1);
}

// What a JS engine makes of the literal, which is what the page's script receives.
function evaluate(literal: string): unknown {
    return runInNewContext(literal);
}

describe('jsLiteral', () => {
    it.each(AWKWARD)('gives the same text back for %s', (_name, text) => {
        const literal = jsLiteral(text);

        expect(JSON.parse(literal)).toBe(text);
        expect(evaluate(literal)).toBe(text);
    });

    it.each(AWKWARD)('leaves nothing for the HTML tokenizer or an old JS engine to act on in %s', (_name, text) => {
        const literal = jsLiteral(text);

        expect(literal).not.toContain('<');
        expect(literal).not.toMatch(/[\u2028\u2029]/);
    });

    it('is plain JSON.stringify for text that needs no escaping', () => {
        const text = 'sequenceDiagram\n  A->>B: "hi"';

        expect(jsLiteral(text)).toBe(JSON.stringify(text));
    });
});

describe('mermaidViewerHtml', () => {
    const ordinary = mermaidViewerHtml('graph TD\n  A --> B');

    it('has the mermaid script tag, its own script and no HTML comment', () => {
        // Every other diagram has to match these counts.
        expect(count(ordinary, SCRIPT_OPEN)).toBe(2);
        expect(count(ordinary, SCRIPT_CLOSE)).toBe(2);
        expect(ordinary).not.toContain('<!--');
    });

    it('keeps diagram text that closes the script element inside the script', () => {
        // The premise: a bare JSON.stringify would let this text end the script element.
        expect(JSON.stringify(HOSTILE)).toContain('</script>');

        const html = mermaidViewerHtml(HOSTILE);

        expect(count(html, SCRIPT_OPEN)).toBe(count(ordinary, SCRIPT_OPEN));
        expect(count(html, SCRIPT_CLOSE)).toBe(count(ordinary, SCRIPT_CLOSE));
        expect(html).not.toContain('<!--');

        // The first closing tag after the inline script opens is the template's own,
        // and it comes after the whole diagram.
        const literal = embeddedLiteral(html);
        const inlineScriptAt = html.indexOf('<script>');
        expect(inlineScriptAt).toBeGreaterThan(-1);
        const firstClose = html.indexOf('</script', inlineScriptAt);
        expect(firstClose).toBeGreaterThan(html.indexOf(literal) + literal.length);
        expect(firstClose).toBe(html.lastIndexOf('</script'));
    });

    it('hands the page the diagram text unchanged', () => {
        const literal = embeddedLiteral(mermaidViewerHtml(HOSTILE));

        expect(JSON.parse(literal)).toBe(HOSTILE);
        expect(evaluate(literal)).toBe(HOSTILE);
    });

    it.each(AWKWARD)('adds no script element or comment for %s', (_name, text) => {
        const html = mermaidViewerHtml(text);

        expect(count(html, SCRIPT_OPEN)).toBe(count(ordinary, SCRIPT_OPEN));
        expect(count(html, SCRIPT_CLOSE)).toBe(count(ordinary, SCRIPT_CLOSE));
        expect(html).not.toContain('<!--');
        expect(evaluate(embeddedLiteral(html))).toBe(text);
    });
});
