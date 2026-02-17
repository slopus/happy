import * as React from 'react';
import { View, Text } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { StyleSheet } from 'react-native-unistyles';
import { resolvePath } from '@/utils/pathUtils';

interface EditViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const EditViewFull = React.memo<EditViewFullProps>(({ tool, metadata }) => {
    const { input } = tool;

    // Trimmed mode: diff data was offloaded, view in session conversation instead
    if (input?._trimmed === true) {
        const filePath = typeof input.file_path === 'string' ? resolvePath(input.file_path, metadata) : '';
        return (
            <View style={toolFullViewStyles.sectionFullWidth}>
                <View style={trimmedStyles.container}>
                    <Text style={trimmedStyles.fileName}>{filePath}</Text>
                    <Text style={trimmedStyles.hint}>Diff available in session view</Text>
                </View>
            </View>
        );
    }

    // Parse the input
    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(input);
    if (parsed.success) {
        oldString = trimIdent(parsed.data.old_string || '');
        newString = trimIdent(parsed.data.new_string || '');
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            <ToolDiffView
                oldText={oldString}
                newText={newString}
                style={{ width: '100%' }}
                showLineNumbers={true}
                showPlusMinusSymbols={true}
            />
        </View>
    );
});

const trimmedStyles = StyleSheet.create((theme) => ({
    container: {
        padding: 16,
        alignItems: 'center',
        gap: 8,
    },
    fileName: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    hint: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));