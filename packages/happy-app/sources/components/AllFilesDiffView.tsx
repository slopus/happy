import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';
import { sessionBash } from '@/sync/ops';
import { storage, useSessionGitStatusFiles, useSettingMutable } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { layout } from '@/components/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface AllFilesDiffViewProps {
    sessionId: string;
    /** When set, auto-scroll to this file */
    scrollToFile?: string | null;
    onClose: () => void;
}

type DiffContent =
    | { kind: 'patch'; patch: string }
    | { kind: 'newFile'; contents: string };

type FileDiffResult = {
    file: GitFileStatus;
    content: DiffContent | null;
    error: string | null;
};

/**
 * Loads all diffs in parallel, then renders them in a single ScrollView.
 * Shows a global loading spinner until all diffs are fetched to prevent layout jumps.
 */
export const AllFilesDiffView = React.memo(function AllFilesDiffView({
    sessionId,
    scrollToFile,
    onClose,
}: AllFilesDiffViewProps) {
    const { theme } = useUnistyles();
    const gitStatusFiles = useSessionGitStatusFiles(sessionId);
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const scrollRef = React.useRef<ScrollView>(null);
    const fileOffsets = React.useRef<Map<string, number>>(new Map());

    // Flatten and deduplicate files
    const files = React.useMemo(() => {
        if (!gitStatusFiles) return [];
        const all = [...gitStatusFiles.stagedFiles, ...gitStatusFiles.unstagedFiles];
        const seen = new Map<string, GitFileStatus>();
        for (const f of all) {
            if (!seen.has(f.fullPath)) seen.set(f.fullPath, f);
        }
        return Array.from(seen.values()).sort((a, b) =>
            a.fullPath.localeCompare(b.fullPath)
        );
    }, [gitStatusFiles]);

    // Batch-load all diffs
    const [results, setResults] = React.useState<FileDiffResult[]>([]);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setResults([]);

        if (files.length === 0) {
            setLoading(false);
            return;
        }

        const session = storage.getState().sessions[sessionId];
        const sessionPath = session?.metadata?.path ?? null;

        (async () => {
            const fetched = await Promise.all(
                files.map(async (file): Promise<FileDiffResult> => {
                    if (!sessionPath) {
                        return { file, content: null, error: 'No session path' };
                    }
                    const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
                    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;
                    if (!gitDiffPath) {
                        return { file, content: null, error: 'File is outside the session root.' };
                    }

                    try {
                        if (file.status === 'untracked') {
                            const res = await sessionBash(sessionId, {
                                command: `cat -- "${gitDiffPath}"`,
                                cwd: sessionPath,
                                timeout: 5000,
                            });
                            if (!res.success) {
                                return { file, content: null, error: res.error || 'Failed to read file' };
                            }
                            return { file, content: { kind: 'newFile', contents: res.stdout ?? '' }, error: null };
                        }

                        const res = await sessionBash(sessionId, {
                            command: `git diff HEAD --no-ext-diff -- "${gitDiffPath}"`,
                            cwd: sessionPath,
                            timeout: 5000,
                        });
                        if (!res.success) {
                            return { file, content: null, error: res.error || 'Failed to fetch diff' };
                        }
                        return { file, content: { kind: 'patch', patch: res.stdout ?? '' }, error: null };
                    } catch (err) {
                        return { file, content: null, error: err instanceof Error ? err.message : 'Failed to fetch diff' };
                    }
                })
            );

            if (!cancelled) {
                setResults(fetched);
                setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [sessionId, files]);

    // Scroll to the target file after content renders
    React.useEffect(() => {
        if (loading || !scrollToFile) return;
        const timer = setTimeout(() => {
            const offset = fileOffsets.current.get(scrollToFile);
            if (offset !== undefined) {
                scrollRef.current?.scrollTo({ y: offset, animated: true });
            }
        }, 50);
        return () => clearTimeout(timer);
    }, [scrollToFile, loading]);

    if (files.length === 0 && !loading) {
        return (
            <View style={[styles.outer, { backgroundColor: theme.colors.surface }]}>
                <TopBar
                    diffStyle={diffStyle}
                    onDiffStyleChange={setDiffStyle}
                    onClose={onClose}
                    fileCount={0}
                />
                <View style={styles.centered}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.noChanges')}
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.outer, { backgroundColor: theme.colors.surface }]}>
            <TopBar
                diffStyle={diffStyle}
                onDiffStyleChange={setDiffStyle}
                onClose={onClose}
                fileCount={files.length}
            />
            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : (
                <ScrollView
                    ref={scrollRef}
                    style={{ flex: 1 }}
                    contentContainerStyle={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                >
                    {results.map((result) => (
                        <FileDiffSection
                            key={result.file.fullPath}
                            result={result}
                            diffStyle={diffStyle}
                            isHighlighted={scrollToFile === result.file.fullPath}
                            onLayout={(y) => fileOffsets.current.set(result.file.fullPath, y)}
                        />
                    ))}
                </ScrollView>
            )}
        </View>
    );
});

/** Top toolbar with file count, diff style toggle, and close button */
const TopBar = React.memo(function TopBar({
    diffStyle,
    onDiffStyleChange,
    onClose,
    fileCount,
}: {
    diffStyle: 'unified' | 'split';
    onDiffStyleChange: (v: 'unified' | 'split') => void;
    onClose: () => void;
    fileCount: number;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.topBar, { backgroundColor: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }]}>
            <Text style={[styles.topBarTitle, { color: theme.colors.text }]}>
                {t('files.changedFiles', { count: fileCount })}
            </Text>
            <View style={{ flex: 1 }} />
            {Platform.OS === 'web' && (
                <DiffStyleToggle value={diffStyle} onChange={onDiffStyleChange} />
            )}
            <Pressable onPress={onClose} hitSlop={15} style={styles.closeButton}>
                <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

/** Single file section: header + pre-loaded diff content */
const FileDiffSection = React.memo(function FileDiffSection({
    result,
    diffStyle,
    isHighlighted,
    onLayout,
}: {
    result: FileDiffResult;
    diffStyle: 'unified' | 'split';
    isHighlighted: boolean;
    onLayout: (y: number) => void;
}) {
    const { theme } = useUnistyles();
    const { file, content, error } = result;
    const [collapsed, setCollapsed] = React.useState(false);

    const fileName = file.fullPath.split('/').pop() || file.fullPath;
    const isEmpty =
        content === null ? false :
        content.kind === 'patch' ? content.patch.trim() === '' :
        content.contents === '';

    const stats = React.useMemo(() => {
        if (!content) return null;
        if (content.kind === 'patch') return getPatchDiffStats(content.patch);
        const lineCount = content.contents === '' ? 0 : content.contents.split('\n').length;
        return { additions: lineCount, deletions: 0 };
    }, [content]);

    return (
        <View
            style={[
                styles.fileSection,
                { borderBottomColor: theme.colors.divider },
                isHighlighted && { backgroundColor: theme.colors.surfaceHigh },
            ]}
            onLayout={(e) => onLayout(e.nativeEvent.layout.y)}
        >
            {/* File header */}
            <Pressable
                style={[styles.fileHeader, { backgroundColor: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }]}
                onPress={() => setCollapsed((c) => !c)}
            >
                <Ionicons
                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
                <FileIcon fileName={fileName} size={18} />
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.headerPath, { color: theme.colors.textSecondary }]}
                >
                    {file.fullPath}
                </Text>
                {file.status === 'deleted' && (
                    <Text style={[styles.statusBadge, { color: '#FF3B30' }]}>deleted</Text>
                )}
                {file.status === 'untracked' && (
                    <Text style={[styles.statusBadge, { color: '#34C759' }]}>new</Text>
                )}
                {stats && (stats.additions > 0 || stats.deletions > 0) && (
                    <View style={styles.stats}>
                        {stats.additions > 0 && <Text style={styles.added}>+{stats.additions}</Text>}
                        {stats.deletions > 0 && <Text style={styles.removed}>-{stats.deletions}</Text>}
                    </View>
                )}
            </Pressable>

            {/* Diff content */}
            {!collapsed && (
                error ? (
                    <View style={styles.sectionMessage}>
                        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{error}</Text>
                    </View>
                ) : !content || isEmpty ? (
                    <View style={styles.sectionMessage}>
                        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('files.noChanges')}</Text>
                    </View>
                ) : content.kind === 'patch' ? (
                    <PierreDiffView
                        key={diffStyle}
                        patch={content.patch}
                        diffStyle={diffStyle}
                        disableFileHeader
                    />
                ) : (
                    <PierreDiffView
                        key={diffStyle}
                        oldFile={{ name: fileName, contents: '' }}
                        newFile={{ name: fileName, contents: content.contents }}
                        diffStyle={diffStyle}
                        disableFileHeader
                    />
                )
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
    outer: {
        flex: 1,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    topBarTitle: {
        fontSize: 14,
        ...Typography.default('semiBold'),
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
    fileSection: {
        borderBottomWidth: 1,
    },
    fileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    headerPath: {
        flex: 1,
        fontSize: 13,
        ...Typography.mono(),
    },
    statusBadge: {
        fontSize: 11,
        ...Typography.mono(),
        fontWeight: '600',
    },
    stats: {
        flexDirection: 'row',
        gap: 6,
    },
    added: {
        fontSize: 12,
        color: '#34C759',
        ...Typography.mono(),
    },
    removed: {
        fontSize: 12,
        color: '#FF3B30',
        ...Typography.mono(),
    },
    sectionMessage: {
        paddingVertical: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
