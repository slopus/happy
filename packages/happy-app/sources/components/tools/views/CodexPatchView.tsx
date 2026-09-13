import * as React from 'react';
import { Pressable, View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { DiffFileHeader } from '@/components/diff/DiffFileHeader';
import { useDiffPalette } from '@/components/diff/DiffPalette';
import { countContentStats, countPatchStats } from '@/components/diff/engine/stats';
import { materializeUnifiedDiffPatch } from '@/utils/codexUnifiedDiff';
import { CodeView } from '@/components/CodeView';
import { ToolError } from '../ToolError';
import { toolResultText } from '@/utils/toolResult';
import { t } from '@/text';
import {
    getPatchChanges,
    getPatchInput,
    getPatchKindType,
    getPatchMovePath,
    type CodexPatchEntry,
} from '@/utils/codexPatchEntry';

interface CodexPatchViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    sessionId?: string;
    messageId?: string;
    /** When set, render only this file out of the patch. */
    focusFile?: string;
    permissionFooter?: React.ReactNode;
}

export const CodexPatchView = React.memo<CodexPatchViewProps>(({ tool, metadata, sessionId, messageId, permissionFooter }) => {
    const { input } = tool;
    const changes = getPatchChanges(input);

    const entries = changes ? Object.entries(changes) : [];

    if (entries.length === 0) {
        return <PatchFallback tool={tool} permissionFooter={permissionFooter} />;
    }

    return (
        <>
            <PatchError tool={tool} />
            {entries.map(([file, change], index) => (
                <CodexPatchFileView
                    key={file}
                    file={file}
                    change={change}
                    metadata={metadata}
                    sessionId={sessionId}
                    messageId={messageId}
                    permissionFooter={index === entries.length - 1 ? permissionFooter : null}
                />
            ))}
        </>
    );
});

// Full-screen variant used by the tool detail screen: every file is rendered
// expanded, without the collapse toggle used in the chat feed.
export const CodexPatchViewFull = React.memo<CodexPatchViewProps>(({ tool, metadata, focusFile }) => {
    const changes = getPatchChanges(tool.input);
    const allEntries = changes ? Object.entries(changes) : [];
    // Arriving from a tapped file means the user asked for that diff, not the
    // whole patch; fall back to everything if the path no longer matches.
    const focused = focusFile ? allEntries.filter(([file]) => file === focusFile) : [];
    const entries = focused.length > 0 ? focused : allEntries;

    if (entries.length === 0) {
        return <PatchFallback tool={tool} showError={false} />;
    }

    return (
        <View style={styles.fullViewContainer}>
            {entries.map(([file, change]) => (
                <CodexPatchFileContent key={file} file={file} change={change} metadata={metadata} />
            ))}
        </View>
    );
});

function PatchError({ tool }: { tool: ToolCall }) {
    return tool.state === 'error' && tool.result != null
        ? <ToolError message={toolResultText(tool.result) ?? ''} /> : null;
}

/** A rejected or future patch format must never become a blank, headerless card. */
function PatchFallback({ tool, permissionFooter, showError = true }: { tool: ToolCall; permissionFooter?: React.ReactNode; showError?: boolean }) {
    const rawPatch = typeof tool.input?.patch === 'string' ? tool.input.patch
        : typeof tool.input?.input === 'string' ? tool.input.input : toolResultText(tool.input);
    return (
        <ToolSectionView title={t('tools.names.applyChanges')}>
            {showError ? <PatchError tool={tool} /> : null}
            {rawPatch ? <CodeView code={rawPatch} /> : null}
            {permissionFooter}
        </ToolSectionView>
    );
}

const CodexPatchFileContent = React.memo(function CodexPatchFileContent(props: {
    file: string;
    change: CodexPatchEntry;
    metadata: Metadata | null;
}) {
    const { file, change, metadata } = props;
    const filePath = resolvePath(file, metadata);
    const diffInput = getPatchInput(change);
    const rawMovePath = getPatchMovePath(change);
    const movePath = rawMovePath ? resolvePath(rawMovePath, metadata) : null;
    const fileName = file.split('/').pop() ?? file;
    const displayPatch = diffInput?.kind === 'patch'
        ? materializeUnifiedDiffPatch(diffInput.patch, file, getPatchKindType(change))
        : null;
    const stats = !diffInput
        ? null
        : diffInput.kind === 'patch'
            ? countPatchStats(displayPatch ?? diffInput.patch)
            : countContentStats(diffInput.oldText, diffInput.newText);

    return (
        <View style={styles.fullViewFile}>
            <PatchFileHeader path={filePath} change={change} movePath={movePath} stats={stats} />
            {displayPatch ? (
                <ToolDiffView patch={displayPatch} fileName={fileName} />
            ) : diffInput?.kind === 'pair' && (diffInput.oldText.length > 0 || diffInput.newText.length > 0) ? (
                <ToolDiffView
                    oldText={diffInput.oldText}
                    newText={diffInput.newText}
                    fileName={fileName}
                />
            ) : null}
        </View>
    );
});

