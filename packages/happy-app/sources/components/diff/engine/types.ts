/**
 * Data model for the diff renderer.
 *
 * Everything in here is theme-independent and JSON-serializable on purpose:
 * the expensive work (patch parsing, syntax tokenization, intra-line word diff)
 * runs once per patch string and is cached across theme switches, remounts and
 * navigation. The render layer only maps `SpanKind` -> color and draws.
 */

/** Prism-ish token classes we care about, collapsed to a small palette. */
export type SpanKind =
    | 'plain'
    | 'keyword'
    | 'string'
    | 'comment'
    | 'number'
    | 'function'
    | 'operator'
    | 'punctuation'
    | 'type'
    | 'variable'
    | 'tag'
    | 'attr';

/** Intra-line emphasis: which side of a word-level change this run belongs to. */
export type SpanEmphasis = 0 | 1 | 2; // 0 = none, 1 = inserted, 2 = deleted

/** A single styled run of text inside one rendered line. */
export interface DiffSpan {
    /** Text content of the run. */
    t: string;
    /** Syntax class. */
    k: SpanKind;
    /** Word-diff emphasis. */
    e: SpanEmphasis;
}

export type DiffRowType = 'add' | 'del' | 'ctx';

/** One rendered row. Rows are flat so lists can virtualize them directly. */
export type DiffRow =
    | {
        kind: 'line';
        /** Stable key, unique within a file. */
        key: string;
        type: DiffRowType;
        /** 1-based line number on the old side, undefined for additions. */
        oldNo?: number;
        /** 1-based line number on the new side, undefined for deletions. */
        newNo?: number;
        /** Raw text, without the +/- marker. Used for copy and width math. */
        text: string;
        spans: DiffSpan[];
    }
    | {
        kind: 'hunk';
        key: string;
        /** `@@ -1,7 +1,9 @@` */
        text: string;
        /** Trailing section context git puts after the `@@`, e.g. a function name. */
        section: string;
        /** How many unchanged lines are hidden above this hunk, if known. */
        hidden?: number;
    }
    | {
        kind: 'message';
        key: string;
        /** Semantic marker; the renderer maps it to translated copy. */
        code: 'binary' | 'empty';
    };

export type FileChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

/** One file's worth of diff, ready to render. */
export interface DiffFile {
    /** Path shown to the user (new path for renames). */
    path: string;
    /** Previous path, only for renames. */
    oldPath?: string;
    kind: FileChangeKind;
    /** Detected language id, used for syntax highlighting. */
    language: string | null;
    additions: number;
    deletions: number;
    rows: DiffRow[];
    /** Longest row in characters — drives horizontal scroll content width. */
    maxColumns: number;
    /** Widest line number, drives gutter width. */
    maxLineNo: number;
}

export interface DiffDocument {
    files: DiffFile[];
    additions: number;
    deletions: number;
    /** Wall-clock milliseconds spent building this document. Used by the bench page. */
    buildMs: number;
}
