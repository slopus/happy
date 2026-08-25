/**
 * Builds a `DiffDocument` from whatever a caller happens to have.
 *
 * The build itself is memoized inside the engine cache, so this hook is mostly
 * about giving components one stable input shape and a stable identity.
 */

import * as React from 'react';
import { buildDiffFromContents, buildDiffFromPatch, type BuildOptions } from './engine/buildDiff';
import type { DiffDocument } from './engine/types';

export type DiffSource =
    | { kind: 'patch'; patch: string }
    | { kind: 'contents'; path: string; oldText: string; newText: string };

const EMPTY: DiffDocument = { files: [], additions: 0, deletions: 0, buildMs: 0 };

export function useDiffDocument(source: DiffSource | null, options?: BuildOptions): DiffDocument {
    const contextLines = options?.contextLines;
    const syntax = options?.syntax;
    const intraline = options?.intraline;
    const tabWidth = options?.tabWidth;
    const maxHighlightLines = options?.maxHighlightLines;

    return React.useMemo(() => {
        if (!source) return EMPTY;
        const opts: BuildOptions = { contextLines, syntax, intraline, tabWidth, maxHighlightLines };
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
        contextLines,
        syntax,
        intraline,
        tabWidth,
        maxHighlightLines,
    ]);
}