const CodexPatchFileView = React.memo(function CodexPatchFileView(props: {
    file: string;
    change: CodexPatchEntry;
    metadata: Metadata | null;
    sessionId?: string;
    messageId?: string;
    permissionFooter?: React.ReactNode;
}) {
    const { file, change, metadata, sessionId, messageId, permissionFooter } = props;
    const { theme } = useUnistyles();
    const router = useRouter();

    // Tapping a file opens the full-screen diff for that one file. Without the
    // route params there is nowhere to go, so the card stays inert rather than
    // pretending to be tappable.
    const canOpen = Boolean(sessionId && messageId);
    const openFullDiff = React.useCallback(() => {
        if (!sessionId || !messageId) return;
        router.push(`/session/${sessionId}/message/${messageId}?file=${encodeURIComponent(file)}`);
    }, [router, sessionId, messageId, file]);

    const filePath = resolvePath(file, metadata);
    const diffInput = getPatchInput(change);
    const rawMovePath = getPatchMovePath(change);
    const movePath = rawMovePath ? resolvePath(rawMovePath, metadata) : null;
    const fileName = file.split('/').pop() ?? file;
    const displayPatch = diffInput?.kind === 'patch'
        ? materializeUnifiedDiffPatch(diffInput.patch, file, getPatchKindType(change))
        : null;
    const stats = !diffInput
        ? null
        : diffInput.kind === 'patch'
            ? countPatchStats(displayPatch ?? diffInput.patch)
            : countContentStats(diffInput.oldText, diffInput.newText);

    return (
        <ToolSectionView fullWidth>
            <View style={styles.editedFileGroup}>
                <View style={styles.patchContainer}>
                    <Pressable
                        onPress={canOpen ? openFullDiff : undefined}
                        disabled={!canOpen}
                        accessibilityRole={canOpen ? 'button' : undefined}
                        style={({ pressed }) => pressed && styles.fileHeaderPressed}
                    >
                        <PatchFileHeader
                            path={filePath}
                            change={change}
                            movePath={movePath}
                            stats={stats}
                            right={canOpen ? (
                                <Octicons name="chevron-right" size={14} color={theme.colors.textSecondary} />
                            ) : null}
                        />
                    </Pressable>
                    {displayPatch ? (
                        <ToolDiffView patch={displayPatch} fileName={fileName} />
                    ) : diffInput?.kind === 'pair' && (diffInput.oldText.length > 0 || diffInput.newText.length > 0) ? (
                        <ToolDiffView
                            oldText={diffInput.oldText}
                            newText={diffInput.newText}
                            fileName={fileName}
                        />
                    ) : null}
                    {permissionFooter ? (
                        <View style={styles.permissionFooterContainer}>
                            {permissionFooter}
                        </View>
                    ) : null}
                </View>
            </View>
        </ToolSectionView>
    );
});

/** Chat patches and View Changes use the same file heading and palette. */
function PatchFileHeader({ path, change, movePath, stats, right }: {
    path: string;
    change: CodexPatchEntry;
    movePath: string | null;
    stats: { additions: number; deletions: number } | null;
    right?: React.ReactNode;
}) {
    const palette = useDiffPalette();
    const kind = getPatchKindType(change);
    return (
        <View style={{ backgroundColor: palette.hunkBg }}>
            <DiffFileHeader
                file={{
                    path,
                    kind: movePath ? 'renamed' : kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : 'modified',
                    additions: stats?.additions ?? 0,
                    deletions: stats?.deletions ?? 0,
                }}
                right={right}
            />
            {movePath ? <Text style={[styles.movePath, { color: palette.textSecondary }]}>{movePath}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    editedFileGroup: {
        gap: 0,
    },
    // Flush inside the tool card, with the same header/body seam as View Changes.
    patchContainer: {
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    permissionFooterContainer: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
    fileHeaderPressed: {
        opacity: 0.6,
    },
    movePath: {
        fontSize: 12,
        fontFamily: 'monospace',
        paddingHorizontal: 12,
        paddingBottom: 9,
    },
    fullViewContainer: {
        gap: 16,
        paddingHorizontal: 12,
        marginBottom: 28,
    },
    fullViewFile: {
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
}));
