import * as React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { DiffView } from '@/components/diff/DiffView';
import { trimIdent } from '@/utils/trimIdent';

interface MultiEditViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const MultiEditViewFull = React.memo<MultiEditViewFullProps>(({ tool, metadata }) => {
    const { input } = tool;

    // Parse the input
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    
    const parsed = knownTools.MultiEdit.input.safeParse(input);
    if (parsed.success && parsed.data.edits) {
        edits = parsed.data.edits;
    }

    if (edits.length === 0) {
        return null;
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={true}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
                contentContainerStyle={{ flexGrow: 1 }}
            >
                <View style={{ flex: 1 }}>
                    {edits.map((edit, index) => {
                        const oldString = trimIdent(edit.old_string || '');
                        const newString = trimIdent(edit.new_string || '');
                        
                        return (
                            <View key={index}>
                                <View style={styles.editHeader}>
                                    <Text style={styles.editNumber}>
                                        Edit {index + 1} of {edits.length}
                                    </Text>
                                    {edit.replace_all && (
                                        <View style={styles.replaceAllBadge}>
                                            <Text style={styles.replaceAllText}>Replace All</Text>
                                        </View>
                                    )}
                                </View>
                                <DiffView 
                                    oldText={oldString} 
                                    newText={newString} 
                                    wrapLines={false}
                                    showLineNumbers={true}
                                    showPlusMinusSymbols={true}
                                />
                                {index < edits.length - 1 && <View style={styles.separator} />}
                            </View>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create({
    editHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    editNumber: {
        fontSize: 14,
        fontWeight: '600',
        color: '#5856D6',
    },
    replaceAllBadge: {
        backgroundColor: '#5856D6',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 8,
    },
    replaceAllText: {
        fontSize: 12,
        color: '#fff',
        fontWeight: '600',
    },
    separator: {
        height: 1,
        backgroundColor: '#E5E5EA',
        marginVertical: 16,
    },
});