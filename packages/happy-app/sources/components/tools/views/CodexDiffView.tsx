import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';

interface DiffDetailResponse {
    success: boolean;
    diff?: string;
    additions?: number;
    deletions?: number;
    error?: string;
}

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    sessionId?: string;
}

/**
 * Render a unified diff string with syntax coloring.
 */
const UnifiedDiffContent = React.memo<{ diff: string }>(({ diff }) => {
    const { theme } = useUnistyles();
    const colors = theme.colors.diff;

    const lines = diff.split('\n');
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator>
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
                                fontSize: 12,
                                lineHeight: 18,
                                backgroundColor: bg,
                                color: fg,
                                paddingHorizontal: 8,
                            }}
                        >
                            {line}
                        </Text>
                    );
                })}
            </View>
        </ScrollView>
    );
});

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata, sessionId }) => {
    const { theme } = useUnistyles();
    const { input } = tool;

    const files: string[] = input?.files && Array.isArray(input.files) ? input.files : [];
    const fileStats = input?.fileStats as Record<string, { additions?: number; deletions?: number }> | undefined;

    // Track expanded file and per-file cache to avoid race conditions
    const [expandedFile, setExpandedFile] = React.useState<string | null>(null);
    const [loadingFile, setLoadingFile] = React.useState<string | null>(null);
    const diffCache = React.useRef(new Map<string, { diff?: string; error?: string }>());

    const handleFilePress = React.useCallback(async (filePath: string) => {
        // Toggle off if already expanded
        if (expandedFile === filePath) {
            setExpandedFile(null);
            return;
        }

        setExpandedFile(filePath);

        // If already cached, no need to fetch
        if (diffCache.current.has(filePath)) {
            return;
        }

        if (!sessionId || !input?.callId) {
            diffCache.current.set(filePath, { error: 'Session unavailable' });
            return;
        }

        setLoadingFile(filePath);

        try {
            const result = await apiSocket.sessionRPC<DiffDetailResponse, { callId: string; filePath: string }>(
                sessionId,
                'getDiffDetail',
                { callId: input.callId, filePath }
            );
            if (result.success && result.diff) {
                diffCache.current.set(filePath, { diff: result.diff });
            } else {
                diffCache.current.set(filePath, { error: result.error || 'not_found' });
            }
        } catch (e: any) {
            diffCache.current.set(filePath, { error: e.message || 'RPC failed' });
        } finally {
            setLoadingFile(null);
        }
    }, [expandedFile, sessionId, input?.callId]);

    if (files.length === 0) {
        return null;
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {files.map((file, index) => {
                    const resolved = resolvePath(file, metadata);
                    const fileName = resolved.split('/').pop() || resolved;
                    const isExpanded = expandedFile === file;
                    const isLoading = loadingFile === file;
                    const fileCached = isExpanded ? diffCache.current.get(file) : undefined;
                    const fStats = fileStats?.[file];

                    return (
                        <View key={index}>
                            <TouchableOpacity
                                style={styles.fileRow}
                                onPress={() => handleFilePress(file)}
                                activeOpacity={0.6}
                            >
                                <Octicons
                                    name={isExpanded ? 'chevron-down' : 'chevron-right'}
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                                <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                                {fStats && (fStats.additions || fStats.deletions) ? (
                                    <View style={styles.statsRow}>
                                        {fStats.additions ? <Text style={[styles.statText, { color: theme.colors.success }]}>+{fStats.additions}</Text> : null}
                                        {fStats.deletions ? <Text style={[styles.statText, { color: theme.colors.textDestructive }]}>-{fStats.deletions}</Text> : null}
                                    </View>
                                ) : null}
                                {isLoading && <ActivityIndicator size="small" style={{ marginLeft: 4 }} />}
                            </TouchableOpacity>
                            {isExpanded && fileCached?.diff && (
                                <View style={styles.diffContainer}>
                                    <UnifiedDiffContent diff={fileCached.diff} />
                                </View>
                            )}
                            {isExpanded && fileCached?.error && (
                                <View style={styles.diffContainer}>
                                    <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
                                        {fileCached.error === 'not_found' ? 'Diff not available' : fileCached.error}
                                    </Text>
                                </View>
                            )}
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        gap: 6,
    },
    statsRow: {
        flexDirection: 'row',
        gap: 8,
    },
    statText: {
        fontSize: 12,
        ...Typography.mono('semiBold'),
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
    diffContainer: {
        marginTop: 4,
        marginBottom: 4,
        borderRadius: 6,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
    },
    errorText: {
        fontSize: 12,
        padding: 8,
    },
}));
