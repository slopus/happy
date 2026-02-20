import * as React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { Typography } from '@/constants/Typography';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    sessionId?: string;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata, sessionId }) => {
    const { theme } = useUnistyles();
    const { input } = tool;
    const router = useRouter();

    const files: string[] = input?.files && Array.isArray(input.files) ? input.files : [];
    const fileStats = input?.fileStats as Record<string, { additions?: number; deletions?: number }> | undefined;

    const handleFilePress = React.useCallback((filePath: string) => {
        if (!sessionId || !input?.callId) return;
        router.push(`/session/${sessionId}/tool-diff?callId=${input.callId}&filePath=${encodeURIComponent(filePath)}&mode=unified`);
    }, [sessionId, input?.callId, router]);

    if (files.length === 0) {
        return null;
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {files.map((file, index) => {
                    const resolved = resolvePath(file, metadata);
                    const fileName = resolved.split('/').pop() || resolved;
                    const fStats = fileStats?.[file];

                    return (
                        <TouchableOpacity
                            key={index}
                            style={styles.fileRow}
                            onPress={() => handleFilePress(file)}
                            activeOpacity={0.6}
                        >
                            <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                            {fStats && (fStats.additions || fStats.deletions) ? (
                                <View style={styles.statsRow}>
                                    {fStats.additions ? <Text style={[styles.statText, { color: theme.colors.success }]}>+{fStats.additions}</Text> : null}
                                    {fStats.deletions ? <Text style={[styles.statText, { color: theme.colors.textDestructive }]}>-{fStats.deletions}</Text> : null}
                                </View>
                            ) : null}
                        </TouchableOpacity>
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
}));
