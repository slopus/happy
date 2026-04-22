import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { sessionBash } from '@/sync/ops';
import { storage, useSettingMutable } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface InlineFileDiffProps {
    sessionId: string;
    fullPath: string;
    /** File status from sidebar — drives which git command we use to build the diff. */
    status: GitFileStatus['status'];
    onClose: () => void;
}

type DiffContent =
    | { kind: 'patch'; patch: string }
    | { kind: 'newFile'; contents: string };

export const InlineFileDiff = React.memo(function InlineFileDiff({ sessionId, fullPath, status, onClose }: InlineFileDiffProps) {
    const { theme } = useUnistyles();
    const session = storage.getState().sessions[sessionId];
    const sessionPath = session?.metadata?.path ?? null;
    const resolved = resolveSessionFilePath(fullPath, sessionPath);
    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');

    const [content, setContent] = React.useState<DiffContent | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setContent(null);

        (async () => {
            if (!sessionPath || !gitDiffPath) {
                if (!cancelled) {
                    setLoading(false);
                    setError('File is outside the session root.');
                }
                return;
            }
            try {
                // Untracked files have no index/HEAD entry — read the file directly
                // and render it as a pure addition via PierreDiffView's oldFile/newFile API.
                if (status === 'untracked') {
                    const res = await sessionBash(sessionId, {
                        command: `cat -- "${gitDiffPath}"`,
                        cwd: sessionPath,
                        timeout: 5000,
                    });
                    if (cancelled) return;
                    if (!res.success) {
                        setError(res.error || 'Failed to read file');
                        return;
                    }
                    setContent({ kind: 'newFile', contents: res.stdout ?? '' });
                    return;
                }

                // Tracked files: `git diff HEAD` covers staged + unstaged + deleted
                // in a single diff, so the user sees the same thing regardless of
                // which sidebar section they clicked.
                const res = await sessionBash(sessionId, {
                    command: `git diff HEAD --no-ext-diff -- "${gitDiffPath}"`,
                    cwd: sessionPath,
                    timeout: 5000,
                });
                if (cancelled) return;
                if (!res.success) {
                    setError(res.error || 'Failed to fetch diff');
                    return;
                }
                setContent({ kind: 'patch', patch: res.stdout ?? '' });
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch diff');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [sessionId, sessionPath, gitDiffPath, status]);

    const fileName = fullPath.split('/').pop() || fullPath;
    const isEmpty =
        content === null ? false :
        content.kind === 'patch' ? content.patch.trim() === '' :
        content.contents === '';

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
                {Platform.OS === 'web' ? (
                    <DiffStyleToggle value={diffStyle} onChange={setDiffStyle} />
                ) : null}
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
            ) : !content || isEmpty ? (
                <View style={styles.centered}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('files.noChanges')}</Text>
                </View>
            ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
                    {content.kind === 'patch' ? (
                        <PierreDiffView key={diffStyle} patch={content.patch} diffStyle={diffStyle} />
                    ) : (
                        <PierreDiffView
                            key={diffStyle}
                            oldFile={{ name: fileName, contents: '' }}
                            newFile={{ name: fileName, contents: content.contents }}
                            diffStyle={diffStyle}
                        />
                    )}
                </ScrollView>
            )}
        </View>
    );
});

const DiffStyleToggle = React.memo<{ value: 'unified' | 'split'; onChange: (v: 'unified' | 'split') => void }>(({ value, onChange }) => {
    const { theme } = useUnistyles();
    const buttonStyle = (active: boolean) => ({
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.surface : 'transparent',
    });
    const textStyle = (active: boolean) => ({
        fontSize: 12,
        ...Typography.default(active ? 'semiBold' : undefined),
        color: active ? theme.colors.text : theme.colors.textSecondary,
    });
    return (
        <View style={[toggleStyles.container, { backgroundColor: theme.colors.groupped.background, borderColor: theme.colors.divider }]}>
            <Pressable onPress={() => onChange('unified')} style={buttonStyle(value === 'unified')}>
                <Text style={textStyle(value === 'unified')}>Unified</Text>
            </Pressable>
            <Pressable onPress={() => onChange('split')} style={buttonStyle(value === 'split')}>
                <Text style={textStyle(value === 'split')}>Split</Text>
            </Pressable>
        </View>
    );
});

const toggleStyles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
    },
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
