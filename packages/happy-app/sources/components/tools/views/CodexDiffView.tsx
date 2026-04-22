import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { Metadata } from '@/sync/storageTypes';
import { parseUnifiedDiff } from '@/utils/codexUnifiedDiff';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata }) => {
    const { input } = tool;
    const patch = typeof input?.unified_diff === 'string' ? input.unified_diff : undefined;
    const fileName = patch ? parseUnifiedDiff(patch).fileName : undefined;

    if (!patch) return null;

    return (
        <>
            {fileName ? (
                <View style={styles.fileHeader}>
                    <Text style={styles.fileName}>{fileName}</Text>
                </View>
            ) : null}
            <ToolSectionView fullWidth>
                <ToolDiffView patch={patch} fileName={fileName} />
            </ToolSectionView>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    fileHeader: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    fileName: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
}));
