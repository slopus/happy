import * as React from 'react';
import { Text, View, StyleSheet, Platform, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { darkTheme } from '@/theme';
import { SyntaxText } from './SyntaxText';

interface CommandViewProps {
    command: string;
    prompt?: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
    // Legacy prop for backward compatibility
    output?: string | null;
    maxHeight?: number;
    fullWidth?: boolean;
    hideEmptyOutput?: boolean;
    /** Detail-only: compact chat rows never enqueue tokenization. */
    syntaxHighlighting?: boolean;
    /** null for activity labels (waiting, stopping), which are not shell code. */
    commandLanguage?: 'bash' | 'powershell' | null;
}

export const CommandView = React.memo<CommandViewProps>(({
    command,
    prompt = '$',
    stdout,
    stderr,
    error,
    output,
    maxHeight,
    fullWidth,
    hideEmptyOutput,
    syntaxHighlighting = false,
    commandLanguage = 'bash',
}) => {
    const { theme } = useUnistyles();
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined;

    const styles = React.useMemo(() => StyleSheet.create({
        container: {
            backgroundColor: theme.colors.terminal.background,
            borderRadius: 8,
            overflow: 'hidden',
            padding: 16,
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
        },
        line: {
            alignItems: 'baseline',
            flexDirection: 'row',
            flexWrap: 'wrap',
        },
        promptText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            lineHeight: 20,
            color: theme.colors.terminal.prompt,
            fontWeight: '600',
        },
        commandText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            color: theme.colors.terminal.command,
            lineHeight: 20,
            flex: 1,
        },
        stdout: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stdout,
            lineHeight: 18,
            marginTop: 8,
        },
        stderr: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stderr,
            lineHeight: 18,
            marginTop: 8,
        },
        error: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.error,
            lineHeight: 18,
            marginTop: 8,
        },
        emptyOutput: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.emptyOutput,
            lineHeight: 18,
            marginTop: 8,
            fontStyle: 'italic',
        },
    }), [theme]);

    // The terminal surface stays dark in both themes. Plain runs inherit the
    // command/stdout/stderr color; classified tokens use the dark diff palette.
    const terminalText = (code: string, style: TextStyle, language: string | null) => syntaxHighlighting && language ? (
        <SyntaxText code={code} language={language} style={style} colors={darkTheme.colors.diff.syntax} />
    ) : <Text style={style} selectable={syntaxHighlighting}>{code}</Text>;

    return (
        <View style={[
            styles.container, 
            maxHeight ? { maxHeight } : undefined,
            fullWidth ? { width: '100%' } : undefined
        ]}>
            {/* Command Line */}
            <View style={styles.line}>
                {prompt ? <Text style={styles.promptText}>{prompt} </Text> : null}
                {terminalText(command, styles.commandText, commandLanguage)}
            </View>

            {hasNewProps ? (
                <>
                    {/* Standard Output */}
                    {stdout && stdout.trim() && (
                        terminalText(stdout, styles.stdout, 'shell-session')
                    )}

                    {/* Standard Error */}
                    {stderr && stderr.trim() && (
                        terminalText(stderr, styles.stderr, 'shell-session')
                    )}

                    {/* Error Message */}
                    {error && (
                        <Text style={styles.error}>{error}</Text>
                    )}

                    {/* Empty output indicator */}
                    {!stdout && !stderr && !error && !hideEmptyOutput && (
                        <Text style={styles.emptyOutput}>[Command completed with no output]</Text>
                    )}
                </>
            ) : (
                /* Legacy output format */
                output && (
                    terminalText('\n---\n' + output, styles.commandText, 'shell-session')
                )
            )}
        </View>
    );
});

