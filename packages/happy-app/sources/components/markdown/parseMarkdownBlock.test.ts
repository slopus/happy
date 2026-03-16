import { describe, expect, it } from 'vitest';
import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock table parsing', () => {
    it('keeps an empty first header cell renderable in markdown tables', () => {
        const markdown = [
            '| | 场景 A | 场景 B |',
            '|---|---|---|',
            '| **用户位置** | 手机/远程 | 终端前 |',
        ].join('\n');

        const blocks = parseMarkdownBlock(markdown);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe('table');

        const table = blocks[0];
        if (table.type !== 'table') throw new Error('Expected table block');

        expect(table.headers[0]).toEqual([
            { styles: [], text: '\u200B', url: null },
        ]);
    });
});
