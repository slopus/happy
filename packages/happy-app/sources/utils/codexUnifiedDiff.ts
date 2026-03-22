export type ParsedUnifiedDiff = {
    oldText: string;
    newText: string;
    fileName?: string;
};

/**
 * Parse a unified diff or diff hunk fragment into old/new file contents.
 */
export function parseUnifiedDiff(unifiedDiff: string): ParsedUnifiedDiff {
    const lines = unifiedDiff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let fileName: string | undefined;
    let inHunk = false;

    for (const line of lines) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            fileName = line.replace(/^\+\+\+ (b\/)?/, '');
            continue;
        }

        if (
            line.startsWith('diff --git') ||
            line.startsWith('index ') ||
            line.startsWith('---') ||
            line.startsWith('new file mode') ||
            line.startsWith('deleted file mode') ||
            line.startsWith('similarity index ') ||
            line.startsWith('rename from ') ||
            line.startsWith('rename to ')
        ) {
            continue;
        }

        if (line.startsWith('@@')) {
            inHunk = true;
            continue;
        }

        if (!inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
            inHunk = true;
        }

        if (!inHunk) {
            continue;
        }

        if (line.startsWith('+')) {
            newLines.push(line.substring(1));
        } else if (line.startsWith('-')) {
            oldLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
            const content = line.substring(1);
            oldLines.push(content);
            newLines.push(content);
        } else if (line === '\\ No newline at end of file') {
            continue;
        } else if (line === '') {
            oldLines.push('');
            newLines.push('');
        }
    }

    return {
        oldText: oldLines.join('\n'),
        newText: newLines.join('\n'),
        fileName,
    };
}
