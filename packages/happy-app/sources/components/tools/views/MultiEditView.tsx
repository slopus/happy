import * as React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Octicons } from '@expo/vector-icons';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { DiffView } from '@/components/diff/DiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';
import { resolvePath } from '@/utils/pathUtils';
import { Typography } from '@/constants/Typography';

export const MultiEditView = React.memo<ToolViewProps>(({ tool, metadata, sessionId }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');

    const isTrimmed = tool.input?._trimmed === true;

    // --- Inline mode (backward compatible) ---
    if (!isTrimmed) {
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
                            {index < edits.length - 1 && <View style={inlineStyles.separator} />}
                        </View>
                    );
                })}
            </View>
        );

        if (wrapLinesInDiffs) {
            return (
                <ToolSectionView fullWidth>
                    {content}
                </ToolSectionView>
            );
        }

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
    }

    // --- On-demand mode ---
    return (
        <OnDemandMultiEditDiff
            tool={tool}
            metadata={metadata}
            sessionId={sessionId}
        />
    );
});

const OnDemandMultiEditDiff = React.memo<{
    tool: ToolViewProps['tool'];
    metadata: ToolViewProps['metadata'];
    sessionId?: string;
}>(({ tool, metadata, sessionId }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const filePath = typeof tool.input?.file_path === 'string' ? tool.input.file_path : '';
    const callId = typeof tool.input?.callId === 'string' ? tool.input.callId : '';
    const rawEditCount = tool.input?.editCount;
    const editCount = typeof rawEditCount === 'number' && rawEditCount > 0 ? rawEditCount : 0;
    const additions = typeof tool.input?.additions === 'number' ? tool.input.additions : 0;
    const deletions = typeof tool.input?.deletions === 'number' ? tool.input.deletions : 0;
    const resolved = filePath ? resolvePath(filePath, metadata) : '';
    const fileName = resolved ? (resolved.split('/').pop() || resolved) : 'Unknown file';

    const handlePress = React.useCallback(() => {
        if (!sessionId || !callId || !filePath) return;
        router.push(`/session/${sessionId}/tool-diff?callId=${callId}&filePath=${encodeURIComponent(filePath)}&mode=multi-edit&editCount=${editCount}`);
    }, [sessionId, callId, filePath, editCount, router]);

    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <TouchableOpacity style={styles.fileRow} onPress={handlePress} activeOpacity={0.6}>
                    <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                    {editCount > 1 && (
                        <Text style={[styles.editCount, { color: theme.colors.textSecondary }]}>
                            ({editCount} edits)
                        </Text>
                    )}
                    {(additions > 0 || deletions > 0) && (
                        <View style={styles.statsRow}>
                            {additions > 0 && <Text style={[styles.statText, { color: theme.colors.success }]}>+{additions}</Text>}
                            {deletions > 0 && <Text style={[styles.statText, { color: theme.colors.textDestructive }]}>-{deletions}</Text>}
                        </View>
                    )}
                </TouchableOpacity>
            </View>
        </ToolSectionView>
    );
});

const inlineStyles = StyleSheet.create({
    separator: {
        height: 8,
    },
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        gap: 6,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 2,
    },
    fileName: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.mono(),
        flexShrink: 1,
    },
    editCount: {
        fontSize: 12,
        ...Typography.mono(),
    },
    statsRow: {
        flexDirection: 'row',
        gap: 8,
    },
    statText: {
        fontSize: 12,
        ...Typography.mono('semiBold'),
    },
}));
