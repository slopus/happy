import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolSectionView } from '../ToolSectionView';
import { ToolViewProps } from './_all';
import { DiffView } from '@/components/files/DiffView';
import { knownTools } from '../knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';

export const MultiEditView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbers = useSetting('showLineNumbers');
    
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    
    const parsed = knownTools.MultiEdit.input.safeParse(tool.input);
    if (parsed.success && parsed.data.edits) {
        edits = parsed.data.edits;
    }

    if (edits.length === 0) {
        return null;
    }

    return (
        <>
            {edits.map((edit, index) => {
                const oldString = trimIdent(edit.old_string || '');
                const newString = trimIdent(edit.new_string || '');
                
                return (
                    <View key={index}>
                        <ToolSectionView>
                            <DiffView 
                                oldText={oldString} 
                                newText={newString} 
                                wrapLines={false}
                                showLineNumbers={showLineNumbers}
                            />
                        </ToolSectionView>
                        {index < edits.length - 1 && <View style={styles.separator} />}
                    </View>
                );
            })}
        </>
    );
});

const styles = StyleSheet.create({
    separator: {
        height: 8,
    },
});