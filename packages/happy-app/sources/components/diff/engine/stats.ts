/**
 * Cheap stats without building a document.
 *
 * Callers need `+N −M` for a file header long before (and often instead of)
 * rendering that file, so these walk the input once and never allocate rows.
 */
export function countPatchStats(patch: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    let index = 0;
    while (index < patch.length) {
        let end = patch.indexOf('\n', index);
        if (end === -1) end = patch.length;
        const first = patch[index];
        if (first === '@' && patch.startsWith('@@', index)) {
            inHunk = true;
        } else if (inHunk) {
            if (first === '+' && !patch.startsWith('+++', index)) additions++;
            else if (first === '-' && !patch.startsWith('---', index)) deletions++;
            else if (first === 'd' && patch.startsWith('diff ', index)) inHunk = false;
        }
        index = end + 1;
    }

    return { additions, deletions };
}

/**
 * Same numbers for callers that hold two blobs rather than a patch. Counts
 * changed lines only — the line diff is the same one `hunksFromContents` uses,
 * so a header and the diff rendered under it can never disagree.
 */
export function countContentStats(oldText: string, newText: string): { additions: number; deletions: number } {
    const { diffLines } = require('diff') as typeof import('diff');

    let additions = 0;
    let deletions = 0;
    for (const change of diffLines(oldText, newText)) {
        if (!change.added && !change.removed) continue;
        const parts = change.value.split('\n');
        // A trailing newline produces an empty last element that isn't a line.
        if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
        if (change.added) additions += parts.length;
        else deletions += parts.length;
    }
    return { additions, deletions };
}
