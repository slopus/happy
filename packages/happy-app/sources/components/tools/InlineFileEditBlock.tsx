import * as React from 'react';
import { Text, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getDiffStats, getPatchDiffStats } from '@/components/diff/calculateDiff';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { ToolSectionView } from '@/components/tools/ToolSectionView';
import { trimIdent } from '@/utils/trimIdent';

interface InlineFileEditBlockProps {
    filePath: string;
    fileName: string;
    kindLabel?: string | null;
    movePath?: string | null;
    patch?: string;
    oldText?: string;
    newText?: string;
    permissionFooter?: React.ReactNode;
}

export const InlineFileEditBlock = React.memo<InlineFileEditBlockProps>(({
    filePath,
    fileName,
    kindLabel,
    movePath,
    patch,
    oldText,
    newText,
    permissionFooter,
}) => {
    const { theme } = useUnistyles();
    const hasPair = oldText !== undefined || newText !== undefined;
    const displayOldText = React.useMemo(
        () => oldText === undefined ? undefined : trimIdent(oldText),
        [oldText],
    );
    const displayNewText = React.useMemo(
        () => newText === undefined ? undefined : trimIdent(newText),
        [newText],
    );
    const stats = React.useMemo(
        () => patch
            ? getPatchDiffStats(patch)
            : hasPair
                ? getDiffStats(displayOldText ?? '', displayNewText ?? '')
                : null,
        [displayNewText, displayOldText, hasPair, patch],
    );

    return (
        <ToolSectionView fullWidth>
            <View style={styles.block}>
                <View style={styles.fileHeader}>
                    <View style={styles.fileHeaderMain}>
                        <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                        <Text style={styles.filePath} numberOfLines={1}>{filePath}</Text>
                        {kindLabel ? <Text style={styles.kindLabel}>{kindLabel}</Text> : null}
                        {stats && (stats.additions > 0 || stats.deletions > 0) ? (
                            <View style={styles.stats}>
                                {stats.additions > 0 ? <Text style={styles.added}>+{stats.additions}</Text> : null}
                                {stats.deletions > 0 ? <Text style={styles.removed}>-{stats.deletions}</Text> : null}
                            </View>
                        ) : null}
                    </View>
                    {movePath ? <Text style={styles.movePath}>{movePath}</Text> : null}
                </View>
                {patch ? (
                    <ToolDiffView patch={patch} fileName={fileName} />
                ) : hasPair && ((displayOldText?.length ?? 0) > 0 || (displayNewText?.length ?? 0) > 0) ? (
                    <ToolDiffView
                        oldText={displayOldText ?? ''}
                        newText={displayNewText ?? ''}
                        fileName={fileName}
                    />
                ) : null}
                {permissionFooter ? (
                    <View style={styles.permissionFooterContainer}>
                        {permissionFooter}
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    block: {
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        overflow: 'hidden',
    },
    permissionFooterContainer: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
    fileHeader: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        gap: 4,
    },
    fileHeaderMain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    filePath: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'monospace',
        flex: 1,
    },
    kindLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    movePath: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    stats: {
        flexDirection: 'row',
        gap: 8,
    },
    added: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#34C759',
    },
    removed: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#FF3B30',
    },
}));