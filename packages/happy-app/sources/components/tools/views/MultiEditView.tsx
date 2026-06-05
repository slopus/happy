import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';

export const MultiEditView = React.memo<ToolViewProps>(({ tool }) => {
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];

    const parsed = knownTools.MultiEdit.input.safeParse(tool.input);
    if (parsed.success && parsed.data.edits) {
        edits = parsed.data.edits;
    }

    if (edits.length === 0) {
        return null;
    }

    return (
        <ToolSectionView fullWidth>
            {edits.map((edit, index) => {
                const oldString = trimIdent(edit.old_string || '');
                const newString = trimIdent(edit.new_string || '');
                return (
                    <View key={index}>
                        <ToolDiffView oldText={oldString} newText={newString} />
                        {index < edits.length - 1 && <View style={styles.separator} />}
                    </View>
                );
            })}
        </ToolSectionView>
    );
});

const styles = StyleSheet.create({
    separator: {
        height: 8,
    },
});