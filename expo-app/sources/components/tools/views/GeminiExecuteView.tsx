import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { t } from '@/text';
import { CommandView } from '@/components/CommandView';
import { extractShellCommand } from '../utils/shellCommand';
import { extractStdStreams, tailTextWithEllipsis } from '../utils/stdStreams';

/**
 * Extract execute command info from Gemini's nested input format.
 */
function extractExecuteInfo(input: any): { command: string; description: string; cwd: string } {
    let command = '';
    let description = '';
    let cwd = '';
    
    // Try to get title from toolCall.title
    // Format: "rm file.txt [current working directory /path] (description)"
    if (input?.toolCall?.title) {
        const fullTitle = input.toolCall.title;
        
        // Extract command (before [)
        const bracketIdx = fullTitle.indexOf(' [');
        if (bracketIdx > 0) {
            command = fullTitle.substring(0, bracketIdx);
        } else {
            command = fullTitle;
        }
        
        // Extract cwd from [current working directory /path]
        const cwdMatch = fullTitle.match(/\[current working directory ([^\]]+)\]/);
        if (cwdMatch) {
            cwd = cwdMatch[1];
        }
        
        // Extract description from (...)
        const descMatch = fullTitle.match(/\(([^)]+)\)$/);
        if (descMatch) {
            description = descMatch[1];
        }
    }
    
    return { command, description, cwd };
}

/**
 * Gemini Execute View
 * 
 * Displays shell/terminal commands from Gemini's execute tool.
 */
export const GeminiExecuteView = React.memo<ToolViewProps>(({ tool, metadata, messages, sessionId }) => {
    const nested = extractExecuteInfo(tool.input);
    const command = nested.command || extractShellCommand(tool.input) || '';
    const { description, cwd } = nested;

    if (!command) {
        return null;
    }

    const streams = extractStdStreams(tool.result);
    const rawResult = tool.result as any;
    const stdoutFallback =
        typeof rawResult === 'string'
            ? rawResult
            : typeof rawResult?.stdout === 'string'
                ? rawResult.stdout
                : typeof rawResult?.formatted_output === 'string'
                    ? rawResult.formatted_output
                    : typeof rawResult?.aggregated_output === 'string'
                        ? rawResult.aggregated_output
                        : null;
    const stderrFallback =
        typeof rawResult?.stderr === 'string'
            ? rawResult.stderr
            : null;
    const maxStdout = tool.state === 'running' ? 2000 : 6000;
    const maxStderr = tool.state === 'running' ? 1200 : 3000;
    const stdout = (streams?.stdout ?? stdoutFallback)
        ? tailTextWithEllipsis((streams?.stdout ?? stdoutFallback) as string, maxStdout)
        : null;
    const stderr = (streams?.stderr ?? stderrFallback)
        ? tailTextWithEllipsis((streams?.stderr ?? stderrFallback) as string, maxStderr)
        : null;

    return (
        <>
            <ToolSectionView>
                <CommandView
                    command={command}
                    stdout={stdout}
                    stderr={stderr}
                    error={null}
                    hideEmptyOutput
                    fullWidth
                />
            </ToolSectionView>
            {(description || cwd) && (
                <View style={styles.infoContainer}>
                    {cwd && (
                        <Text style={styles.cwdText}>{t('tools.geminiExecute.cwd', { cwd })}</Text>
                    )}
                    {description && (
                        <Text style={styles.descriptionText}>{description}</Text>
                    )}
                </View>
            )}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    infoContainer: {
        paddingHorizontal: 12,
        paddingBottom: 8,
    },
    cwdText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    descriptionText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
}));
