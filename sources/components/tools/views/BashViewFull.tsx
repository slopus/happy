import * as React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { CommandView } from '@/components/CommandView';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const BashViewFull = React.memo<BashViewFullProps>(({ tool, metadata }) => {
    const { input, result, state } = tool;

    // Parse the result
    let parsedResult: { stdout?: string; stderr?: string } | null = null;
    let unparsedOutput: string | null = null;
    let error: string | null = null;

    if (state === 'completed' && result) {
        if (typeof result === 'string') {
            // Handle unparsed string result
            unparsedOutput = result;
        } else {
            // Try to parse as structured result
            const parsed = knownTools.Bash.result.safeParse(result);
            if (parsed.success) {
                parsedResult = parsed.data;
            } else {
                // If parsing fails but it's not a string, stringify it
                unparsedOutput = JSON.stringify(result);
            }
        }
    } else if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    return (
        <View style={styles.container}>
            <View style={styles.terminalContainer}>
                <ScrollView 
                    horizontal
                    showsHorizontalScrollIndicator={true}
                    contentContainerStyle={styles.scrollContent}
                >
                    <View style={styles.commandWrapper}>
                        <CommandView
                            command={input.command}
                            stdout={parsedResult?.stdout || unparsedOutput}
                            stderr={parsedResult?.stderr}
                            error={error}
                            fullWidth
                        />
                    </View>
                </ScrollView>
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 0,
        paddingTop: 32,
        paddingBottom: 64,
        marginBottom: 0,
        flex: 1,
    },
    terminalContainer: {
        flex: 1,
    },
    scrollContent: {
        flexGrow: 1,
    },
    commandWrapper: {
        flex: 1,
        minWidth: '100%',
    },
});