import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { Metadata } from '@/sync/storageTypes';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';
import { parseUnifiedDiff } from '@/utils/codexUnifiedDiff';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata }) => {
    const { theme } = useUnistyles();
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input } = tool;

    // Parse the unified diff
    let oldText = '';
    let newText = '';
    let fileName: string | undefined;

    if (input?.unified_diff && typeof input.unified_diff === 'string') {
        const parsed = parseUnifiedDiff(input.unified_diff);
        oldText = parsed.oldText;
        newText = parsed.newText;
        fileName = parsed.fileName;
    }

    // If we have a filename, show it as a header
    const fileHeader = fileName ? (
        <View style={styles.fileHeader}>
            <Text style={styles.fileName}>{fileName}</Text>
        </View>
    ) : null;

    return (
        <>
            {fileHeader}
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    oldText={oldText} 
                    newText={newText} 
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
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
