import * as React from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { DiffView } from '@/components/diff/DiffView';
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
            showLineNumbers={showLineNumbersInToolViews}
        />
    );
});

const OnDemandMultiEditDiff = React.memo<{
    tool: ToolViewProps['tool'];
    metadata: ToolViewProps['metadata'];
    sessionId?: string;
    showLineNumbers: boolean;
}>(({ tool, metadata, sessionId, showLineNumbers }) => {
    const { theme } = useUnistyles();
    const filePath = typeof tool.input?.file_path === 'string' ? tool.input.file_path : '';
    const callId = typeof tool.input?.callId === 'string' ? tool.input.callId : '';
    const rawEditCount = tool.input?.editCount;
    const editCount = typeof rawEditCount === 'number' && rawEditCount > 0 ? rawEditCount : 0;
    const resolved = filePath ? resolvePath(filePath, metadata) : '';
    const fileName = resolved ? (resolved.split('/').pop() || resolved) : 'Unknown file';

    const [expanded, setExpanded] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const cache = React.useRef<{ edits?: Array<{ oldString: string; newString: string; failed?: boolean }>; error?: string } | null>(null);

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
        if (editCount === 0) {
            cache.current = { error: 'No edits available' };
            return;
        }

        setLoading(true);
        try {
            // Fetch all edit diffs in parallel
            const promises = Array.from({ length: editCount }, (_, i) =>
                apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                    sessionId,
                    'getDiffDetail',
                    { callId, filePath: `${filePath}#edit-${i}` }
                )
            );
            const results = await Promise.allSettled(promises);

            const edits: Array<{ oldString: string; newString: string; failed?: boolean }> = [];
            let failCount = 0;
            for (const result of results) {
                if (result.status !== 'fulfilled') {
                    failCount++;
                    edits.push({ oldString: '', newString: '', failed: true });
                    continue;
                }

                const payload = result.value;
                if (payload.success && payload.diff) {
                    try {
                        const parsed = JSON.parse(payload.diff);
                        edits.push({
                            oldString: parsed.oldString || '',
                            newString: parsed.newString || '',
                        });
                    } catch {
                        failCount++;
                        edits.push({ oldString: '', newString: '', failed: true });
                    }
                } else {
                    failCount++;
                    edits.push({ oldString: '', newString: '', failed: true });
                }
            }
            if (failCount === results.length) {
                cache.current = { error: 'Diff not available' };
            } else {
                cache.current = { edits };
            }
        } catch (e: any) {
            cache.current = { error: e.message || 'RPC failed' };
        } finally {
            setLoading(false);
        }
    }, [expanded, sessionId, callId, filePath, editCount]);

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
                    {editCount > 1 && (
                        <Text style={[styles.editCount, { color: theme.colors.textSecondary }]}>
                            ({editCount} edits)
                        </Text>
                    )}
                    {loading && <ActivityIndicator size="small" style={{ marginLeft: 4 }} />}
                </TouchableOpacity>
                {expanded && cache.current?.edits && (
                    <View style={styles.diffContainer}>
                        {cache.current.edits.map((edit, index) => (
                            <View key={index}>
                                {edit.failed ? (
                                    <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
                                        Edit {index + 1}: failed to load
                                    </Text>
                                ) : (
                                    <ToolDiffView
                                        oldText={trimIdent(edit.oldString)}
                                        newText={trimIdent(edit.newString)}
                                        showLineNumbers={showLineNumbers}
                                        showPlusMinusSymbols={showLineNumbers}
                                    />
                                )}
                                {index < cache.current!.edits!.length - 1 && <View style={inlineStyles.separator} />}
                            </View>
                        ))}
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
