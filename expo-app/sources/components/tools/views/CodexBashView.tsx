import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolSectionView } from '../ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { t } from '@/text';
import type { ToolViewProps } from './_registry';
import { extractStdStreams, tailTextWithEllipsis } from '../utils/stdStreams';
import { StructuredResultView } from './StructuredResultView';

export const CodexBashView = React.memo<ToolViewProps>(({ tool, metadata, messages, sessionId }) => {
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
                <StructuredResultView tool={tool} metadata={metadata} messages={messages} sessionId={sessionId} />
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
                <StructuredResultView tool={tool} metadata={metadata} messages={messages} sessionId={sessionId} />
            </ToolSectionView>
        );
    } else {
        // Display as a regular command
        const commandDisplay = commandStr || (command && Array.isArray(command) ? command.join(' ') : '');

        const streams = extractStdStreams(result);
        const stdout = streams?.stdout
            ? tailTextWithEllipsis(streams.stdout, state === 'running' ? 2000 : 6000)
            : null;
        const stderr = streams?.stderr
            ? tailTextWithEllipsis(streams.stderr, state === 'running' ? 1200 : 3000)
            : null;
        
        return (
            <ToolSectionView>
                <CommandView 
                    command={commandDisplay}
                    stdout={stdout}
                    stderr={stderr}
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
