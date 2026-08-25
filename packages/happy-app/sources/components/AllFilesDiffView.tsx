import * as React from 'react';
import { View, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { DiffFilesList, type DiffFileItem } from '@/components/diff/DiffFilesList';
import { sessionBash, sessionReadFile } from '@/sync/ops';
import { storage, useSessionGitStatusFiles, useSettingMutable } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { GitFileStatus } from '@/sync/gitStatusFiles';
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
                            command: `git -c core.quotepath=false diff HEAD --no-ext-diff -- "${gitDiffPath}"`,
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

    // Initial-mount spinner: only show until results have ever been populated.
    const loading = !hasLoadedOnce && resultsMap.size === 0 && files.length > 0;

    // Items for the unified renderer. Stats come from git status, so a file that
    // hasn't been fetched (or is collapsed) still shows a correct header.
    const diffItems = React.useMemo<DiffFileItem[]>(() => files.map((file) => {
        const result = resultsMap.get(file.fullPath);
        const content = result?.content ?? null;
        return {
            path: file.fullPath,
            kind: file.status === 'untracked' ? 'added' : file.status === 'deleted' ? 'deleted' : 'modified',
            additions: file.linesAdded,
            deletions: file.linesRemoved,
            error: result?.error ?? null,
            source: !content ? null
                : content.kind === 'patch'
                    ? { kind: 'patch', patch: content.patch }
                    : { kind: 'contents', path: file.fullPath, oldText: '', newText: content.contents },
        };
    }), [files, resultsMap]);

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
                <DiffFilesList
                    items={diffItems}
                    scrollToPath={scrollToFile ?? null}
                    split={Platform.OS === 'web' && diffStyle === 'split'}
                    emptyText={t('files.noChanges')}
                />
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
});
