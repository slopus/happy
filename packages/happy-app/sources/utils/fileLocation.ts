export type FileLocation = { line: number; column: number | null };
export const CODE_EDITOR_LINE_HEIGHT = 21;
export const CODE_EDITOR_PADDING = 16;

function positiveInteger(value?: string): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Preserve legacy query locations in the path format understood by file references. */
export function filePathWithLocation(path: string, line?: string, column?: string): string {
    const requestedLine = positiveInteger(line);
    const requestedColumn = positiveInteger(column);
    if (!requestedLine && !requestedColumn) return path;
    return path.replace(/:\d+(?::\d+)?$/, '') + ':' + (requestedLine ?? 1)
        + (requestedColumn ? ':' + requestedColumn : '');
}

/** Clamp locations to real content, including CRLF files and columns past line endings. */
export function fileLocationSelection(content: string, location: FileLocation) {
    // textarea.value and HTML parsing normalize CRLF (and standalone CR) to LF.
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const line = Math.max(1, Math.min(lines.length, location.line));
    const text = lines[line - 1].replace(/\r$/, '');
    const start = lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0);
    const column = location.column === null ? null : Math.max(1, Math.min(text.length + 1, location.column));
    return { line, start: start + (column === null ? 0 : column - 1), end: start + (column === null ? text.length : column - 1) };
}
