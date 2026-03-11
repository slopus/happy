import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { apiSocket } from '@/sync/apiSocket';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { trimIdent } from '@/utils/trimIdent';
import { LongPressCopy, useCopySelectable } from '@/components/LongPressCopy';

interface DiffDetailResponse {
    success: boolean;
    diff?: string;
    additions?: number;
    deletions?: number;
    error?: string;
}

/**
 * Render a unified diff string with syntax coloring (same as CodexDiffView).
 */
const UnifiedDiffContent = React.memo<{ diff: string }>(({ diff }) => {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;

    const lines = diff.split('\n');
    return (
        <View>
            {lines.map((line, i) => {
                let bg = colors.contextBg;
                let fg = colors.contextText;
                if (line.startsWith('+') && !line.startsWith('+++')) {
                    bg = colors.addedBg;
                    fg = colors.addedText;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    bg = colors.removedBg;
                    fg = colors.removedText;
                } else if (line.startsWith('@@')) {
                    bg = colors.hunkHeaderBg;
                    fg = colors.hunkHeaderText;
                }
                return (
                    <Text
                        key={i}
                        numberOfLines={1}
                        style={{
                            ...Typography.mono(),
                            fontSize: 13,
                            lineHeight: 20,
                            backgroundColor: bg,
                            color: fg,
                            paddingHorizontal: 12,
                        }}
                    >
                        {line}
                    </Text>
                );
            })}
        </View>
    );
});

function getDiffCopyText(params: {
    mode: string;
    unifiedDiff: string | null;
    editDiff: { oldString: string; newString: string } | null;
    writeContent: string | null;
    multiEdits: Array<{ oldString: string; newString: string; failed?: boolean }> | null;
}): string {
    const { mode, unifiedDiff, editDiff, writeContent, multiEdits } = params;
    if (mode === 'unified' && unifiedDiff) return unifiedDiff;
    if (mode === 'edit' && editDiff) return `--- old\n${editDiff.oldString}\n\n+++ new\n${editDiff.newString}`;
    if (mode === 'write' && writeContent) return writeContent;
    if (mode === 'multi-edit' && multiEdits) {
        return multiEdits
            .map((edit, i) => edit.failed ? `Edit ${i + 1}: failed` : `--- old\n${edit.oldString}\n\n+++ new\n${edit.newString}`)
            .join('\n\n');
    }
    return '';
}

