import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';
import { resolvePath } from '@/utils/pathUtils';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';

interface DiffDetailResponse {
    success: boolean;
    diff?: string;
    error?: string;
}

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
            showLineNumbers={showLineNumbersInToolViews}
        />
    );
});

const OnDemandEditDiff = React.memo<{
    tool: ToolViewProps['tool'];
    metadata: ToolViewProps['metadata'];
    sessionId?: string;
    showLineNumbers: boolean;
}>(({ tool, metadata, sessionId, showLineNumbers }) => {
    const { theme } = useUnistyles();
    const filePath = typeof tool.input?.file_path === 'string' ? tool.input.file_path : '';
    const callId = typeof tool.input?.callId === 'string' ? tool.input.callId : '';
    const resolved = filePath ? resolvePath(filePath, metadata) : '';
    const fileName = resolved ? (resolved.split('/').pop() || resolved) : 'Unknown file';
    const additions = typeof tool.input?.additions === 'number' ? tool.input.additions : 0;
    const deletions = typeof tool.input?.deletions === 'number' ? tool.input.deletions : 0;

    const [expanded, setExpanded] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const cache = React.useRef<{ oldString?: string; newString?: string; error?: string } | null>(null);

    const handlePress = React.useCallback(async () => {
        if (expanded) {
            setExpanded(false);
            return;
        }
        setExpanded(true);

        if (cache.current) return;

        if (!sessionId || !callId || !filePath) {
            cache.current = { error: 'Session unavailable' };
            return;
        }

        setLoading(true);
        try {
            const result = await apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                sessionId,
                'getDiffDetail',
                { callId, filePath }
            );
            if (result.success && result.diff) {
                const parsed = JSON.parse(result.diff);
                cache.current = {
                    oldString: parsed.oldString || '',
                    newString: parsed.newString || '',
                };
            } else {
                cache.current = { error: result.error || 'not_found' };
            }
        } catch (e: any) {
            cache.current = { error: e.message || 'RPC failed' };
        } finally {
            setLoading(false);
        }
    }, [expanded, sessionId, callId, filePath]);

    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <TouchableOpacity style={styles.fileRow} onPress={handlePress} activeOpacity={0.6}>
                    <Octicons
                        name={expanded ? 'chevron-down' : 'chevron-right'}
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                    <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                    {(additions > 0 || deletions > 0) && (
                        <View style={styles.statsRow}>
                            {additions > 0 && <Text style={[styles.statText, { color: theme.colors.success }]}>+{additions}</Text>}
                            {deletions > 0 && <Text style={[styles.statText, { color: theme.colors.textDestructive }]}>-{deletions}</Text>}
                        </View>
                    )}
                    {loading && <ActivityIndicator size="small" style={{ marginLeft: 4 }} />}
                </TouchableOpacity>
                {expanded && cache.current?.oldString !== undefined && (
                    <View style={styles.diffContainer}>
                        <ToolDiffView
                            oldText={trimIdent(cache.current.oldString || '')}
                            newText={trimIdent(cache.current.newString || '')}
                            showLineNumbers={showLineNumbers}
                            showPlusMinusSymbols={showLineNumbers}
                        />
                    </View>
                )}
                {expanded && cache.current?.error && (
                    <View style={styles.diffContainer}>
                        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
                            {cache.current.error === 'not_found' ? 'Diff not available' : cache.current.error}
                        </Text>
                    </View>
                )}
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
    diffContainer: {
        marginTop: 4,
        marginBottom: 4,
        borderRadius: 6,
        overflow: 'hidden',
    },
    errorText: {
        fontSize: 12,
        padding: 8,
    },
}));
