import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { getDiffStats, getPatchDiffStats } from '@/components/diff/calculateDiff';

interface CodexPatchViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

type CodexPatchEntry = {
    diff?: string;
    kind?: {
        type?: string;
        move_path?: string | null;
    };
    add?: {
        content?: string;
    };
    modify?: {
        old_content?: string;
        new_content?: string;
    };
    delete?: {
        content?: string;
    };
};

function getPatchChanges(input: any): Record<string, CodexPatchEntry> | null {
    if (input?.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) {
        return input.changes as Record<string, CodexPatchEntry>;
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object' && !Array.isArray(input.fileChanges)) {
        return input.fileChanges as Record<string, CodexPatchEntry>;
    }
    return null;
}

type PatchInput =
    | { kind: 'patch'; patch: string }
    | { kind: 'pair'; oldText: string; newText: string };

function getPatchInput(change: CodexPatchEntry): PatchInput | null {
    if (typeof change.diff === 'string') {
        return { kind: 'patch', patch: change.diff };
    }
    if (change.modify) {
        return { kind: 'pair', oldText: change.modify.old_content || '', newText: change.modify.new_content || '' };
    }
    if (change.add) {
        return { kind: 'pair', oldText: '', newText: change.add.content || '' };
    }
    if (change.delete) {
        return { kind: 'pair', oldText: change.delete.content || '', newText: '' };
    }
    return null;
}

function getPatchKindLabel(change: CodexPatchEntry): string | null {
    switch (change.kind?.type) {
        case 'add':
            return 'new';
        case 'delete':
            return 'delete';
        case 'update':
            return change.kind.move_path ? 'move' : 'edit';
        default:
            return null;
    }
}

export const CodexPatchView = React.memo<CodexPatchViewProps>(({ tool, metadata }) => {
    const { theme } = useUnistyles();
    const { input } = tool;
    const changes = getPatchChanges(input);

    const entries = changes ? Object.entries(changes) : [];

    if (entries.length === 0) {
        return null;
    }

    return (
        <>
            {entries.map(([file, change]) => {
                const filePath = resolvePath(file, metadata);
                const diffInput = getPatchInput(change);
                const kindLabel = getPatchKindLabel(change);
                const movePath = change.kind?.move_path ? resolvePath(change.kind.move_path, metadata) : null;
                const fileName = file.split('/').pop() ?? file;
                const stats = !diffInput
                    ? null
                    : diffInput.kind === 'patch'
                        ? getPatchDiffStats(diffInput.patch)
                        : getDiffStats(diffInput.oldText, diffInput.newText);

                return (
                    <ToolSectionView key={file} fullWidth>
                        <View style={styles.patchContainer}>
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
                            {diffInput?.kind === 'patch' ? (
                                <ToolDiffView patch={diffInput.patch} fileName={fileName} />
                            ) : diffInput?.kind === 'pair' && (diffInput.oldText.length > 0 || diffInput.newText.length > 0) ? (
                                <ToolDiffView
                                    oldText={diffInput.oldText}
                                    newText={diffInput.newText}
                                    fileName={fileName}
                                />
                            ) : null}
                        </View>
                    </ToolSectionView>
                );
            })}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    patchContainer: {
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    fileHeader: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surfaceHigh,
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
