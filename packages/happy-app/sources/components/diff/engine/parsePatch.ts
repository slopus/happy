/**
 * Unified-diff parser.
 *
 * Deliberately tolerant: agent tools, `git diff`, and hand-written patches all
 * end up here, and a malformed header should degrade to "render what we can"
 * rather than throw. Output is the raw shape; syntax highlighting and word-level
 * diffing happen later in buildDiff.
 */

import type { FileChangeKind } from './types';

export interface RawLine {
    type: 'add' | 'del' | 'ctx';
    text: string;
    oldNo?: number;
    newNo?: number;
}

export interface RawHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /** Text after the closing `@@`, usually the enclosing function. */
    section: string;
    lines: RawLine[];
}

export interface RawFile {
    path: string;
    oldPath?: string;
    kind: FileChangeKind;
    hunks: RawHunk[];
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/;

/** Strips git's `a/` and `b/` prefixes, and unquotes `core.quotepath` output. */
function cleanPath(raw: string): string {
    let p = raw.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length > 1) {
        try {
            p = JSON.parse(p);
        } catch {
            p = p.slice(1, -1);
        }
    }
    // Drop a trailing tab-separated timestamp that `diff -u` emits.
    const tab = p.indexOf('\t');
    if (tab !== -1) p = p.slice(0, tab);
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
}

export function parsePatch(patch: string): RawFile[] {
    const lines = patch.split('\n');
    // The newline that ends the last line is a terminator, not a line of its
    // own — without this every patch gains a blank context row at the bottom.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const files: RawFile[] = [];

    let file: RawFile | null = null;
    let hunk: RawHunk | null = null;
    let oldNo = 0;
    let newNo = 0;
    // `--- a/x` + `+++ b/x` pairs give us the real paths; the `diff --git` line
    // is unreliable when paths contain spaces.
    let sawOldHeader = false;

    const pushFile = () => {
        if (file) files.push(file);
        file = null;
        hunk = null;
    };

    const ensureFile = (path: string): RawFile => {
        if (!file) {
            file = { path, kind: 'modified', hunks: [] };
        }
        return file;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('diff --git ') || line.startsWith('diff -')) {
            pushFile();
            sawOldHeader = false;
            // Best-effort path from the header; refined by ---/+++ below.
            const m = /^diff --git (.+) (.+)$/.exec(line);
            if (m) {
                file = { path: cleanPath(m[2]), oldPath: cleanPath(m[1]), kind: 'modified', hunks: [] };
            }
            continue;
        }

        if (line.startsWith('new file mode')) {
            if (file) file.kind = 'added';
            continue;
        }
        if (line.startsWith('deleted file mode')) {
            if (file) file.kind = 'deleted';
            continue;
        }
        if (line.startsWith('rename from ')) {
            if (file) {
                file.oldPath = cleanPath(line.slice('rename from '.length));
                file.kind = 'renamed';
            }
            continue;
        }
        if (line.startsWith('rename to ')) {
            const p = cleanPath(line.slice('rename to '.length));
            if (file) {
                file.path = p;
                file.kind = 'renamed';
            } else {
                file = { path: p, kind: 'renamed', hunks: [] };
            }
            continue;
        }
        if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
            if (file) file.kind = 'binary';
            continue;
        }
        if (line.startsWith('index ') || line.startsWith('similarity index') || line.startsWith('old mode') || line.startsWith('new mode')) {
            continue;
        }

        if (line.startsWith('--- ')) {
            const p = line.slice(4);
            sawOldHeader = true;
            if (p.trim() === '/dev/null') {
                if (file) file.kind = 'added';
                else file = { path: '', kind: 'added', hunks: [] };
            } else if (file) {
                file.oldPath = cleanPath(p);
            } else {
                file = { path: cleanPath(p), oldPath: cleanPath(p), kind: 'modified', hunks: [] };
            }
            continue;
        }

        if (line.startsWith('+++ ')) {
            const p = line.slice(4);
            if (p.trim() === '/dev/null') {
                const f = ensureFile(file?.oldPath ?? '');
                f.kind = 'deleted';
                if (!f.path && f.oldPath) f.path = f.oldPath;
            } else {
                const cleaned = cleanPath(p);
                const f = ensureFile(cleaned);
                // A `+++` right after `---` always names the current file.
                if (sawOldHeader || !f.path) f.path = cleaned;
            }
            sawOldHeader = false;
            continue;
        }

        const hm = HUNK_HEADER.exec(line);
        if (hm) {
            const f = ensureFile('');
            hunk = {
                oldStart: parseInt(hm[1], 10),
                oldLines: hm[2] === undefined ? 1 : parseInt(hm[2], 10),
                newStart: parseInt(hm[3], 10),
                newLines: hm[4] === undefined ? 1 : parseInt(hm[4], 10),
                section: hm[5] ?? '',
                lines: [],
            };
            f.hunks.push(hunk);
            oldNo = hunk.oldStart;
            newNo = hunk.newStart;
            continue;
        }

        if (!hunk) continue;

        // `\ No newline at end of file` is metadata, not content.
        if (line.startsWith('\\')) continue;

        const marker = line.charAt(0);
        const text = line.slice(1);
        if (marker === '+') {
            hunk.lines.push({ type: 'add', text, newNo: newNo++ });
        } else if (marker === '-') {
            hunk.lines.push({ type: 'del', text, oldNo: oldNo++ });
        } else if (marker === ' ' || line === '') {
            hunk.lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
        }
        // Anything else (trailing junk between files) is ignored.
    }

    pushFile();
    return files.filter((f) => f.path || f.hunks.length > 0);
}

