import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { CodeView } from '@/components/CodeView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { t } from '@/text';

interface CodexBashViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexBashView = React.memo<CodexBashViewProps>(({ tool, metadata }) => {
    const { theme } = useUnistyles();
    const { input, result, state } = tool;

    // Parse the input structure
    const command = input?.command;
    const cwd = input?.cwd;
    const parsedCmd = input?.parsed_cmd;

    // Determine the type of operation from parsed_cmd
    let operationType: 'read' | 'write' | 'bash' | 'unknown' = 'unknown';
    let fileName: string | null = null;
    let commandStr: string | null = null;

    if (parsedCmd && Array.isArray(parsedCmd) && parsedCmd.length > 0) {
        const firstCmd = parsedCmd[0];
        operationType = firstCmd.type || 'unknown';
        fileName = firstCmd.name || null;
        commandStr = firstCmd.cmd || null;
    }

    // Get the appropriate icon based on operation type
    let icon: React.ReactNode;
    switch (operationType) {
        case 'read':
            icon = <Octicons name="eye" size={18} color={theme.colors.textSecondary} />;
            break;
        case 'write':
            icon = <Octicons name="file-diff" size={18} color={theme.colors.textSecondary} />;
            break;
        default:
            icon = <Octicons name="terminal" size={18} color={theme.colors.textSecondary} />;
    }

    // Format the display based on operation type
    if (operationType === 'read' && fileName) {
        // Display as a read operation
        const resolvedPath = resolvePath(fileName, metadata);
        
        return (
            <ToolSectionView>
                <View style={styles.readContainer}>
                    <View style={styles.iconRow}>
                        {icon}
                        <Text style={styles.operationText}>{t('tools.desc.readingFile', { file: resolvedPath })}</Text>
                    </View>
                    {commandStr && (
                        <Text style={styles.commandText}>{commandStr}</Text>
                    )}
                </View>
            </ToolSectionView>
        );
    } else if (operationType === 'write' && fileName) {
        // Display as a write operation
        const resolvedPath = resolvePath(fileName, metadata);
        
        return (
            <ToolSectionView>
                <View style={styles.readContainer}>
                    <View style={styles.iconRow}>
                        {icon}
                        <Text style={styles.operationText}>{t('tools.desc.writingFile', { file: resolvedPath })}</Text>
                    </View>
                    {commandStr && (
                        <Text style={styles.commandText}>{commandStr}</Text>
                    )}
                </View>
            </ToolSectionView>
        );
    } else {
        // Display as a regular command
        const commandDisplay = commandStr || (command && Array.isArray(command) ? command.join(' ') : '');
        
        return (
            <ToolSectionView>
                <CommandView 
                    command={commandDisplay}
                    stdout={null}
                    stderr={null}
                    error={state === 'error' && typeof result === 'string' ? result : null}
                    hideEmptyOutput
                />
            </ToolSectionView>
        );
    }
});

const styles = StyleSheet.create((theme) => ({
    readContainer: {
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
    },
    iconRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    operationText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    commandText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
        marginTop: 8,
    },
}));