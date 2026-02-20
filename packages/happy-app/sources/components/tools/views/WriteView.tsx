import * as React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { knownTools } from '@/components/tools/knownTools';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';
import { resolvePath } from '@/utils/pathUtils';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';

export const WriteView = React.memo<ToolViewProps>(({ tool, metadata, sessionId }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');

    const isTrimmed = tool.input?._trimmed === true;

    // --- Inline mode (backward compatible) ---
    if (!isTrimmed) {
        let contents: string = '<no contents>';
        const parsed = knownTools.Write.input.safeParse(tool.input);
        if (parsed.success && typeof parsed.data.content === 'string') {
            contents = parsed.data.content;
        }

        return (
            <ToolSectionView fullWidth>
                <ToolDiffView
                    oldText={''}
                    newText={contents}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        );
    }

    // --- On-demand mode ---
    return (
        <OnDemandWriteDiff
            tool={tool}
            metadata={metadata}
            sessionId={sessionId}
        />
    );
});

const OnDemandWriteDiff = React.memo<{
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

    const handlePress = React.useCallback(() => {
        if (!sessionId || !callId || !filePath) return;
        router.push(`/session/${sessionId}/tool-diff?callId=${callId}&filePath=${encodeURIComponent(filePath)}&mode=write`);
    }, [sessionId, callId, filePath, router]);

    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <TouchableOpacity style={styles.fileRow} onPress={handlePress} activeOpacity={0.6}>
                    <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                    {additions > 0 && (
                        <Text style={[styles.statText, { color: theme.colors.success }]}>+{additions}</Text>
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
    statText: {
        fontSize: 12,
        ...Typography.mono('semiBold'),
    },
}));
