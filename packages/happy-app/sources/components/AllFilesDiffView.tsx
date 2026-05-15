import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';
import { sessionBash, sessionReadFile } from '@/sync/ops';
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
    /** Publishes the right-side controls (file count + diff style toggle) into the chat header. */
    onHeaderRightSlotChange: (slot: React.ReactNode) => void;
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
    onHeaderRightSlotChange,
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

    // Per-file diff cache keyed by fullPath. Reconciled incrementally as the
    // file set changes so the rendered ScrollView keeps its scroll position and
    // existing diff sections stay on screen while updated files refresh in the
    // background.
    const [resultsMap, setResultsMap] = React.useState<Map<string, FileDiffResult>>(() => new Map());
    // Signature of the last fetched version per fullPath. If the signature
    // (status + linesAdded + linesRemoved + isStaged) hasn't changed, the diff
    // for that file doesn't need to be re-fetched.
    const fetchedSignatures = React.useRef<Map<string, string>>(new Map());
    const inFlight = React.useRef<Set<string>>(new Set());
    // Track whether we've ever populated results — only show the global spinner
    // on the very first load, not on subsequent file-set changes.
    const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);

    const fileSignature = (f: GitFileStatus) =>
        `${f.status}|${f.isStaged ? 1 : 0}|${f.linesAdded}|${f.linesRemoved}`;

    React.useEffect(() => {
        if (files.length === 0) {
            // Drop everything; nothing to fetch.
            if (resultsMap.size > 0) setResultsMap(new Map());
            fetchedSignatures.current.clear();
            inFlight.current.clear();
            setHasLoadedOnce(true);
            return;
        }

        const session = storage.getState().sessions[sessionId];
        const sessionPath = session?.metadata?.path ?? null;

        // Reconcile keyed cache: drop files no longer present.
        const nextKeys = new Set(files.map((f) => f.fullPath));
        let mapChanged = false;
        const reconciled = new Map(resultsMap);
        for (const key of reconciled.keys()) {
            if (!nextKeys.has(key)) {
                reconciled.delete(key);
                fetchedSignatures.current.delete(key);
                inFlight.current.delete(key);
                mapChanged = true;
            }
        }
        if (mapChanged) setResultsMap(reconciled);

        // Identify which files need a (re-)fetch.
        const toFetch = files.filter((f) => {
            if (inFlight.current.has(f.fullPath)) return false;
            const prev = fetchedSignatures.current.get(f.fullPath);
            return prev !== fileSignature(f);
        });

        if (toFetch.length === 0) {
            if (!hasLoadedOnce) setHasLoadedOnce(true);
            return;
        }

        let cancelled = false;

        for (const file of toFetch) {
            inFlight.current.add(file.fullPath);
            fetchedSignatures.current.set(file.fullPath, fileSignature(file));
        }

        (async () => {
            const fetched = await Promise.all(
                toFetch.map(async (file): Promise<FileDiffResult> => {
                    if (!sessionPath) {
                        return { file, content: null, error: 'No session path' };
                    }
                    const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
                    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;
                    if (!gitDiffPath || !resolved) {
                        return { file, content: null, error: 'File is outside the session root.' };
                    }

                    try {
                        if (file.status === 'untracked') {
                            // Use the native sessionReadFile RPC instead of `cat`
                            // — `cat` doesn't behave the same on Windows
                            // (PowerShell aliases it to Get-Content which
                            // doesn't accept `--`), and shelling out for a
                            // plain read is slower anyway.
                            const res = await sessionReadFile(sessionId, resolved.absolutePath);
                            if (!res.success || !res.content) {
                                return { file, content: null, error: res.error || 'Failed to read file' };
                            }
                            let contents: string;
                            try {
                                const binary = atob(res.content);
                                const bytes = new Uint8Array(binary.length);
                                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                contents = new TextDecoder().decode(bytes);
                            } catch {
                                return { file, content: null, error: 'Failed to decode file' };
                            }
                            return { file, content: { kind: 'newFile', contents }, error: null };
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

            if (cancelled) return;

            setResultsMap((prev) => {
                const next = new Map(prev);
                for (const r of fetched) {
                    next.set(r.file.fullPath, r);
                }
                return next;
            });
            for (const r of fetched) {
                inFlight.current.delete(r.file.fullPath);
            }
            setHasLoadedOnce(true);
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, files]);

    // Render in deterministic file order (same sort as `files`).
    const results = React.useMemo<FileDiffResult[]>(() => {
        const out: FileDiffResult[] = [];
        for (const f of files) {
            const r = resultsMap.get(f.fullPath);
            if (r) out.push(r);
        }
        return out;
    }, [files, resultsMap]);

    // Initial-mount spinner: only show until results have ever been populated.
    const loading = !hasLoadedOnce && results.length === 0 && files.length > 0;

    // Whenever the file list changes (new file silently appears, an existing
    // file disappears, a sort order shifts), all cached Y offsets are
    // potentially stale: insertions push every section below them downward.
    // Drop the cache so the scroll-to-file effect waits for fresh onLayout
    // values rather than scrolling to a position the file no longer occupies.
    React.useEffect(() => {
        fileOffsets.current.clear();
    }, [results]);

    // Scroll to the target file after content renders.
    //
    // Two race conditions to defeat:
    //   1. Initial mount — diffs are still fetching, sections aren't laid out yet,
    //      so the offset map is empty.
    //   2. Re-renders triggered by back / forward navigation — the prop changes
    //      while sections are already mounted; we want the scroll to happen on
    //      the next frame, not after a fixed delay.
    //
    // Strategy: try on the next animation frame; if the offset isn't recorded
    // yet, retry up to a few times.
    React.useEffect(() => {
        if (loading || !scrollToFile) return;
        let cancelled = false;
        let rafId = 0;
        let attempt = 0;
        const tryScroll = () => {
            if (cancelled) return;
            const offset = fileOffsets.current.get(scrollToFile);
            if (offset !== undefined && scrollRef.current) {
                scrollRef.current.scrollTo({ y: offset, animated: true });
                return;
            }
            if (attempt++ < 8) {
                rafId = requestAnimationFrame(tryScroll);
            }
        };
        rafId = requestAnimationFrame(tryScroll);
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [scrollToFile, loading]);

    // Publish header right-slot controls (file count + diff style toggle) into the chat header.
    React.useEffect(() => {
        onHeaderRightSlotChange(
            <DiffHeaderRight
                fileCount={files.length}
                diffStyle={diffStyle}
                onDiffStyleChange={setDiffStyle}
            />
        );
        return () => onHeaderRightSlotChange(null);
    }, [files.length, diffStyle, setDiffStyle, onHeaderRightSlotChange]);

    if (files.length === 0 && !loading) {
        return (
            <View style={[styles.outer, { backgroundColor: theme.colors.surface }]}>
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

/** Right-side header controls for the diff overlay: file count + (web-only) Unified | Split toggle. */
const DiffHeaderRight = React.memo(function DiffHeaderRight({
    fileCount,
    diffStyle,
    onDiffStyleChange,
}: {
    fileCount: number;
    diffStyle: 'unified' | 'split';
    onDiffStyleChange: (v: 'unified' | 'split') => void;
}) {
    const { theme } = useUnistyles();
    return (
        <>
            <Text style={[styles.headerRightCount, { color: theme.colors.textSecondary }]}>
                {t('files.changedFiles', { count: fileCount })}
            </Text>
            {Platform.OS === 'web' && (
                <DiffStyleToggle value={diffStyle} onChange={onDiffStyleChange} />
            )}
        </>
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
    headerRightCount: {
        fontSize: 13,
        ...Typography.default(),
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
