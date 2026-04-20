import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface InlineFileDiffProps {
    sessionId: string;
    fullPath: string;
    onClose: () => void;
}

export const InlineFileDiff = React.memo(function InlineFileDiff({ sessionId, fullPath, onClose }: InlineFileDiffProps) {
    const { theme } = useUnistyles();
    const session = storage.getState().sessions[sessionId];
    const sessionPath = session?.metadata?.path ?? null;
    const resolved = resolveSessionFilePath(fullPath, sessionPath);
    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;

    const [diff, setDiff] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setDiff(null);

        (async () => {
            if (!sessionPath || !gitDiffPath) {
                if (!cancelled) {
                    setLoading(false);
                    setError('File is outside the session root.');
                }
                return;
            }
            try {
                const res = await sessionBash(sessionId, {
                    command: `git diff --no-ext-diff -- "${gitDiffPath}"`,
                    cwd: sessionPath,
                    timeout: 5000,
                });
                if (cancelled) return;
                if (!res.success) {
                    setError(res.error || 'Failed to fetch diff');
                    return;
                }
                setDiff(res.stdout ?? '');
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch diff');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [sessionId, sessionPath, gitDiffPath]);

    const fileName = fullPath.split('/').pop() || fullPath;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <View style={[styles.header, { borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
                <FileIcon fileName={fileName} size={18} />
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.headerPath, { color: theme.colors.textSecondary }]}
                >
                    {fullPath}
                </Text>
                <Pressable onPress={onClose} hitSlop={15} style={styles.closeButton}>
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : error ? (
                <View style={styles.centered}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{error}</Text>
                </View>
            ) : !diff || diff.trim() === '' ? (
                <View style={styles.centered}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('files.noChanges')}</Text>
                </View>
            ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
                    <DiffLines diff={diff} />
                </ScrollView>
            )}
        </View>
    );
});

const DiffLines = React.memo(function DiffLines({ diff }: { diff: string }) {
    const { theme } = useUnistyles();
    const lines = React.useMemo(() => diff.split('\n'), [diff]);

    return (
        <View>
            {lines.map((line, index) => {
                const baseStyle = { ...Typography.mono(), fontSize: 13, lineHeight: 20 };
                let lineStyle: any = baseStyle;
                let backgroundColor: string = 'transparent';
                let borderLeftWidth = 0;
                let borderLeftColor = 'transparent';

                if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.addedText };
                    backgroundColor = theme.colors.diff.addedBg;
                    borderLeftWidth = 3;
                    borderLeftColor = theme.colors.diff.addedBorder;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.removedText };
                    backgroundColor = theme.colors.diff.removedBg;
                    borderLeftWidth = 3;
                    borderLeftColor = theme.colors.diff.removedBorder;
                } else if (line.startsWith('@@')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.hunkHeaderText, fontWeight: '600' as const };
                    backgroundColor = theme.colors.diff.hunkHeaderBg;
                } else if (line.startsWith('+++') || line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.text, fontWeight: '600' as const };
                } else {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.contextText };
                }

                return (
                    <View
                        key={index}
                        style={{ backgroundColor, paddingHorizontal: 8, paddingVertical: 1, borderLeftWidth, borderLeftColor }}
                    >
                        <Text style={lineStyle}>{line || ' '}</Text>
                    </View>
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
    },
    headerPath: {
        flex: 1,
        fontSize: 13,
        ...Typography.mono(),
    },
    closeButton: {
        padding: 4,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
});
