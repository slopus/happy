import * as React from 'react';
import { View, ScrollView } from 'react-native';
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
    let error: string | null = null;

    if (state === 'completed' && result) {
        const parsed = knownTools.Bash.result.safeParse(result);
        if (parsed.success) {
            parsedResult = parsed.data;
        }
    } else if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    return (
        <View style={toolFullViewStyles.section}>
            <ScrollView 
                horizontal
                showsHorizontalScrollIndicator={true}
            >
                <CommandView
                    command={input.command}
                    stdout={parsedResult?.stdout}
                    stderr={parsedResult?.stderr}
                    error={error}
                />
            </ScrollView>
        </View>
    );
});