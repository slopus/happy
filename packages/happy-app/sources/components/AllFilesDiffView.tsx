import * as React from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { DiffFilesList, type DiffFileItem } from '@/components/diff/DiffFilesList';
import { DiffHeaderRight } from '@/components/diff/DiffHeaderRight';
import { HappyAgentDiffView } from '@/components/HappyAgentDiffView';
import { countPatchStats } from '@/components/diff/engine/stats';
import { buildGitDiffCommand, buildGitShowBase64Command, FULL_FILE_CONTEXT } from '@/utils/gitDiffCommand';
import { imageDataUri, isImagePath } from '@/utils/imageFiles';
import { sessionBash, sessionReadFile } from '@/sync/ops';
import { storage, useSession, useSessionGitStatusFiles, useSettingMutable } from '@/sync/storage';
import { isRigMetadata } from '@/sync/rig';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface AllFilesDiffViewProps {
    sessionId: string;
    /** When set, auto-scroll to this file */
    scrollToFile?: string | null;
    /** Optional toolbar for the desktop overlay. The standalone route has none. */
    onHeaderRightSlotChange?: (slot: React.ReactNode) => void;
}

type DiffContent =
    | { kind: 'patch'; patch: string }
    | { kind: 'newFile'; contents: string }
    | { kind: 'image'; before: string | null; after: string | null };

/** Lines in a blob, not counting the terminator after the last one. */
function countLines(text: string): number {
    if (text === '') return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

type FileDiffResult = {
    file: GitFileStatus;
    content: DiffContent | null;
    error: string | null;
};

/** Native sessions use their workspace comparison; legacy CLI sessions keep their patch path. */
export const AllFilesDiffView = React.memo(function AllFilesDiffView(props: AllFilesDiffViewProps) {
    const session = useSession(props.sessionId);
    if (!session?.metadata) {
        return <View style={styles.centered}><ActivityIndicator size="small" /></View>;
    }
    return isRigMetadata(session.metadata)
        ? <HappyAgentDiffView key={props.sessionId} {...props} metadata={session.metadata} />
        : <LegacyAllFilesDiffView key={props.sessionId} {...props} />;
});

const LegacyAllFilesDiffView = React.memo(function LegacyAllFilesDiffView({
    sessionId,
    scrollToFile,
    onHeaderRightSlotChange,
}: AllFilesDiffViewProps) {
    const { theme } = useUnistyles();
    const gitStatusFiles = useSessionGitStatusFiles(sessionId);
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    // Files the reader asked to see in full, and whether whitespace-only
    // changes are folded away. Both change the git command, so both take part
    // in the fetch signature below.
    const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => new Set());
    const [ignoreWhitespace, setIgnoreWhitespace] = React.useState(false);

    const expandContext = React.useCallback((path: string) => {
        setExpandedPaths((prev) => {
            if (prev.has(path)) return prev;
            const next = new Set(prev);
            next.add(path);
            return next;
        });
    }, []);

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
        `${f.status}|${f.isStaged ? 1 : 0}|${f.linesAdded}|${f.linesRemoved}`
        + `|${expandedPaths.has(f.fullPath) ? 'full' : 'near'}|${ignoreWhitespace ? 'w' : ''}`;

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
                        // Images diff as pictures, not as text — read both sides
                        // rather than asking git for a patch it can't produce.
                        if (isImagePath(file.fullPath)) {
                            const [head, working] = await Promise.all([
                                file.status === 'untracked'
                                    ? Promise.resolve(null)
                                    : sessionBash(sessionId, {
                                        command: buildGitShowBase64Command(gitDiffPath),
                                        cwd: sessionPath,
                                        timeout: 8000,
                                    }).then((r) => (r.success ? r.stdout ?? null : null)).catch(() => null),
                                file.status === 'deleted'
                                    ? Promise.resolve(null)
                                    : sessionReadFile(sessionId, resolved.absolutePath)
                                        .then((r) => (r.success ? r.content ?? null : null))
                                        .catch(() => null),
                            ]);
                            return {
                                file,
                                content: {
                                    kind: 'image',
                                    before: head ? imageDataUri(file.fullPath, head) : null,
                                    after: working ? imageDataUri(file.fullPath, working) : null,
                                },
                                error: null,
                            };
                        }

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
                            command: buildGitDiffCommand(gitDiffPath, {
                                contextLines: expandedPaths.has(file.fullPath) ? FULL_FILE_CONTEXT : undefined,
                                ignoreWhitespace,
                            }),
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
    }, [sessionId, files, expandedPaths, ignoreWhitespace]);

    // Initial-mount spinner: only show until results have ever been populated.
    const loading = !hasLoadedOnce && resultsMap.size === 0 && files.length > 0;

    // Items for the unified renderer. Stats start from git status so a file that
    // hasn't been fetched (or is collapsed) still shows a header, then get
    // recounted from the content once it arrives: `git status` reports no line
    // counts at all for untracked files, which left every new file claiming
    // zero changed lines.
    const diffItems = React.useMemo<DiffFileItem[]>(() => files.map((file) => {
        const result = resultsMap.get(file.fullPath);
        const content = result?.content ?? null;
        const stats = !content || content.kind === 'image'
            ? { additions: file.linesAdded, deletions: file.linesRemoved }
            : content.kind === 'patch'
                ? countPatchStats(content.patch)
                : { additions: countLines(content.contents), deletions: 0 };
        return {
            path: file.fullPath,
            kind: file.status === 'untracked' ? 'added' : file.status === 'deleted' ? 'deleted' : 'modified',
            additions: stats.additions,
            deletions: stats.deletions,
            error: result?.error ?? null,
            image: content?.kind === 'image'
                ? { before: content.before, after: content.after }
                : undefined,
            source: !content || content.kind === 'image' ? null
                : content.kind === 'patch'
                    ? { kind: 'patch', patch: content.patch }
                    : { kind: 'contents', path: file.fullPath, oldText: '', newText: content.contents },
        };
    }), [files, resultsMap]);

    // Publish header right-slot controls (file count + diff style toggle) into the chat header.
    React.useEffect(() => {
        if (!onHeaderRightSlotChange) return;
        onHeaderRightSlotChange(
            <DiffHeaderRight
                fileCount={files.length}
                diffStyle={diffStyle}
                onDiffStyleChange={setDiffStyle}
                ignoreWhitespace={ignoreWhitespace}
                onIgnoreWhitespaceChange={setIgnoreWhitespace}
            />
        );
        return () => onHeaderRightSlotChange(null);
    }, [files.length, diffStyle, setDiffStyle, ignoreWhitespace, onHeaderRightSlotChange]);

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
                    onExpandContext={expandContext}
                    defaultCollapsed
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    outer: {
        flex: 1,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
});