/**
 * Builds a synthetic single-file patch from two full file contents.
 * Used by tool views that hand us before/after text instead of a patch.
 */
export function rawFileFromContents(
    path: string,
    oldText: string,
    newText: string,
    contextLines: number,
): RawFile {
    const kind: FileChangeKind =
        oldText === '' && newText !== '' ? 'added' :
        newText === '' && oldText !== '' ? 'deleted' :
        'modified';
    return {
        path,
        kind,
        hunks: hunksFromContents(oldText, newText, contextLines),
    };
}

/**
 * Myers line diff via the `diff` package, folded into hunks with N lines of
 * context. Kept here so the renderer has exactly one input shape to deal with.
 */
export function hunksFromContents(oldText: string, newText: string, contextLines: number): RawHunk[] {
    // Imported lazily to keep the parser tree-shakeable for the patch-only path.
    const { diffLines } = require('diff') as typeof import('diff');

    const splitKeep = (v: string): string[] => {
        const parts = v.split('\n');
        if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
        return parts;
    };

    const all: RawLine[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const change of diffLines(oldText, newText)) {
        for (const text of splitKeep(change.value)) {
            if (change.added) {
                all.push({ type: 'add', text, newNo: newNo++ });
            } else if (change.removed) {
                all.push({ type: 'del', text, oldNo: oldNo++ });
            } else {
                all.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
            }
        }
    }

    return foldHunks(all, contextLines);
}

/** Groups a full line list into hunks, dropping unchanged runs longer than 2*context. */
export function foldHunks(all: RawLine[], contextLines: number): RawHunk[] {
    const changed: boolean[] = all.map((l) => l.type !== 'ctx');
    if (!changed.some(Boolean)) return [];

    const keep = new Array<boolean>(all.length).fill(false);
    for (let i = 0; i < all.length; i++) {
        if (!changed[i]) continue;
        for (let j = Math.max(0, i - contextLines); j <= Math.min(all.length - 1, i + contextLines); j++) {
            keep[j] = true;
        }
    }

    const hunks: RawHunk[] = [];
    let i = 0;
    while (i < all.length) {
        if (!keep[i]) { i++; continue; }
        let j = i;
        while (j < all.length && keep[j]) j++;
        const slice = all.slice(i, j);
        const first = slice[0];
        const oldStart = first.oldNo ?? (slice.find((l) => l.oldNo !== undefined)?.oldNo ?? 0);
        const newStart = first.newNo ?? (slice.find((l) => l.newNo !== undefined)?.newNo ?? 0);
        hunks.push({
            oldStart,
            oldLines: slice.filter((l) => l.type !== 'add').length,
            newStart,
            newLines: slice.filter((l) => l.type !== 'del').length,
            section: '',
            lines: slice,
        });
        i = j;
    }
    return hunks;
}
