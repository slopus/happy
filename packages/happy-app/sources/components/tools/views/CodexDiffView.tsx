import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata }) => {
    const { theme } = useUnistyles();
    const { input } = tool;

    const files: string[] = input?.files && Array.isArray(input.files) ? input.files : [];
    const stats = input?.stats as { additions?: number; deletions?: number } | undefined;

    if (files.length === 0) {
        return null;
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {stats && (stats.additions || stats.deletions) ? (
                    <View style={styles.statsRow}>
                        {stats.additions ? (
                            <Text style={[styles.statText, { color: theme.colors.success }]}>+{stats.additions}</Text>
                        ) : null}
                        {stats.deletions ? (
                            <Text style={[styles.statText, { color: theme.colors.textDestructive }]}>-{stats.deletions}</Text>
                        ) : null}
                    </View>
                ) : null}
                {files.map((file, index) => {
                    const resolved = resolvePath(file, metadata);
                    const fileName = resolved.split('/').pop() || resolved;
                    return (
                        <View key={index} style={styles.fileRow}>
                            <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        gap: 6,
    },
    statsRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 2,
    },
    statText: {
        fontSize: 13,
        fontFamily: 'monospace',
        fontWeight: '600',
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    fileName: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'monospace',
        flexShrink: 1,
    },
}));
