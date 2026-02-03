import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { Metadata } from '@/sync/storageTypes';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

/**
 * Parse a unified diff to extract old and new content
 * This is a simplified parser that handles basic unified diff format
 */
function parseUnifiedDiff(unifiedDiff: string): { oldText: string; newText: string; fileName?: string } {
    const lines = unifiedDiff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let fileName: string | undefined;
    let inHunk = false;

    for (const line of lines) {
        // Extract filename from diff header
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            fileName = line.replace(/^\+\+\+ (b\/)?/, '');
            continue;
        }

        // Skip other header lines
        if (line.startsWith('diff --git') || 
            line.startsWith('index ') || 
            line.startsWith('---') ||
            line.startsWith('new file mode') ||
            line.startsWith('deleted file mode')) {
            continue;
        }

        // Hunk header
        if (line.startsWith('@@')) {
            inHunk = true;
            continue;
        }

        if (inHunk) {
            if (line.startsWith('+')) {
                // Added line
                newLines.push(line.substring(1));
            } else if (line.startsWith('-')) {
                // Removed line
                oldLines.push(line.substring(1));
            } else if (line.startsWith(' ')) {
                // Context line (unchanged)
                oldLines.push(line.substring(1));
                newLines.push(line.substring(1));
            } else if (line === '\\ No newline at end of file') {
                // Skip this meta line
                continue;
            } else if (line === '') {
                // Empty line in diff
                oldLines.push('');
                newLines.push('');
            }
        }
    }

    return {
        oldText: oldLines.join('\n'),
        newText: newLines.join('\n'),
        fileName
    };
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