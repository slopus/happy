import { describe, it, expect } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';

describe('parseMarkdownSpans links', () => {
    it('parses links nested inside bold formatting', () => {
        const input = '**[#30592](dootask://task/30592)**';
        const spans = parseMarkdownSpans(input, false);

        expect(spans).toEqual([
            { styles: ['bold'], text: '#30592', url: 'dootask://task/30592' },
        ]);
    });

    it('parses links nested inside italic formatting', () => {
        const input = '*[#30592](dootask://task/30592)*';
        const spans = parseMarkdownSpans(input, false);

        expect(spans).toEqual([
            { styles: ['italic'], text: '#30592', url: 'dootask://task/30592' },
        ]);
    });

    it('parses file links with parentheses and brackets in URL', () => {
        const input = '[file.tsx:103](/home/coder/workspaces/happy/packages/happy-app/sources/app/(app)/session/[id]/file.tsx:103)';
        const spans = parseMarkdownSpans(input, false);

        expect(spans).toEqual([
            {
                styles: [],
                text: 'file.tsx:103',
                url: '/home/coder/workspaces/happy/packages/happy-app/sources/app/(app)/session/[id]/file.tsx:103',
            },
        ]);
    });

    it('keeps surrounding text when parsing path-like links', () => {
        const input = 'See [file.tsx:103](/repo/(app)/session/[id]/file.tsx:103) now';
        const spans = parseMarkdownSpans(input, false);

        expect(spans).toEqual([
            { styles: [], text: 'See ', url: null },
            { styles: [], text: 'file.tsx:103', url: '/repo/(app)/session/[id]/file.tsx:103' },
            { styles: [], text: ' now', url: null },
        ]);
    });

    it('parses links with angle-bracket destinations', () => {
        const input = '[file.tsx:103](</home/coder/workspaces/happy/packages/happy-app/sources/app/(app)/session/[id]/file.tsx:103>)';
        const spans = parseMarkdownSpans(input, false);

        expect(spans).toEqual([
            {
                styles: [],
                text: 'file.tsx:103',
                url: '/home/coder/workspaces/happy/packages/happy-app/sources/app/(app)/session/[id]/file.tsx:103',
            },
        ]);
    });
});
