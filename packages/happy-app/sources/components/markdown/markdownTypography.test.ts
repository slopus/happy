import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import { getMarkdownTypography } from './markdownTypography';

describe('getMarkdownTypography', () => {
    it('keeps prose and inline code on the same Maple Mono family', () => {
        const typography = getMarkdownTypography('chatMono');

        expect(typography.body?.fontFamily).toBe('MapleMonoNL-Regular');
        expect(typography.inlineCode?.fontFamily).toBe(typography.body?.fontFamily);
    });

    it('uses the bundled Maple Mono faces for emphasized content', () => {
        const typography = getMarkdownTypography('chatMono');

        expect(typography.italic?.fontFamily).toBe('MapleMonoNL-Italic');
        expect(typography.italic?.fontStyle).toBe('normal');
        expect(typography.strong?.fontFamily).toBe('MapleMonoNL-SemiBold');
        expect(typography.strong?.fontWeight).toBe('normal');
    });

    it('gives document headings a clear hierarchy without changing chat typography', () => {
        const document = getMarkdownTypography('document');
        expect(document.headings?.[1]?.fontSize).toBeGreaterThan(document.headings?.[2]?.fontSize ?? 0);
        expect(document.headings?.[2]?.fontSize).toBeGreaterThan(document.body?.fontSize ?? 0);
        expect(document.body?.lineHeight).toBeGreaterThanOrEqual((document.body?.fontSize ?? 0) * 1.6);
        expect(getMarkdownTypography('chatMono').body?.fontSize).toBeUndefined();
    });

    it('leaves non-chat Markdown typography unchanged', () => {
        expect(getMarkdownTypography('default')).toEqual({});
    });
});
