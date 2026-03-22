import type { MarkdownBlock, OptionItem } from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";

const EMPTY_TABLE_CELL_PLACEHOLDER = '\u200B';

function parseTableCell(cell: string) {
    const spans = parseMarkdownSpans(cell, false);
    if (spans.length > 0) {
        return spans;
    }
    return [{ styles: [], text: EMPTY_TABLE_CELL_PLACEHOLDER, url: null }];
}

// Split a table row by '|', stripping leading/trailing pipes but preserving empty cells in between
function splitTableRow(line: string): string[] {
    // Remove leading/trailing pipe and whitespace
    let s = line;
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    // If nothing left after stripping pipes, no cells
    if (s.trim().length === 0 && !line.includes('|')) return [];
    return s.split('|').map(cell => cell.trim());
}

function parseTable(lines: string[], startIndex: number): { table: MarkdownBlock | null; nextIndex: number } {
    let index = startIndex;
    const tableLines: string[] = [];

    // Collect consecutive lines that contain pipe characters to identify potential table rows
    while (index < lines.length && lines[index].includes('|')) {
        tableLines.push(lines[index]);
        index++;
    }

    if (tableLines.length < 2) {
        return { table: null, nextIndex: startIndex };
    }

    // Validate that the second line is a separator containing dashes, which distinguishes tables from plain text
    const separatorLine = tableLines[1].trim();
    const isSeparator = /^[|\s\-:=]*$/.test(separatorLine) && separatorLine.includes('-');

    if (!isSeparator) {
        return { table: null, nextIndex: startIndex };
    }

    // Extract header cells from the first line, stripping leading/trailing pipes but preserving empty cells
    const headerLine = tableLines[0].trim();
    const headerStrings = splitTableRow(headerLine);

    if (headerStrings.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    // Parse inline markdown for headers
    const headers = headerStrings.map(parseTableCell);

    // Extract data rows from remaining lines (skipping the separator line), preserving valid cell content
    const rows: ReturnType<typeof parseMarkdownSpans>[][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowLine = tableLines[i].trim();
        if (rowLine.includes('|')) {
            const rowCells = splitTableRow(rowLine);

            // Include rows that contain at least one cell
            if (rowCells.length > 0) {
                // Parse inline markdown for each cell
                rows.push(rowCells.map(parseTableCell));
            }
        }
    }

    const table: MarkdownBlock = {
        type: 'table',
        headers,
        rows
    };

    return { table, nextIndex: index };
}

function shouldOpenAnonymousNestedFence(lines: string[], fenceIndex: number): boolean {
    for (let i = fenceIndex + 1; i < lines.length - 1; i++) {
        if (lines[i].trim().startsWith('```')) {
            if (i === fenceIndex + 1) {
                return false;
            }
            return lines[i].trim() === '```' && lines[i + 1].trim() === '```';
        }
    }
    return false;
}

export function parseMarkdownBlock(markdown: string) {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let index = 0;
    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // Headers
        for (let i = 1; i <= 6; i++) {
            if (line.startsWith(`${'#'.repeat(i)} `)) {
                blocks.push({ type: 'header', level: i as 1 | 2 | 3 | 4 | 5 | 6, content: parseMarkdownSpans(line.slice(i + 1).trim(), true) });
                continue outer;
            }
        }

        // Trim
        let trimmed = line.trim();

        // Code block
        if (trimmed.startsWith('```')) {
            const language = trimmed.slice(3).trim() || null;
            const supportsNestedFences = language === null || language === 'md' || language === 'markdown';
            let nestedFenceDepth = 0;
            let content = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                const nextTrimmed = nextLine.trim();
                if (nextTrimmed.startsWith('```')) {
                    // For markdown code fences, allow nested fenced blocks like:
                    // ```md
                    // ```js
                    // ...
                    // ```
                    // ```
                    if (supportsNestedFences) {
                        if (nextTrimmed === '```') {
                            if (nestedFenceDepth === 0) {
                                if (shouldOpenAnonymousNestedFence(lines, index)) {
                                    nestedFenceDepth++;
                                    content.push(nextLine);
                                    index++;
                                    continue;
                                }
                                index++;
                                break;
                            }
                            nestedFenceDepth--;
                            content.push(nextLine);
                            index++;
                            continue;
                        }
                        nestedFenceDepth++;
                        content.push(nextLine);
                        index++;
                        continue;
                    }

                    if (nextTrimmed === '```') {
                        index++;
                        break;
                    }
                }
                content.push(nextLine);
                index++;
            }
            const contentString = content.join('\n');

            // Detect mermaid diagram language and route to appropriate block type
            if (language === 'mermaid') {
                blocks.push({ type: 'mermaid', content: contentString });
            } else {
                blocks.push({ type: 'code-block', language, content: contentString });
            }
            continue;
        }

        // Horizontal rule
        if (trimmed === '---') {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // Options block
        if (trimmed.startsWith('<options>')) {
            let items: OptionItem[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                // Extract content and attributes from <option> tags
                const optionMatch = nextLine.match(/<option(\s[^>]*)?>(.+?)<\/option>/);
                if (optionMatch) {
                    const attrs = optionMatch[1] || '';
                    const title = optionMatch[2].trim();
                    if (title) {
                        items.push({
                            title,
                            destructive: /\bdestructive\b/.test(attrs),
                        });
                    }
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
            }
            continue;
        }

        // If it is a numbered list
        const numberedListMatch = trimmed.match(/^(\d+)\.\s/);
        if (numberedListMatch) {
            let allLines = [{ number: parseInt(numberedListMatch[1]), content: trimmed.slice(numberedListMatch[0].length) }];
            while (index < lines.length) {
                const nextLine = lines[index].trim();
                const nextMatch = nextLine.match(/^(\d+)\.\s/);
                if (!nextMatch) break;
                allLines.push({ number: parseInt(nextMatch[1]), content: nextLine.slice(nextMatch[0].length) });
                index++;
            }
            blocks.push({ type: 'numbered-list', items: allLines.map((l) => ({ number: l.number, spans: parseMarkdownSpans(l.content, false) })) });
            continue;
        }

        // If it is a list
        if (trimmed.startsWith('- ')) {
            let allLines = [trimmed.slice(2)];
            while (index < lines.length && lines[index].trim().startsWith('- ')) {
                allLines.push(lines[index].trim().slice(2));
                index++;
            }
            blocks.push({ type: 'list', items: allLines.map((l) => parseMarkdownSpans(l, false)) });
            continue;
        }

        // Check for table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // Fallback
        if (trimmed.length > 0) {
            blocks.push({ type: 'text', content: parseMarkdownSpans(trimmed, false) });
        }
    }
    return blocks;
}
