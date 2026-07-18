import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';
import { parseMarkdownSpans } from './parseMarkdownSpans';

describe('parseMarkdown — display (block) math', () => {
    it('parses a single-line $$ ... $$ display equation', () => {
        const blocks = parseMarkdown('$$ E = mc^2 $$');
        expect(blocks).toEqual([{ type: 'math', content: 'E = mc^2' }]);
    });

    it('parses a multi-line $$ block', () => {
        const blocks = parseMarkdown('$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$');
        expect(blocks).toEqual([{ type: 'math', content: '\\int_0^\\infty e^{-x}\\,dx = 1' }]);
    });

    it('parses a \\[ ... \\] display equation', () => {
        const blocks = parseMarkdown('\\[ a^2 + b^2 = c^2 \\]');
        expect(blocks).toEqual([{ type: 'math', content: 'a^2 + b^2 = c^2' }]);
    });

    it('keeps surrounding text as separate blocks', () => {
        const blocks = parseMarkdown('Before\n$$ x^2 $$\nAfter');
        expect(blocks.map(b => b.type)).toEqual(['text', 'math', 'text']);
        expect(blocks[1]).toEqual({ type: 'math', content: 'x^2' });
    });

    it('treats an unclosed $$ opener as plain text, not math', () => {
        const blocks = parseMarkdown('$$ x^2 + 1');
        expect(blocks.every(b => b.type !== 'math')).toBe(true);
        expect(blocks[0]?.type).toBe('text');
    });

    it('does not treat empty $$$$ as a math block', () => {
        const blocks = parseMarkdown('$$$$');
        expect(blocks.every(b => b.type !== 'math')).toBe(true);
    });
});

describe('parseMarkdownSpans — inline math', () => {
    const mathSpans = (md: string) => parseMarkdownSpans(md, false).filter(s => s.math);

    it('parses $ ... $ inline math', () => {
        const spans = parseMarkdownSpans('energy $E = mc^2$ here', false);
        expect(spans).toEqual([
            { styles: [], text: 'energy ', url: null },
            { styles: [], text: 'E = mc^2', url: null, math: true },
            { styles: [], text: ' here', url: null },
        ]);
    });

    it('parses \\( ... \\) inline math', () => {
        expect(mathSpans('the value \\(x_i\\) grows')).toEqual([
            { styles: [], text: 'x_i', url: null, math: true },
        ]);
    });

    it('parses inline $$ ... $$ as (inline) math', () => {
        expect(mathSpans('see $$\\sum_i x_i$$ inline')).toEqual([
            { styles: [], text: '\\sum_i x_i', url: null, math: true },
        ]);
    });

    it('does NOT treat currency as math', () => {
        expect(mathSpans('it costs $5 and $10 total')).toEqual([]);
    });

    it('does NOT treat an escaped \\$ as math', () => {
        expect(mathSpans('pay \\$5 or \\$10')).toEqual([]);
    });

    it('does not open math on a space after $', () => {
        expect(mathSpans('a $ b $ c')).toEqual([]);
    });

    it('keeps markdown styling in the non-math text segments', () => {
        const spans = parseMarkdownSpans('**bold** and $x$ and `code`', false);
        expect(spans).toEqual([
            { styles: ['bold'], text: 'bold', url: null },
            { styles: [], text: ' and ', url: null },
            { styles: [], text: 'x', url: null, math: true },
            { styles: [], text: ' and ', url: null },
            { styles: ['code'], text: 'code', url: null },
        ]);
    });

    it('does not parse markdown specials inside the math body', () => {
        // underscores / asterisks inside math must stay literal TeX
        expect(mathSpans('$a_i * b_j$')).toEqual([
            { styles: [], text: 'a_i * b_j', url: null, math: true },
        ]);
    });
});

