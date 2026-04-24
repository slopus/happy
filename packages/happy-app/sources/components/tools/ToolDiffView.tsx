import * as React from 'react';
import { View } from 'react-native';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { useSetting } from '@/sync/storage';

interface ToolDiffViewProps {
    /** Pre-built unified-diff patch string. Preferred when available. */
    patch?: string;
    /** Pair used to derive a patch if `patch` isn't supplied. */
    oldText?: string;
    newText?: string;
    /** File name — used for language detection in syntax highlighting. */
    fileName?: string;
    style?: any;
    /** No-op in the new renderer (pierre/diffs always draws line numbers via gutter). Kept for source compat. */
    showLineNumbers?: boolean;
    /** No-op in the new renderer; pierre/diffs uses classic indicators. */
    showPlusMinusSymbols?: boolean;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({
    patch,
    oldText,
    newText,
    fileName,
    style,
    showLineNumbers,
}) => {
    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');

    const effectiveFileName = fileName ?? 'file.txt';

    // Chat tool diffs are always inline unified — the split view lives on the
    // dedicated InlineFileDiff pane (controlled via the diffStyle setting).
    const common = {
        overflow: wrapLines ? ('wrap' as const) : ('scroll' as const),
        disableLineNumbers: !(showLineNumbers ?? showLineNumbersInToolViews),
        disableFileHeader: true,
        diffStyle: 'unified' as const,
    };

    if (patch) {
        return (
            <View style={[{ flex: 1 }, style]}>
                <PierreDiffView patch={patch} {...common} />
            </View>
        );
    }

    return (
        <View style={[{ flex: 1 }, style]}>
            <PierreDiffView
                oldFile={{ name: effectiveFileName, contents: oldText ?? '' }}
                newFile={{ name: effectiveFileName, contents: newText ?? '' }}
                {...common}
            />
        </View>
    );
});
