import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const item = (spans: { styles: string[]; text: string; url: string | null }[]) => ({
    depth: 0,
    spans,
});

describe('parseMarkdown', () => {
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
