/**
 * Builds a `DiffDocument` from whatever a caller happens to have.
 *
 * The build itself is memoized inside the engine cache, so this hook is mostly
 * about giving components one stable input shape and a stable identity.
 */

import * as React from 'react';
import { buildDiffFromContents, buildDiffFromPatch, type BuildOptions, type DiffBudget } from './engine/buildDiff';
import type { DiffDocument } from './engine/types';

export type DiffSource =
    | { kind: 'patch'; patch: string }
    | {
        kind: 'contents';
        path: string;
        oldText: string;
        newText: string;
        /** Optional per-source context override for full-content diffs. */
        contextLines?: number;
        /** Optional per-source whitespace filtering for full-content diffs. */
        ignoreWhitespace?: boolean;
        /** Optional abort budget for expensive full-content diffs. */
        diffBudget?: DiffBudget;
    };

const EMPTY: DiffDocument = { files: [], additions: 0, deletions: 0, buildMs: 0 };

export function useDiffDocument(source: DiffSource | null, options?: BuildOptions): DiffDocument {
    const contextLines = options?.contextLines ?? (source?.kind === 'contents' ? source.contextLines : undefined);
    const ignoreWhitespace = options?.ignoreWhitespace ?? (source?.kind === 'contents' ? source.ignoreWhitespace : undefined);
    const diffBudget = options?.diffBudget ?? (source?.kind === 'contents' ? source.diffBudget : undefined);
    const syntax = options?.syntax;
    const intraline = options?.intraline;
    const tabWidth = options?.tabWidth;
    const maxHighlightLines = options?.maxHighlightLines;

    return React.useMemo(() => {
        if (!source) return EMPTY;
        const opts: BuildOptions = { contextLines, ignoreWhitespace, diffBudget, syntax, intraline, tabWidth, maxHighlightLines };
        if (source.kind === 'patch') {
            return buildDiffFromPatch(source.patch, opts);
        }
        return buildDiffFromContents(source.path, source.oldText, source.newText, opts);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        source?.kind,
        source?.kind === 'patch' ? source.patch : null,
        source?.kind === 'contents' ? source.path : null,
        source?.kind === 'contents' ? source.oldText : null,
        source?.kind === 'contents' ? source.newText : null,
        source?.kind === 'contents' ? source.contextLines : null,
        source?.kind === 'contents' ? source.ignoreWhitespace : null,
        source?.kind === 'contents' ? source.diffBudget?.timeoutMs : null,
        source?.kind === 'contents' ? source.diffBudget?.maxEditLength : null,
        contextLines,
        ignoreWhitespace,
        diffBudget?.timeoutMs,
        diffBudget?.maxEditLength,
        syntax,
        intraline,
        tabWidth,
        maxHighlightLines,
    ]);
}
