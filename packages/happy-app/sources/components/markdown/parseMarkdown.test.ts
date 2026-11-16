import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const item = (spans: { styles: string[]; text: string; url: string | null }[]) => ({
    depth: 0,
    spans,
});

describe('parseMarkdown', () => {
    it.each([
        { markdown: '**https://example.com/search?q=a*b**', style: 'bold', url: 'https://example.com/search?q=a*b' },
        { markdown: '*https://example.com/search?filter[name]=alice*', style: 'italic', url: 'https://example.com/search?filter[name]=alice' },
    ])('preserves the complete bare URL inside $style text', ({ markdown, style, url }) => {
        expect(parseMarkdown(markdown)).toEqual([
            { type: 'text', content: [{ styles: [style], text: url, url }] },
        ]);
    });

    it('keeps bare URLs and explicit links separate inside emphasis', () => {
        expect(parseMarkdown('**See https://example.com then [doc](/work/a.md).**')).toEqual([
            { type: 'text', content: [
                { styles: ['bold'], text: 'See ', url: null },
                { styles: ['bold'], text: 'https://example.com', url: 'https://example.com' },
                { styles: ['bold'], text: ' then ', url: null },
                { styles: ['bold'], text: 'doc', url: '/work/a.md' },
                { styles: ['bold'], text: '.', url: null },
            ] },
        ]);
    });

    it('preserves the target of a file link inside a bold instruction', () => {
        expect(parseMarkdown('**刷新后，点击 [图标索引](/Users/alice/skills/references/图标/index.md) 即可。**')).toEqual([
            { type: 'text', content: [
                { styles: ['bold'], text: '刷新后，点击 ', url: null },
                { styles: ['bold'], text: '图标索引', url: '/Users/alice/skills/references/图标/index.md' },
                { styles: ['bold'], text: ' 即可。', url: null },
            ] },
        ]);
    });

    it('preserves an angle-delimited file target inside italic text', () => {
        expect(parseMarkdown('*Open [report](</Volumes/Work Disk/report (final).md:12>).*')).toEqual([
            { type: 'text', content: [
                { styles: ['italic'], text: 'Open ', url: null },
                { styles: ['italic'], text: 'report', url: '/Volumes/Work Disk/report (final).md:12' },
                { styles: ['italic'], text: '.', url: null },
            ] },
        ]);
    });

    it('continues parsing after a formatted link and keeps inline code literal', () => {
        expect(parseMarkdown('**[docs](https://example.com)** and **next** with `[raw](/work/a.md)`.')).toEqual([
            { type: 'text', content: [
                { styles: ['bold'], text: 'docs', url: 'https://example.com' },
                { styles: [], text: ' and ', url: null },
                { styles: ['bold'], text: 'next', url: null },
                { styles: [], text: ' with ', url: null },
                { styles: ['code'], text: '[raw](/work/a.md)', url: null },
                { styles: [], text: '.', url: null },
            ] },
        ]);
    });

    it('keeps formatted header links actionable without overriding header typography', () => {
        expect(parseMarkdown('# **[index](/work/index.md)**')).toEqual([
            { type: 'header', level: 1, content: [{ styles: [], text: 'index', url: '/work/index.md' }] },
        ]);
    });

    it('unwraps angle-delimited link destinations with spaces and parentheses', () => {
        expect(parseMarkdown('[报告](</Volumes/Work Disk/docs/report (final).md:12>)')).toEqual([
            { type: 'text', content: [{ styles: [], text: '报告', url: '/Volumes/Work Disk/docs/report (final).md:12' }] },
        ]);
        expect(parseMarkdown('[external](<https://example.com/docs>)')).toEqual([
            { type: 'text', content: [{ styles: [], text: 'external', url: 'https://example.com/docs' }] },
        ]);
    });
    it('parses unordered lists across common markdown bullet markers and preserves clickable links', () => {
        const blocks = parseMarkdown([
            '* first item',
            '+ second item with [docs](https://example.com/docs)',
            '- third item with https://example.com/raw.',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('list');

        if (blocks[0]?.type !== 'list') {
            throw new Error('Expected markdown list block');
        }

        expect(blocks[0].items).toHaveLength(3);
        expect(blocks[0].items[1]).toEqual(item([
            { styles: [], text: 'second item with ', url: null },
            { styles: [], text: 'docs', url: 'https://example.com/docs' },
        ]));
        expect(blocks[0].items[2]).toEqual(item([
            { styles: [], text: 'third item with ', url: null },
            { styles: [], text: 'https://example.com/raw', url: 'https://example.com/raw' },
            { styles: [], text: '.', url: null },
        ]));
    });

    it('parses standalone markdown image blocks', () => {
        const blocks = parseMarkdown('![Markdown renderable image](data:image/png;base64,abc123)');

        expect(blocks).toEqual([
            {
                type: 'image',
                alt: 'Markdown renderable image',
                url: 'data:image/png;base64,abc123',
            },
        ]);
    });

    it('auto-linkifies bare URLs in text blocks', () => {
        const blocks = parseMarkdown('Visit https://example.com/docs for more.');

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('text');

        if (blocks[0]?.type !== 'text') {
            throw new Error('Expected markdown text block');
        }

        expect(blocks[0].content).toEqual([
            { styles: [], text: 'Visit ', url: null },
            { styles: [], text: 'https://example.com/docs', url: 'https://example.com/docs' },
            { styles: [], text: ' for more.', url: null },
        ]);
    });

    it('keeps consecutive plain text lines in one block with indentation intact', () => {
        const blocks = parseMarkdown([
            'Garden case prompt:',
            '{',
            '  "type": "拟物风应用图标集",',
            '  "style": {',
            '    "rendering": "skeuomorphic 3D + 柔光"',
            '  }',
            '}',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('text');

        if (blocks[0]?.type !== 'text') {
            throw new Error('Expected markdown text block');
        }

        expect(blocks[0].content).toEqual([
            {
                styles: [],
                text: 'Garden case prompt:\n{\n  "type": "拟物风应用图标集",\n  "style": {\n    "rendering": "skeuomorphic 3D + 柔光"\n  }\n}',
                url: null,
            },
        ]);
    });
});

it('keeps external history inert while retaining ordinary formatting', async () => {
    const { parseReadOnlyMarkdown } = await import('./parseMarkdown');
    const blocks = parseReadOnlyMarkdown('# Heading\n\n**bold**\n\n![external](https://tracking.example/image.png)\n\n```mermaid\ngraph TD\nA-->B\n```\n\n<options>\n<option>Run an action</option>\n</options>\n\n<happy-ota-preview>\ntitle: External update\nchannel: preview\nplatform: android\nruntimeVersion: 24\nupdateId: 11111111-1111-4111-8111-111111111111\nmanifestUrl: https://example.com/update.json\n</happy-ota-preview>');
    expect(blocks.some(block => block.type === 'header')).toBe(true);
    expect(blocks.every(block => !['image', 'mermaid', 'options', 'ota-preview', 'finance-chart'].includes(block.type))).toBe(true);
    expect(JSON.stringify(blocks)).toContain('tracking.example');
    expect(JSON.stringify(blocks)).toContain('External update');
});
it('keeps image blocks only when a caller provides a frozen image resolver',async()=>{
 const {parseReadOnlyMarkdown}=await import('./parseMarkdown');
 expect(parseReadOnlyMarkdown('![local](diagram.svg)',{allowImages:true})).toEqual([{type:'image',url:'diagram.svg',alt:'local'}]);
 expect(parseReadOnlyMarkdown('![remote](https://example.com/image.png)').some(b=>b.type==='image')).toBe(false);
});
