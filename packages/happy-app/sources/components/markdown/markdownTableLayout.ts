import type { MarkdownSpan } from './parseMarkdown';

export const TABLE_MIN_COL_WIDTH = 80;
export const TABLE_MAX_COL_WIDTH = 360;
const TABLE_CHAR_WIDTH = 8.5; // Approx. px for a half-width glyph at 16px.
const TABLE_CELL_H_PADDING = 24;

// CJK and full-width glyphs occupy approximately two Latin-character cells in
// the chat fonts. Counting them as one UTF-16 character underestimates column
// widths enough to make otherwise fitting tables wrap prematurely.
const WIDE_CHARACTER = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/;

export function spansDisplayWidth(spans: MarkdownSpan[]): number {
    let width = 0;
    for (const span of spans) {
        for (const character of Array.from(span.text)) {
            width += WIDE_CHARACTER.test(character) ? 2 : 1;
        }
    }
    return width;
}

function estimateColumnWidth(spans: MarkdownSpan[]): number {
    return Math.min(
        TABLE_MAX_COL_WIDTH,
        Math.max(TABLE_MIN_COL_WIDTH, spansDisplayWidth(spans) * TABLE_CHAR_WIDTH + TABLE_CELL_H_PADDING),
    );
}

export function calculateTableColumnWidths(
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    availableWidth: number | null,
): number[] {
    const columnCount = headers.length;
    if (columnCount === 0) return [];

    const naturalWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
        let widestCell = headers[columnIndex] ?? [];
        for (const row of rows) {
            const cell = row[columnIndex] ?? [];
            if (spansDisplayWidth(cell) > spansDisplayWidth(widestCell)) {
                widestCell = cell;
            }
        }
        return estimateColumnWidth(widestCell);
    });
    const naturalTableWidth = naturalWidths.reduce((total, width) => total + width, 0);

    // Natural-size tables stay scrollable when they exceed the viewport. When
    // there is spare room, give it back to every column proportionally so the
    // table uses the message width without making short columns disproportionately wide.
    if (!availableWidth || availableWidth <= naturalTableWidth) {
        return naturalWidths;
    }

    const extraWidth = availableWidth - naturalTableWidth;
    let assignedWidth = 0;
    return naturalWidths.map((width, columnIndex) => {
        if (columnIndex === columnCount - 1) {
            return availableWidth - assignedWidth;
        }
        const expandedWidth = width + extraWidth * (width / naturalTableWidth);
        assignedWidth += expandedWidth;
        return expandedWidth;
    });
}
