import { describe, expect, it } from 'vitest';
import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock', () => {
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

    it('keeps nested markdown fences with an explicit inner language', () => {
        const markdown = [
            '```md',
            '```ts',
            'const value = 1;',
            '```',
            '```',
        ].join('\n');

        const blocks = parseMarkdownBlock(markdown);

        expect(blocks).toHaveLength(1);
        const first = blocks[0];
        expect(first.type).toBe('code-block');
        if (first.type !== 'code-block') throw new Error('Expected code-block');
        expect(first.language).toBe('md');
        expect(first.content).toBe([
            '```ts',
            'const value = 1;',
            '```',
        ].join('\n'));
    });

    it('keeps anonymous nested fences inside plain triple-backtick wrappers', () => {
        const markdown = [
            '```',
            '第一层内容',
            '```',
            '第二层内容',
            '```',
            '```',
        ].join('\n');

        const blocks = parseMarkdownBlock(markdown);

        expect(blocks).toHaveLength(1);
        const first = blocks[0];
        expect(first.type).toBe('code-block');
        if (first.type !== 'code-block') throw new Error('Expected code-block');
        expect(first.content).toBe([
            '第一层内容',
            '```',
            '第二层内容',
            '```',
        ].join('\n'));
    });

    it('does not swallow a later separate anonymous fenced block', () => {
        const markdown = [
            '```',
            '第一段代码',
            '```',
            '普通文本',
            '```',
            '第二段代码',
            '```',
        ].join('\n');

        const blocks = parseMarkdownBlock(markdown);

        expect(blocks).toHaveLength(3);
        expect(blocks[0].type).toBe('code-block');
        expect(blocks[1].type).toBe('text');
        expect(blocks[2].type).toBe('code-block');

        const secondBlock = blocks[2];
        if (secondBlock.type !== 'code-block') throw new Error('Expected second code-block');
        expect(secondBlock.content).toBe('第二段代码');
    });

    it('does not swallow a later separate language fenced block', () => {
        const markdown = [
            '```',
            '第一段代码',
            '```',
            '普通文本',
            '```ts',
            'const x = 1;',
            '```',
        ].join('\n');

        const blocks = parseMarkdownBlock(markdown);

        expect(blocks).toHaveLength(3);
        expect(blocks[0].type).toBe('code-block');
        expect(blocks[1].type).toBe('text');
        expect(blocks[2].type).toBe('code-block');
    });

    it('handles three consecutive anonymous fences with close-then-open semantics', () => {
        const markdown = [
            '```',
            'first',
            '```',
            '```',
            '```',
            'tail',
        ].join('\n');

        const blocks = parseMarkdownBlock(markdown);

        expect(blocks).toHaveLength(3);
        expect(blocks[0].type).toBe('code-block');
        expect(blocks[1].type).toBe('code-block');
        expect(blocks[2].type).toBe('text');
    });
});