// Regression tests for issues found in adversarial review (wf_bd22d030).
describe('parseMarkdownSpans — inline math edge cases', () => {
    const mathSpans = (md: string) => parseMarkdownSpans(md, false).filter(s => s.math);

    it('does NOT treat $…$ inside an inline code span as math', () => {
        const spans = parseMarkdownSpans('run `echo $x$ here` please', false);
        expect(spans.some(s => s.math)).toBe(false);
        expect(spans).toContainEqual({ styles: ['code'], text: 'echo $x$ here', url: null });
    });

    it('does NOT treat $…$ inside link text as math (link stays intact)', () => {
        const spans = parseMarkdownSpans('see [the $x$ page](https://example.com)', false);
        expect(spans.some(s => s.math)).toBe(false);
        expect(spans).toContainEqual({ styles: [], text: 'the $x$ page', url: 'https://example.com' });
    });

    it('recovers real math after a currency amount on the same line', () => {
        // The "$5" currency must not swallow the "$x$" equation's opening $
        expect(mathSpans('You owe $5 but $x$ remains')).toEqual([
            { styles: [], text: 'x', url: null, math: true },
        ]);
    });

    it('keeps math whose closing $ abuts a non-numeric-content digit', () => {
        // "$x$2" — content "x" is not numeric, so the trailing digit is not currency
        expect(mathSpans('the term $x$2 here')).toEqual([
            { styles: [], text: 'x', url: null, math: true },
        ]);
    });

    it('treats an escaped backslash before math as real math (backslash parity)', () => {
        // "\\$x$" — the $ is preceded by an even (2) run of backslashes → not escaped
        expect(mathSpans('path \\\\$x$ end')).toEqual([
            { styles: [], text: 'x', url: null, math: true },
        ]);
    });

    it('does NOT split a bare URL that contains paired $…$ into math', () => {
        const spans = parseMarkdownSpans('see https://ci.example.com/$BUILD_ID$/status now', false);
        expect(spans.some(s => s.math)).toBe(false);
        expect(spans).toContainEqual({ styles: [], text: 'https://ci.example.com/$BUILD_ID$/status', url: 'https://ci.example.com/$BUILD_ID$/status' });
    });

    it('does not hang on a pathological line of unclosed \\( openers (length-capped)', () => {
        // Correctness gate for the ReDoS cap: must return promptly, no math emitted.
        const spans = parseMarkdownSpans('\\('.repeat(20000), false);
        expect(spans.some(s => s.math)).toBe(false);
    });
});

describe('parseMarkdown — display math edge cases', () => {
    it('does not let an unclosed $$ swallow across a blank line into a later equation', () => {
        const blocks = parseMarkdown('$$ x^2\n\nmiddle\n\n$$ y^2 $$');
        // First $$ is unclosed within its paragraph → text; the later $$ y^2 $$ is math
        const math = blocks.filter(b => b.type === 'math');
        expect(math).toEqual([{ type: 'math', content: 'y^2' }]);
    });

    it('does not drop trailing text after a multi-line close', () => {
        const blocks = parseMarkdown('$$\nx^2\n$$ and more');
        // trailing "and more" means this is not a standalone block → no math block, no text loss
        expect(blocks.every(b => b.type !== 'math')).toBe(true);
        const allText = blocks.filter(b => b.type === 'text').map(b => (b as any).content.map((s: any) => s.text).join('')).join(' ');
        expect(allText).toContain('and more');
    });
});

describe('parseMarkdown — math gated off (enableMath = false)', () => {
    it('does not produce a display-math block; keeps the delimiters as literal text', () => {
        const blocks = parseMarkdown('$$ E = mc^2 $$', false);
        expect(blocks.every(b => b.type !== 'math')).toBe(true);
        const allText = blocks.filter(b => b.type === 'text').map(b => (b as any).content.map((s: any) => s.text).join('')).join('');
        expect(allText).toContain('$$ E = mc^2 $$');
    });

    it('does not mark inline $…$ / \\(…\\) spans as math', () => {
        const spans = parseMarkdownSpans('an equation $x^2$ and \\(y\\) here', false, false);
        expect(spans.every(s => !s.math)).toBe(true);
        expect(spans.map(s => s.text).join('')).toContain('$x^2$');
    });

    it('still parses non-math markdown normally when math is off', () => {
        const spans = parseMarkdownSpans('some **bold** and `code`', false, false);
        expect(spans.find(s => s.styles.includes('bold'))?.text).toBe('bold');
        expect(spans.find(s => s.styles.includes('code'))?.text).toBe('code');
    });
});
