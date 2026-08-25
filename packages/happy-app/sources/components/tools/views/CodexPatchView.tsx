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
import { countContentStats, countPatchStats } from '@/components/diff/engine/stats';
import { materializeUnifiedDiffPatch } from '@/utils/codexUnifiedDiff';
import {
    getPatchChanges,
    getPatchInput,
    getPatchKindLabel,
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
        return null;
    }

    return (
        <>
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
        return null;
    }

    return (
        <View style={styles.fullViewContainer}>
            {entries.map(([file, change]) => (
                <CodexPatchFileContent key={file} file={file} change={change} metadata={metadata} />
            ))}
        </View>
    );
});

const CodexPatchFileContent = React.memo(function CodexPatchFileContent(props: {
    file: string;
    change: CodexPatchEntry;
    metadata: Metadata | null;
}) {
    const { file, change, metadata } = props;
    const { theme } = useUnistyles();

    const filePath = resolvePath(file, metadata);
    const diffInput = getPatchInput(change);
    const kindLabel = getPatchKindLabel(change);
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
            <View style={styles.fileHeader}>
                <View style={styles.fileHeaderMain}>
                    <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                    <Text style={styles.filePath}>{filePath}</Text>
                    {kindLabel ? <Text style={styles.kindLabel}>{kindLabel}</Text> : null}
                    {stats && (stats.additions > 0 || stats.deletions > 0) ? (
                        <View style={styles.stats}>
                            {stats.additions > 0 ? <Text style={styles.added}>+{stats.additions}</Text> : null}
                            {stats.deletions > 0 ? <Text style={styles.removed}>-{stats.deletions}</Text> : null}
                        </View>
                    ) : null}
                </View>
                {movePath ? <Text style={styles.movePath}>{movePath}</Text> : null}
            </View>
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
    const kindLabel = getPatchKindLabel(change);
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
                        style={({ pressed }) => [styles.fileHeader, pressed && styles.fileHeaderPressed]}
                    >
                        <View style={styles.fileHeaderMain}>
                            <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                            <Text style={styles.filePath}>{filePath}</Text>
                            {kindLabel ? <Text style={styles.kindLabel}>{kindLabel}</Text> : null}
                            {stats && (stats.additions > 0 || stats.deletions > 0) ? (
                                <View style={styles.stats}>
                                    {stats.additions > 0 ? <Text style={styles.added}>+{stats.additions}</Text> : null}
                                    {stats.deletions > 0 ? <Text style={styles.removed}>-{stats.deletions}</Text> : null}
                                </View>
                            ) : null}
                            {canOpen ? (
                                <Octicons name="chevron-right" size={14} color={theme.colors.textSecondary} />
                            ) : null}
                        </View>
                        {movePath ? <Text style={styles.movePath}>{movePath}</Text> : null}
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

const styles = StyleSheet.create((theme) => ({
    editedFileGroup: {
        gap: 0,
    },
    // Flush inside the tool card rather than a rounded box within a rounded
    // box; files are separated by the header's own rule instead of a border.
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
    fileHeader: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        gap: 4,
    },
    fileHeaderMain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    filePath: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'monospace',
        flex: 1,
    },
    kindLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    movePath: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    stats: {
        flexDirection: 'row',
        gap: 8,
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
    added: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#34C759',
    },
    removed: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#FF3B30',
    },
}));
