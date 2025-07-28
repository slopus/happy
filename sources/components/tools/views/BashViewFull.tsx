import * as React from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { resolvePath } from '@/utils/pathUtils';
import { toolFullViewStyles } from '../ToolFullView';
import { BashTerminalView } from '@/components/BashTerminalView';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const BashViewFull = React.memo<BashViewFullProps>(({ tool, metadata }) => {
    const { input, result, state } = tool;
    
    // Parse the result
    let parsedResult: { stdout?: string; stderr?: string } | null = null;
    let error: string | null = null;
    
    if (state === 'completed' && result) {
        const parsed = knownTools.Bash.result.safeParse(result);
        if (parsed.success) {
            parsedResult = parsed.data;
        }
    } else if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    // Extract working directory if available
    const workingDir = input.cwd ? resolvePath(input.cwd, metadata) : null;

    return (
        <>
            {/* Terminal Output */}
            <View style={toolFullViewStyles.section}>
                <View style={toolFullViewStyles.sectionHeader}>
                    <Ionicons name="terminal" size={20} color="#5856D6" />
                    <Text style={toolFullViewStyles.sectionTitle}>Terminal</Text>
                </View>
                <BashTerminalView
                    command={input.command}
                    stdout={parsedResult?.stdout}
                    stderr={parsedResult?.stderr}
                    error={error}
                />
            </View>

            {/* Working Directory */}
            {workingDir && (
                <View style={toolFullViewStyles.section}>
                    <View style={toolFullViewStyles.sectionHeader}>
                        <Ionicons name="folder" size={20} color="#5856D6" />
                        <Text style={toolFullViewStyles.sectionTitle}>Working Directory</Text>
                    </View>
                    <Text style={styles.monoText}>{workingDir}</Text>
                </View>
            )}

            {/* Timeout */}
            {input.timeout && (
                <View style={toolFullViewStyles.section}>
                    <View style={toolFullViewStyles.sectionHeader}>
                        <Ionicons name="timer" size={20} color="#5856D6" />
                        <Text style={toolFullViewStyles.sectionTitle}>Timeout</Text>
                    </View>
                    <Text style={styles.timeoutText}>{input.timeout}ms</Text>
                </View>
            )}
        </>
    );
});

const styles = StyleSheet.create({
    monoText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 14,
        color: '#333',
    },
    timeoutText: {
        fontSize: 14,
        color: '#666',
        fontWeight: '500',
    },
});