import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { t } from '@/text';

interface CodexPatchViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexPatchView = React.memo<CodexPatchViewProps>(({ tool, metadata }) => {
    const { theme } = useUnistyles();
    const { input } = tool;

    // Parse the changes to get list of files
    const files: string[] = [];
    if (input?.changes && typeof input.changes === 'object') {
        files.push(...Object.keys(input.changes));
    }

    // If no files, show nothing
    if (files.length === 0) {
        return null;
    }

    // For single file, show inline
    if (files.length === 1) {
        const filePath = resolvePath(files[0], metadata);
        const fileName = filePath.split('/').pop() || filePath;
        
        return (
            <ToolSectionView>
                <View style={styles.fileContainer}>
                    <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                    <Text style={styles.fileName}>{fileName}</Text>
                </View>
            </ToolSectionView>
        );
    }

    // For multiple files, show as list
    return (
        <ToolSectionView>
            <View style={styles.filesContainer}>
                {files.map((file, index) => {
                    const filePath = resolvePath(file, metadata);
                    const fileName = filePath.split('/').pop() || filePath;
                    
                    return (
                        <View key={index} style={styles.fileRow}>
                            <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                            <Text style={styles.fileNameMulti}>{fileName}</Text>
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    fileContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
    },
    filesContainer: {
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        gap: 8,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    fileNameMulti: {
        fontSize: 13,
        color: theme.colors.text,
    },
}));