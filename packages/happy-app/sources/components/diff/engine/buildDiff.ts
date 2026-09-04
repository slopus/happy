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
import { hunksFromContents, parsePatch, type RawFile, type RawHunk, type RawLine } from './parsePatch';
import type { DiffDocument, DiffFile, DiffRow, DiffSpan, SpanKind } from './types';

export interface BuildOptions {
    /** Context lines when diffing two blobs. Ignored for pre-made patches. */
    contextLines?: number;
    /** Syntax highlighting. Turn off to measure or for huge files. */
    syntax?: boolean;
    /** Word-level emphasis inside changed lines. */
    intraline?: boolean;
    /** Tab expansion width. Tabs are expanded at build time so column math is exact. */
    tabWidth?: number;
    /** Files past this many lines skip syntax + word diff and render plain. */
    maxHighlightLines?: number;
}

const DEFAULTS: Required<BuildOptions> = {
    contextLines: 3,
    // Off while highlight colors don't actually render in chat: Prism
    // tokenization is ~10x of the whole build (see benchmark.spec.ts), and
    // right now it buys nothing. Flip back once highlighting works.
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
function resolve(options?: BuildOptions): Required<BuildOptions> {
    return {
        contextLines: options?.contextLines ?? DEFAULTS.contextLines,
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
    const raw: RawFile = {
        path,
        kind: oldText === '' && newText !== '' ? 'added' : newText === '' && oldText !== '' ? 'deleted' : 'modified',
        hunks: hunksFromContents(oldText, newText, opts.contextLines),
    };
    const doc = finish([buildFile(raw, opts)], started);
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
    // rather than on every render.
    if (doc.buildMs > 4) {
        const rows = files.reduce((n, f) => n + f.rows.length, 0);
        const paths = files.slice(0, 3).map((f) => f.path).join(', ');
        console.log(`[perf] diff build ${doc.buildMs.toFixed(1)}ms rows=${rows} ${paths}`);
    }
    return doc;
}

function buildFile(raw: RawFile, opts: Required<BuildOptions>): DiffFile {
    const language = detectLanguage(raw.path);
    const totalLines = raw.hunks.reduce((n, h) => n + h.lines.length, 0);
    const rich = totalLines <= opts.maxHighlightLines;

    const rows: DiffRow[] = [];
    let additions = 0;
    let deletions = 0;
    let maxColumns = 0;
    let maxLineNo = 0;
    let previousOldEnd: number | null = null;

    raw.hunks.forEach((hunk, hunkIndex) => {
        // Tab expansion first: every offset computed afterwards refers to the
        // expanded text, which is also what we draw.
        const lines: RawLine[] = hunk.lines.map((l) => ({ ...l, text: expandTabs(l.text, opts.tabWidth) }));

        const hidden = previousOldEnd === null ? hunk.oldStart - 1 : hunk.oldStart - previousOldEnd;
        rows.push({
            kind: 'hunk',
            key: `h${hunkIndex}`,
            text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            section: hunk.section.trim(),
            hidden: hidden > 0 ? hidden : undefined,
        });
        previousOldEnd = hunk.oldStart + hunk.oldLines;

        const syntax = rich && opts.syntax ? highlightHunk(lines, language) : null;
        const emphasis = rich && opts.intraline ? computeEmphasis(lines) : null;

        lines.forEach((line, lineIndex) => {
            if (line.type === 'add') additions++;
            else if (line.type === 'del') deletions++;

            const runs = syntax?.[lineIndex] ?? plainRuns(line.text);
            const ranges = emphasis?.get(lineIndex);
            const spans = mergeSpans(line.text, runs, ranges, line.type === 'add' ? 1 : 2);

            if (line.text.length > maxColumns) maxColumns = line.text.length;
            const no = Math.max(line.oldNo ?? 0, line.newNo ?? 0);
            if (no > maxLineNo) maxLineNo = no;

            rows.push({
                kind: 'line',
                key: `${hunkIndex}:${lineIndex}`,
                type: line.type,
                oldNo: line.oldNo,
                newNo: line.newNo,
                text: line.text,
                spans,
            });
        });
    });

    if (raw.kind === 'binary') {
        rows.push({ kind: 'message', key: 'binary', code: 'binary' });
    } else if (rows.length === 0) {
        rows.push({ kind: 'message', key: 'empty', code: 'empty' });
    }

    return {
        path: raw.path,
        oldPath: raw.oldPath && raw.oldPath !== raw.path ? raw.oldPath : undefined,
        kind: raw.kind,
        language,
        additions,
        deletions,
        rows,
        maxColumns,
        maxLineNo,
    };
}

/**
 * Highlights a hunk by reconstructing each side as contiguous text.
 *
 * Tokenizing line by line would break block comments and template literals; a
 * hunk is the largest contiguous region a patch actually gives us, so we
 * tokenize the old side and the new side once each and then redistribute the
 * runs back onto the interleaved lines.
 */
function highlightHunk(lines: RawLine[], language: string | null): SyntaxRun[][] {
    if (!language) return lines.map((l) => plainRuns(l.text));

    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    const oldText: string[] = [];
    const newText: string[] = [];

    lines.forEach((line, i) => {
        if (line.type !== 'add') { oldIdx.push(i); oldText.push(line.text); }
        if (line.type !== 'del') { newIdx.push(i); newText.push(line.text); }
    });

    const result: SyntaxRun[][] = new Array(lines.length);
    const oldRuns = highlightLines(oldText.join('\n'), language);
    const newRuns = highlightLines(newText.join('\n'), language);

    // Context lines exist on both sides; the new side wins so that a context
    // line reads the same as the addition right below it.
    oldIdx.forEach((lineIndex, i) => { result[lineIndex] = oldRuns[i] ?? plainRuns(lines[lineIndex].text); });
    newIdx.forEach((lineIndex, i) => { result[lineIndex] = newRuns[i] ?? result[lineIndex] ?? plainRuns(lines[lineIndex].text); });

    for (let i = 0; i < lines.length; i++) {
        if (!result[i]) result[i] = plainRuns(lines[i].text);
    }
    return result;
}

function plainRuns(text: string): SyntaxRun[] {
    return text.length ? [{ k: 'plain', n: text.length }] : [];
}

/**
 * Overlays word-diff ranges on top of syntax runs, splitting at every boundary
 * of either layer. Runs with the same class and emphasis are coalesced so a
 * typical line ends up as a handful of spans rather than one per character.
 */
export function mergeSpans(
    text: string,
    runs: SyntaxRun[],
    ranges: Range[] | undefined,
    emphasisValue: 1 | 2,
): DiffSpan[] {
    if (text.length === 0) return [];

    const spans: DiffSpan[] = [];
    let pos = 0;
    let rangeIndex = 0;

    const append = (from: number, to: number, k: SpanKind, e: 0 | 1 | 2) => {
        if (to <= from) return;
        const last = spans[spans.length - 1];
        if (last && last.k === k && last.e === e) last.t += text.slice(from, to);
        else spans.push({ t: text.slice(from, to), k, e });
    };

    for (const run of runs) {
        const runEnd = Math.min(pos + run.n, text.length);
        if (!ranges || ranges.length === 0) {
            append(pos, runEnd, run.k, 0);
            pos = runEnd;
            continue;
        }

        let cursor = pos;
        while (cursor < runEnd) {
            // Skip ranges we've already passed.
            while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= cursor) rangeIndex++;
            const range = ranges[rangeIndex];
            if (!range || range[0] >= runEnd) {
                append(cursor, runEnd, run.k, 0);
                break;
            }
            if (range[0] > cursor) {
                append(cursor, range[0], run.k, 0);
                cursor = range[0];
            }
            const end = Math.min(range[1], runEnd);
            append(cursor, end, run.k, emphasisValue);
            cursor = end;
        }
        pos = runEnd;
    }

    // Trailing text when runs came up short (defensive).
    if (pos < text.length) append(pos, text.length, 'plain', 0);
    return spans;
}

function expandTabs(text: string, width: number): string {
    if (text.indexOf('\t') === -1) return text;
    let out = '';
    let column = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\t') {
            const pad = width - (column % width);
            out += ' '.repeat(pad);
            column += pad;
        } else {
            out += ch;
            column++;
        }
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────────────────

const CACHE_LIMIT = 48;
const cache = new Map<string, DiffDocument>();

function cacheGet(key: string): DiffDocument | undefined {
    const hit = cache.get(key);
    if (hit) {
        // Refresh recency.
        cache.delete(key);
        cache.set(key, hit);
    }
    return hit;
}

function cacheSet(key: string, doc: DiffDocument): void {
    cache.set(key, doc);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function cacheKey(prefix: string, input: string, opts: Required<BuildOptions>): string {
    const flags = `${opts.contextLines}${opts.syntax ? 1 : 0}${opts.intraline ? 1 : 0}${opts.tabWidth}${opts.maxHighlightLines}`;
    return `${prefix}:${flags}:${input.length}:${fnv1a(input)}`;
}

/** FNV-1a over the input string — fast enough for megabyte patches. */
function fnv1a(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(36);
}

function now(): number {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
