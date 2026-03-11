import * as React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { DiffView } from '@/components/diff/DiffView';
import { trimIdent } from '@/utils/trimIdent';
import { t } from '@/text';
import { useSetting } from '@/sync/storage';
import { resolvePath } from '@/utils/pathUtils';
import { CopyableText } from '@/components/LongPressCopy';

interface MultiEditViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const MultiEditViewFull = React.memo<MultiEditViewFullProps>(({ tool, metadata }) => {
    const { input } = tool;
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    // Trimmed mode: diff data was offloaded, view in session conversation instead
    if (input?._trimmed === true) {
        const filePath = typeof input.file_path === 'string' ? resolvePath(input.file_path, metadata) : '';
        const editCount = typeof input.editCount === 'number' ? input.editCount : 0;
        return (
            <View style={toolFullViewStyles.sectionFullWidth}>
                <View style={trimmedStyles.container}>
                    <CopyableText style={trimmedStyles.fileName}>{filePath}</CopyableText>
                    {editCount > 0 && (
                        <Text style={trimmedStyles.hint}>
                            {editCount} {editCount === 1 ? 'edit' : 'edits'} — available in session view
                        </Text>
                    )}
                    {!editCount && <Text style={trimmedStyles.hint}>Diff available in session view</Text>}
                </View>
            </View>
        );
    }

    // Parse the input
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    
    const parsed = knownTools.MultiEdit.input.safeParse(input);
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
                        <View style={styles.editHeader}>
                            <Text style={styles.editNumber}>
                                {t('tools.multiEdit.editNumber', { index: index + 1, total: edits.length })}
                            </Text>
                            {edit.replace_all && (
                                <View style={styles.replaceAllBadge}>
                                    <Text style={styles.replaceAllText}>{t('tools.multiEdit.replaceAll')}</Text>
                                </View>
                            )}
                        </View>
                        <DiffView 
                            oldText={oldString} 
                            newText={newString} 
                            wrapLines={wrapLinesInDiffs}
                            showLineNumbers={true}
                            showPlusMinusSymbols={true}
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
            <View style={toolFullViewStyles.sectionFullWidth}>
                {content}
            </View>
        );
    }

    // When not wrapping, use horizontal scroll
    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={true}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
                contentContainerStyle={{ flexGrow: 1 }}
            >
                {content}
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
