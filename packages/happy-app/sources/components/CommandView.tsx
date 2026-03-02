import * as React from 'react';
import { Text, View, StyleSheet, Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

// Known file extensions for detection
const FILE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'json', 'md', 'txt', 'py', 'sh', 'bash',
    'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'less',
    'rs', 'go', 'rb', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
    'sql', 'graphql', 'proto', 'env', 'conf', 'cfg', 'ini', 'lock',
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp',
    'pdf', 'csv', 'log', 'prisma', 'dockerfile', 'makefile',
    'gitignore', 'dockerignore', 'eslintrc', 'prettierrc',
]);

// Regex to detect absolute file paths in text
const FILE_PATH_REGEX = /(\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+)/g;

function isLikelyFilePath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    if (!ext) return false;
    return FILE_EXTENSIONS.has(ext);
}

interface TextWithPathsProps {
    text: string;
    style: any;
    sessionId?: string;
    pathStyle?: any;
}

const TextWithPaths = React.memo<TextWithPathsProps>(({ text, style, sessionId, pathStyle }) => {
    const router = useRouter();

    if (!sessionId) {
        return <Text style={style}>{text}</Text>;
    }

    const parts: { text: string; isPath: boolean }[] = [];
    let lastIndex = 0;

    // Reset regex state
    FILE_PATH_REGEX.lastIndex = 0;

    let match;
    while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
        const path = match[1];
        if (!isLikelyFilePath(path)) continue;

        // Add text before the path
        if (match.index > lastIndex) {
            parts.push({ text: text.slice(lastIndex, match.index), isPath: false });
        }
        parts.push({ text: path, isPath: true });
        lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
        parts.push({ text: text.slice(lastIndex), isPath: false });
    }

    // If no paths found, just render plain text
    if (parts.length === 0 || (parts.length === 1 && !parts[0].isPath)) {
        return <Text style={style}>{text}</Text>;
    }

    return (
        <Text style={style}>
            {parts.map((part, i) => {
                if (!part.isPath) {
                    return <Text key={i}>{part.text}</Text>;
                }
                return (
                    <Text
                        key={i}
                        style={pathStyle}
                        onPress={() => {
                            const encoded = btoa(part.text);
                            router.push(`/session/${sessionId}/file?path=${encoded}`);
                        }}
                    >
                        {part.text}
                    </Text>
                );
            })}
        </Text>
    );
});

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
    sessionId?: string;
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
    sessionId,
}) => {
    const { theme } = useUnistyles();
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined;

    const styles = StyleSheet.create({
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
        filePath: {
            textDecorationLine: 'underline' as const,
            opacity: 0.85,
        },
    });

    return (
        <View style={[
            styles.container,
            maxHeight ? { maxHeight } : undefined,
            fullWidth ? { width: '100%' } : undefined
        ]}>
            {/* Command Line */}
            <View style={styles.line}>
                <Text style={styles.promptText}>{prompt} </Text>
                <Text style={styles.commandText}>{command}</Text>
            </View>

            {hasNewProps ? (
                <>
                    {/* Standard Output */}
                    {stdout && stdout.trim() && (
                        <TextWithPaths text={stdout} style={styles.stdout} sessionId={sessionId} pathStyle={styles.filePath} />
                    )}

                    {/* Standard Error */}
                    {stderr && stderr.trim() && (
                        <TextWithPaths text={stderr} style={styles.stderr} sessionId={sessionId} pathStyle={styles.filePath} />
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
                    <Text style={styles.commandText}>{'\n---\n' + output}</Text>
                )
            )}
        </View>
    );
});
