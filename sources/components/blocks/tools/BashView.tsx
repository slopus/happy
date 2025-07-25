import * as React from 'react';
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { ToolSectionView } from '../ToolSectionView';
import { CommandView } from '../CommandView';

interface BashViewProps {
    tool: ToolCall;
}

export const BashView = React.memo<BashViewProps>(({ tool }) => {
    const { input, result, state } = tool;
    
    return (
        <>
            <ToolSectionView>
                <CommandView command={input.command} />

                {input.timeout && (
                    <Text style={styles.timeout}>Timeout: {input.timeout}ms</Text>
                )}
            </ToolSectionView>

            {state === 'running' && (
                <ToolSectionView>
                    <View style={styles.runningContainer}>
                        <ActivityIndicator size="small" color="#007AFF" />
                        <Text style={styles.runningText}>Running command...</Text>
                    </View>
                </ToolSectionView>
            )}

            {state === 'completed' && result && (
                <ToolSectionView title="Output">
                    <CodeView code={String(result)} />
                </ToolSectionView>
            )}
        </>
    );
});

const styles = StyleSheet.create({
    timeout: {
        fontSize: 11,
        color: '#666',
        marginTop: 8,
    },
    runningContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
    },
    runningText: {
        fontSize: 13,
        color: '#007AFF',
    },
});