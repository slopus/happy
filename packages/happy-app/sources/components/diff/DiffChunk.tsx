/**
 * The chat-sized diff: what you see when an agent edits a file mid-conversation.
 *
 * Tuned for glanceability rather than completeness — tight context, no file
 * header (the tool block already draws one), a low collapse threshold so a
 * 900-line edit can't push the rest of the conversation off screen, and no
 * horizontal scroll capture unless the code actually overflows.
 */

import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { DiffFileView } from './DiffFileView';
import { useDiffDocument, type DiffSource } from './useDiffDocument';

export interface DiffChunkProps {
    /** Unified patch. Takes precedence over the text pair. */
    patch?: string;
    /** Before/after pair, used when no patch is available. */
    oldText?: string;
    newText?: string;
    /** Drives language detection for syntax highlighting. */
    fileName?: string;
    showLineNumbers?: boolean;
    wrap?: boolean;
    /** Side-by-side layout. Only makes sense on wide screens. */
    split?: boolean;
    contextLines?: number;
    /** Rows shown before the "show more" button. */
    collapseAfter?: number;
    fontSize?: number;
    style?: ViewStyle;
}

export const DiffChunk = React.memo(function DiffChunk({
    patch,
    oldText,
    newText,
    fileName,
    showLineNumbers = true,
    wrap = false,
    split = false,
    contextLines = 3,
    collapseAfter = 80,
    fontSize,
    style,
}: DiffChunkProps) {
    const source = React.useMemo<DiffSource | null>(() => {
        if (patch) return { kind: 'patch', patch };
        if (oldText !== undefined || newText !== undefined) {
            return { kind: 'contents', path: fileName ?? 'file.txt', oldText: oldText ?? '', newText: newText ?? '' };
        }
        return null;
    }, [patch, oldText, newText, fileName]);

    const doc = useDiffDocument(source, { contextLines });

    if (doc.files.length === 0) return null;

    return (
        <View style={style}>
            {doc.files.map((file, index) => (
                <DiffFileView
                    key={`${file.path}:${index}`}
                    file={file}
                    fontSize={fontSize}
                    showLineNumbers={showLineNumbers}
                    wrap={wrap}
                    split={split}
                    collapseAfter={collapseAfter}
                    showHunkHeaders={file.rows.filter((r) => r.kind === 'hunk').length > 1}
                />
            ))}
        </View>
    );
});
