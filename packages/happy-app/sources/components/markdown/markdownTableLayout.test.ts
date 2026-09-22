import { describe, expect, it } from 'vitest';
import type { MarkdownSpan } from './parseMarkdown';
import {
    calculateTableColumnWidths,
    spansDisplayWidth,
    TABLE_MIN_COL_WIDTH,
} from './markdownTableLayout';

const spans = (text: string): MarkdownSpan[] => [{ styles: [], text, url: null }];

describe('markdown table layout', () => {
    it('accounts for CJK glyphs at their display width', () => {
        expect(spansDisplayWidth(spans('abc 中文'))).toBe(8);

        const widths = calculateTableColumnWidths([spans('标题')], [[spans('数据从哪来、怎么处理、去哪')]], null);
        expect(widths[0]).toBe(245);
    });

    it('expands a fitting table to the available message width without changing column proportions', () => {
        const headers = [spans('内容'), spans('类型')];
        const rows = [[spans('数据从哪来、怎么处理、去哪'), spans('architecture 架构图')]];
        const naturalWidths = calculateTableColumnWidths(headers, rows, null);
        const expandedWidths = calculateTableColumnWidths(headers, rows, 600);

        expect(expandedWidths.reduce((total, width) => total + width, 0)).toBeCloseTo(600);
        expect(expandedWidths[0] / expandedWidths[1]).toBeCloseTo(naturalWidths[0] / naturalWidths[1]);
    });

    it('keeps a table at its natural width when the viewport is narrower, preserving horizontal scrolling', () => {
        const headers = [spans('内容'), spans('类型')];
        const rows = [[spans('数据从哪来、怎么处理、去哪'), spans('architecture 架构图')]];
        const naturalWidths = calculateTableColumnWidths(headers, rows, null);
        const narrowViewportWidths = calculateTableColumnWidths(headers, rows, TABLE_MIN_COL_WIDTH * 2);

        expect(narrowViewportWidths).toEqual(naturalWidths);
    });
});
