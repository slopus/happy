/**
 * Turns raw patches into render-ready `DiffDocument`s.
 *
 * All of the expensive work lives here and happens exactly once per input:
 * parse, tab expansion, syntax tokenization, word-level diffing, and span
 * merging. The result is immutable, theme-independent and cached, so scrolling,
 * theme switches and remounts cost nothing but drawing.
 */

import { highlightLines, type SyntaxRun } from './highlight';
import { computeEmphasis, type Range } from './intraline';
import { detectLanguage } from './language';
import {
    DiffBudgetExceededError,
    hunksFromContents,
    parsePatch,
    type RawFile,
    type RawHunk,
    type RawLine,
} from './parsePatch';
import type { DiffDocument, DiffFile, DiffRow, DiffSpan, SpanKind } from './types';
import { LruCache } from './lru';

export interface BuildOptions {
    /** Context lines when diffing two blobs. Ignored for pre-made patches. */
    contextLines?: number;
    /** Fold away changes made only of whitespace when diffing two blobs. */
    ignoreWhitespace?: boolean;
    /** Abort an expensive full-content diff before it can block the UI. */
    diffBudget?: DiffBudget;
    /** Syntax highlighting. Turn off to measure or for huge files. */
    syntax?: boolean;
    /** Word-level emphasis inside changed lines. */
    intraline?: boolean;
    /** Tab expansion width. Tabs are expanded at build time so column math is exact. */
    tabWidth?: number;
    /** Files past this many lines skip syntax + word diff and render plain. */
    maxHighlightLines?: number;
}

export interface DiffBudget {
    /** Maximum wall-clock time passed to the underlying line diff. */
    timeoutMs: number;
    /** Maximum edit distance passed to the underlying line diff. */
    maxEditLength: number;
}

type ResolvedBuildOptions = Omit<Required<BuildOptions>, 'diffBudget'> & { diffBudget?: DiffBudget };

const DEFAULTS: Omit<ResolvedBuildOptions, 'diffBudget'> = {
    contextLines: 3,
    ignoreWhitespace: false,
    // Keep Prism off React's synchronous render path. DiffFileView prepares
    // syntax on a dedicated runtime and bounds the first-paint wait. Explicit
    // syntax:true is reserved for engine tests / the synchronous benchmark.
    syntax: false,
    intraline: true,
    tabWidth: 4,
    maxHighlightLines: 8000,
};

/**
 * Explicit per-field fallback rather than a spread: callers routinely pass
 * objects with `undefined` fields, and a spread would let those quietly
 * overwrite the defaults (which is how syntax highlighting once went missing
 * everywhere except the one call site that passed booleans).
 */
function resolve(options?: BuildOptions): ResolvedBuildOptions {
    return {
        contextLines: options?.contextLines ?? DEFAULTS.contextLines,
        ignoreWhitespace: options?.ignoreWhitespace ?? DEFAULTS.ignoreWhitespace,
        diffBudget: options?.diffBudget,
        syntax: options?.syntax ?? DEFAULTS.syntax,
        intraline: options?.intraline ?? DEFAULTS.intraline,
        tabWidth: options?.tabWidth ?? DEFAULTS.tabWidth,
        maxHighlightLines: options?.maxHighlightLines ?? DEFAULTS.maxHighlightLines,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function buildDiffFromPatch(patch: string, options?: BuildOptions): DiffDocument {
    const opts = resolve(options);
    const key = cacheKey('p', patch, opts);
    const hit = cacheGet(key);
    if (hit) return hit;

    const started = now();
    const files = parsePatch(patch).map((raw) => buildFile(raw, opts));
    const doc = finish(files, started);
    cacheSet(key, doc);
    return doc;
}

export function buildDiffFromContents(
    path: string,
    oldText: string,
    newText: string,
    options?: BuildOptions,
): DiffDocument {
    const opts = resolve(options);
    const key = cacheKey('c', `${path}\u0000${oldText}\u0000${newText}`, opts);
    const hit = cacheGet(key);
    if (hit) return hit;

    const started = now();
    const emphasisDeadline = opts.diffBudget ? Date.now() + opts.diffBudget.timeoutMs : undefined;
    let hunks: RawHunk[];
    try {
        hunks = hunksFromContents(oldText, newText, opts.contextLines, opts.ignoreWhitespace, opts.diffBudget);
    } catch (error) {
        if (!(error instanceof DiffBudgetExceededError)) throw error;
        return {
            files: [],
            additions: 0,
            deletions: 0,
            buildMs: now() - started,
            error: 'Diff is too large to render on this device.',
        };
    }
    const raw: RawFile = {
        path,
        kind: oldText === '' && newText !== '' ? 'added' : newText === '' && oldText !== '' ? 'deleted' : 'modified',
        hunks,
    };
    const doc = finish([buildFile(raw, opts, emphasisDeadline)], started);
    cacheSet(key, doc);
    return doc;
}

/** Drops every cached document. Exposed for the benchmark page. */
export function clearDiffCache(): void {
    cache.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// Building
// ────────────────────────────────────────────────────────────────────────────

function finish(files: DiffFile[], started: number): DiffDocument {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
        additions += f.additions;
        deletions += f.deletions;
    }
    const doc = { files, additions, deletions, buildMs: now() - started };
    // Only reached on cache misses, so this logs each expensive document once
