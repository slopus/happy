import * as React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { DiffView } from '@/components/diff/DiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';

export const MultiEditView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    
    const parsed = knownTools.MultiEdit.input.safeParse(tool.input);
    if (parsed.success && parsed.data.edits) {
        edits = parsed.data.edits;
    }

    if (edits.length === 0) {
        return null;
    }

    const content = (
        <View style={{ flex: 1 }}>
            {edits.map((edit, index) => {
                const oldString = trimIdent(edit.old_string || '');
                const newString = trimIdent(edit.new_string || '');
                
                return (
                    <View key={index}>
                        <DiffView 
                            oldText={oldString} 
                            newText={newString} 
                            wrapLines={wrapLinesInDiffs}
                            showLineNumbers={showLineNumbersInToolViews}
                            showPlusMinusSymbols={showLineNumbersInToolViews}
                        />
                        {index < edits.length - 1 && <View style={styles.separator} />}
                    </View>
                );
            })}
        </View>
    );

    if (wrapLinesInDiffs) {
        // When wrapping lines, no horizontal scroll needed
        return (
            <ToolSectionView fullWidth>
                {content}
            </ToolSectionView>
        );
    }

    // When not wrapping, use horizontal scroll
    return (
        <ToolSectionView fullWidth>
            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={true}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
                contentContainerStyle={{ flexGrow: 1 }}
            >
                {content}
            </ScrollView>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create({
    separator: {
        height: 8,
    },
});