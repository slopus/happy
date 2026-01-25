import * as React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { toolFullViewStyles } from '../ToolFullView';
import { CommandView } from '@/components/CommandView';
import { extractShellCommand } from '../utils/shellCommand';
import { maybeParseJson } from '../utils/parseJson';
import { extractStdStreams, tailTextWithEllipsis } from '../utils/stdStreams';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const BashViewFull = React.memo<BashViewFullProps>(({ tool, metadata }) => {
    const { input, result, state } = tool;
    const command = extractShellCommand(input) ?? (typeof (input as any)?.command === 'string' ? (input as any).command : '');

    // Parse the result
    const parsedStreams = extractStdStreams(result);
    let unparsedOutput: string | null = null;
    let error: string | null = null;

    if (state === 'error' && typeof result === 'string') {
        error = result;
    } else if (result) {
        const parsedMaybe = maybeParseJson(result);
        if (typeof parsedMaybe === 'string') {
            unparsedOutput = parsedMaybe;
        } else if (!parsedStreams) {
            unparsedOutput = JSON.stringify(parsedMaybe);
        }
    }

    const maxStreamingChars = 8000;
    const stdout =
        parsedStreams?.stdout
            ? (state === 'running' ? tailTextWithEllipsis(parsedStreams.stdout, maxStreamingChars) : parsedStreams.stdout)
            : unparsedOutput;
    const stderr =
        parsedStreams?.stderr
            ? (state === 'running' ? tailTextWithEllipsis(parsedStreams.stderr, maxStreamingChars) : parsedStreams.stderr)
            : null;

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
                            command={command}
                            stdout={stdout}
                            stderr={stderr}
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
