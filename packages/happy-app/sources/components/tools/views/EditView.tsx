import * as React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';
import { resolvePath } from '@/utils/pathUtils';
import { Typography } from '@/constants/Typography';

export const EditView = React.memo<ToolViewProps>(({ tool, metadata, sessionId }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');

    const isTrimmed = tool.input?._trimmed === true;

    // --- Inline mode (backward compatible) ---
    if (!isTrimmed) {
        let oldString = '';
        let newString = '';
        const parsed = knownTools.Edit.input.safeParse(tool.input);
        if (parsed.success) {
            oldString = trimIdent(parsed.data.old_string || '');
            newString = trimIdent(parsed.data.new_string || '');
        }

        return (
            <ToolSectionView fullWidth>
                <ToolDiffView
                    oldText={oldString}
                    newText={newString}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        );
    }

    // --- On-demand mode ---
    return (
        <OnDemandEditDiff
            tool={tool}
            metadata={metadata}
            sessionId={sessionId}
        />
    );
});

const OnDemandEditDiff = React.memo<{
    tool: ToolViewProps['tool'];
    metadata: ToolViewProps['metadata'];
    sessionId?: string;
}>(({ tool, metadata, sessionId }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const filePath = typeof tool.input?.file_path === 'string' ? tool.input.file_path : '';
    const callId = typeof tool.input?.callId === 'string' ? tool.input.callId : '';
    const resolved = filePath ? resolvePath(filePath, metadata) : '';
    const fileName = resolved ? (resolved.split('/').pop() || resolved) : 'Unknown file';
    const additions = typeof tool.input?.additions === 'number' ? tool.input.additions : 0;
    const deletions = typeof tool.input?.deletions === 'number' ? tool.input.deletions : 0;

    const handlePress = React.useCallback(() => {
        if (!sessionId || !callId || !filePath) return;
        router.push(`/session/${sessionId}/tool-diff?callId=${callId}&filePath=${encodeURIComponent(filePath)}&mode=edit`);
    }, [sessionId, callId, filePath, router]);

    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <TouchableOpacity style={styles.fileRow} onPress={handlePress} activeOpacity={0.6}>
                    <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
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
    statsRow: {
        flexDirection: 'row',
        gap: 8,
    },
    statText: {
        fontSize: 12,
        ...Typography.mono('semiBold'),
    },
}));
