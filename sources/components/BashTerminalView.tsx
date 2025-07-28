import * as React from 'react';
import { Text, View, StyleSheet, Platform, ScrollView } from 'react-native';

interface BashTerminalViewProps {
    command: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
    prompt?: string;
}

export const BashTerminalView = React.memo<BashTerminalViewProps>(({
    command,
    stdout,
    stderr,
    error,
    prompt = '$',
}) => {
    return (
        <View style={styles.container}>
            <ScrollView 
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.scrollContent}
            >
                {/* Command Line */}
                <View style={styles.line}>
                    <Text style={styles.prompt}>{prompt} </Text>
                    <Text style={styles.command}>{command}</Text>
                </View>
                
                {/* Standard Output */}
                {stdout && stdout.trim() && (
                    <Text style={styles.stdout}>{stdout}</Text>
                )}
                
                {/* Standard Error */}
                {stderr && stderr.trim() && (
                    <Text style={styles.stderr}>{stderr}</Text>
                )}
                
                {/* Error Message */}
                {error && (
                    <Text style={styles.error}>{error}</Text>
                )}
                
                {/* Empty output indicator */}
                {!stdout && !stderr && !error && (
                    <Text style={styles.emptyOutput}>[Command completed with no output]</Text>
                )}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#1E1E1E',
        borderRadius: 8,
        overflow: 'hidden',
        maxHeight: 400,
    },
    scrollContent: {
        padding: 16,
    },
    line: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    prompt: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 14,
        color: '#34C759',
        fontWeight: '600',
    },
    command: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 14,
        color: '#E0E0E0',
        lineHeight: 20,
        flex: 1,
    },
    stdout: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: '#E0E0E0',
        lineHeight: 18,
        marginTop: 8,
    },
    stderr: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: '#FFB86C',
        lineHeight: 18,
        marginTop: 8,
    },
    error: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: '#FF5555',
        lineHeight: 18,
        marginTop: 8,
    },
    emptyOutput: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: '#6272A4',
        lineHeight: 18,
        marginTop: 8,
        fontStyle: 'italic',
    },
});