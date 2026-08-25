/** Resolves the current theme into the flat color set the diff rows read. */

import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { SpanKind } from './engine/types';

export interface DiffPalette {
    surface: string;
    rowBg: Record<'add' | 'del' | 'ctx', string>;
    gutterBg: Record<'add' | 'del' | 'ctx', string>;
    gutterBorder: string;
    lineNumber: string;
    marker: Record<'add' | 'del' | 'ctx', string>;
    wordBg: { add: string; del: string };
    hunkBg: string;
    hunkText: string;
    sectionText: string;
    syntax: Record<SpanKind, string>;
    divider: string;
    textSecondary: string;
    text: string;
}

export function useDiffPalette(): DiffPalette {
    const { theme } = useUnistyles();
    return React.useMemo<DiffPalette>(() => {
        const d = theme.colors.diff;
        return {
            surface: theme.colors.surface,
            rowBg: { add: d.rowAddedBg, del: d.rowRemovedBg, ctx: d.rowContextBg },
            gutterBg: { add: d.gutterAddedBg, del: d.gutterRemovedBg, ctx: d.gutterContextBg },
            gutterBorder: d.gutterBorder,
            lineNumber: d.lineNumberText,
            marker: { add: d.markerAdded, del: d.markerRemoved, ctx: d.lineNumberText },
            wordBg: { add: d.wordAddedBg, del: d.wordRemovedBg },
            hunkBg: d.hunkHeaderBg,
            hunkText: d.hunkHeaderText,
            sectionText: d.sectionText,
            syntax: d.syntax,
            divider: theme.colors.divider,
            textSecondary: theme.colors.textSecondary,
            text: theme.colors.text,
        };
    }, [theme]);
}