function ToolDiffScreen() {
    const { theme } = useUnistyles();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const params = useLocalSearchParams();
    const callId = params.callId as string;
    const filePath = params.filePath as string;
    const mode = (params.mode as string) || 'edit'; // 'unified' | 'edit' | 'write' | 'multi-edit'
    const editCount = parseInt(params.editCount as string) || 0;

    const showLineNumbers = useSetting('showLineNumbersInToolViews');
    const wrapLines = useSetting('wrapLinesInDiffs');
    const selectable = useCopySelectable();

    const fileName = filePath?.split('/').pop() || 'Unknown file';

    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    // For unified mode
    const [unifiedDiff, setUnifiedDiff] = React.useState<string | null>(null);

    // For edit mode
    const [editDiff, setEditDiff] = React.useState<{ oldString: string; newString: string } | null>(null);

    // For write mode
    const [writeContent, setWriteContent] = React.useState<string | null>(null);

    // For multi-edit mode
    const [multiEdits, setMultiEdits] = React.useState<Array<{ oldString: string; newString: string; failed?: boolean }> | null>(null);

    React.useEffect(() => {
        let cancelled = false;

        const fetchDiff = async () => {
            if (!sessionId || !callId || !filePath) {
                setError('Missing parameters');
                setLoading(false);
                return;
            }

            try {
                if (mode === 'unified') {
                    const result = await apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                        sessionId, 'getDiffDetail', { callId, filePath }
                    );
                    if (cancelled) return;
                    if (result.success && result.diff) {
                        setUnifiedDiff(result.diff);
                    } else {
                        setError(result.error || 'Diff not available');
                    }
                } else if (mode === 'edit') {
                    const result = await apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                        sessionId, 'getDiffDetail', { callId, filePath }
                    );
                    if (cancelled) return;
                    if (result.success && result.diff) {
                        const parsed = JSON.parse(result.diff);
                        setEditDiff({ oldString: parsed.oldString || '', newString: parsed.newString || '' });
                    } else {
                        setError(result.error || 'Diff not available');
                    }
                } else if (mode === 'write') {
                    const result = await apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                        sessionId, 'getDiffDetail', { callId, filePath }
                    );
                    if (cancelled) return;
                    if (result.success && result.diff) {
                        const parsed = JSON.parse(result.diff);
                        setWriteContent(parsed.newString || '');
                    } else {
                        setError(result.error || 'Diff not available');
                    }
                } else if (mode === 'multi-edit' && editCount > 0) {
                    const promises = Array.from({ length: editCount }, (_, i) =>
                        apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                            sessionId, 'getDiffDetail', { callId, filePath: `${filePath}#edit-${i}` }
                        )
                    );
                    const results = await Promise.allSettled(promises);
                    if (cancelled) return;

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
                                edits.push({ oldString: parsed.oldString || '', newString: parsed.newString || '' });
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
                        setError('Diff not available');
                    } else {
                        setMultiEdits(edits);
                    }
                } else {
                    setError('Invalid mode');
                }
            } catch (e: any) {
                if (!cancelled) setError(e.message || 'Failed to load diff');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchDiff();
        return () => { cancelled = true; };
    }, [sessionId, callId, filePath, mode, editCount]);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <Stack.Screen options={{ headerTitle: fileName }} />

            {/* File path header */}
            <View style={{
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 12,
                paddingHorizontal: 16,
                gap: 8,
            }}>
                <FileIcon fileName={fileName} size={20} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
                    <LongPressCopy text={filePath}>
                        <Text selectable={selectable} style={{ fontSize: 14, color: theme.colors.textSecondary, ...Typography.mono() }} numberOfLines={1}>
                            {filePath}
                        </Text>
                    </LongPressCopy>
                </ScrollView>
            </View>

            {loading && (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            )}

            {error && !loading && (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                    <Text style={{ fontSize: 14, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {error}
                    </Text>
                </View>
            )}

            {!loading && !error && (
                <LongPressCopy text={getDiffCopyText({ mode, unifiedDiff, editDiff, writeContent, multiEdits })} style={{ flex: 1 }}>
                    <ScrollView style={{ flex: 1 }}>
                        <ScrollView
                            horizontal={!wrapLines}
                            scrollEnabled={!wrapLines}
                            showsHorizontalScrollIndicator={!wrapLines}
                        >
                            {mode === 'unified' && unifiedDiff && (
                                <UnifiedDiffContent diff={unifiedDiff} />
                            )}

                            {mode === 'edit' && editDiff && (
                                <ToolDiffView
                                    oldText={trimIdent(editDiff.oldString)}
                                    newText={trimIdent(editDiff.newString)}
                                    showLineNumbers={showLineNumbers}
                                    showPlusMinusSymbols={showLineNumbers}
                                />
                            )}

                            {mode === 'write' && writeContent !== null && (
                                <ToolDiffView
                                    oldText={''}
                                    newText={writeContent}
                                    showLineNumbers={showLineNumbers}
                                    showPlusMinusSymbols={showLineNumbers}
                                />
                            )}

                            {mode === 'multi-edit' && multiEdits && (
                                <View style={{ flex: 1 }}>
                                    {multiEdits.map((edit, index) => (
                                        <View key={index}>
                                            {edit.failed ? (
                                                <Text style={{ fontSize: 12, padding: 8, color: theme.colors.textSecondary }}>
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
                                            {index < multiEdits.length - 1 && <View style={{ height: 8 }} />}
                                        </View>
                                    ))}
                                </View>
                            )}
                        </ScrollView>
                    </ScrollView>
                </LongPressCopy>
            )}
        </View>
    );
}

export default React.memo(ToolDiffScreen);

const styles = StyleSheet.create((_theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
}));
