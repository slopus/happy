import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { Metadata } from '@/sync/storageTypes';
import { parseUnifiedDiff } from '@/utils/codexUnifiedDiff';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata }) => {
    const { input } = tool;
    const patch = typeof input?.unified_diff === 'string' ? input.unified_diff : undefined;
    const fileName = patch ? parseUnifiedDiff(patch).fileName : undefined;
    const stats = React.useMemo(() => (patch ? getPatchDiffStats(patch) : null), [patch]);

    if (!patch) return null;

    return (
        <>
            {fileName ? (
                <View style={styles.fileHeader}>
                    <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                    {stats && (stats.additions > 0 || stats.deletions > 0) ? (
                        <DiffStats additions={stats.additions} deletions={stats.deletions} />
                    ) : null}
                </View>
            ) : null}
            <ToolSectionView fullWidth>
                <ToolDiffView patch={patch} fileName={fileName} />
            </ToolSectionView>
        </>
    );
});

const DiffStats = React.memo<{ additions: number; deletions: number }>(({ additions, deletions }) => (
    <View style={styles.stats}>
        {additions > 0 ? <Text style={styles.added}>+{additions}</Text> : null}
        {deletions > 0 ? <Text style={styles.removed}>-{deletions}</Text> : null}
    </View>
));

const styles = StyleSheet.create((theme) => ({
    fileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    fileName: {
        flex: 1,
        fontSize: 13,
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
