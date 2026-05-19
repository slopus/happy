import * as React from 'react';
import { Pressable, View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { getDiffStats, getPatchDiffStats } from '@/components/diff/calculateDiff';
import { materializeUnifiedDiffPatch } from '@/utils/codexUnifiedDiff';
import { t } from '@/text';

interface CodexPatchViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    permissionFooter?: React.ReactNode;
}

type CodexPatchEntry = {
    diff?: string;
    unified_diff?: string;
    type?: string;
    content?: string;
    move_path?: string | null;
    oldContent?: string;
    newContent?: string;
    old_content?: string;
    new_content?: string;
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
    if (Array.isArray(input?.changes)) {
        return normalizePatchChangeList(input.changes);
    }
    if (input?.changes && typeof input.changes === 'object') {
        return input.changes as Record<string, CodexPatchEntry>;
    }
    if (Array.isArray(input?.fileChanges)) {
        return normalizePatchChangeList(input.fileChanges);
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object') {
        return input.fileChanges as Record<string, CodexPatchEntry>;
    }
    return null;
}

function normalizePatchChangeList(changes: unknown[]): Record<string, CodexPatchEntry> | null {
    const normalized: Record<string, CodexPatchEntry> = {};

    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const changeRecord = change as Record<string, unknown>;
        const path = typeof changeRecord.path === 'string' ? changeRecord.path : null;
        if (!path) {
            continue;
        }

        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as { type?: string; move_path?: string | null }
            : null;
        const type = typeof changeRecord.type === 'string' ? changeRecord.type : (kind?.type ?? null);
        const entry: CodexPatchEntry = {
            ...(kind ? { kind } : type ? { kind: { type, move_path: null } } : {}),
        };

        if (typeof changeRecord.diff === 'string') {
            entry.diff = changeRecord.diff;
        } else if (typeof changeRecord.unified_diff === 'string') {
            entry.unified_diff = changeRecord.unified_diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add as { content?: string };
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify as { old_content?: string; new_content?: string };
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete as { content?: string };
        }

        if (type === 'add' && typeof changeRecord.content === 'string') {
            entry.add = { content: changeRecord.content };
        }
        if (type === 'delete' && typeof changeRecord.content === 'string') {
            entry.delete = { content: changeRecord.content };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

type PatchInput =
    | { kind: 'patch'; patch: string }
    | { kind: 'pair'; oldText: string; newText: string };

function getPatchInput(change: CodexPatchEntry): PatchInput | null {
    if (typeof change.diff === 'string') {
        return { kind: 'patch', patch: change.diff };
    }
    if (typeof change.unified_diff === 'string') {
        return { kind: 'patch', patch: change.unified_diff };
    }
    if (change.modify) {
        return { kind: 'pair', oldText: change.modify.old_content || '', newText: change.modify.new_content || '' };
    }
    if (typeof change.oldContent === 'string' || typeof change.newContent === 'string') {
        return { kind: 'pair', oldText: change.oldContent || '', newText: change.newContent || '' };
    }
    if (typeof change.old_content === 'string' || typeof change.new_content === 'string') {
        return { kind: 'pair', oldText: change.old_content || '', newText: change.new_content || '' };
    }
    if (change.add) {
        return { kind: 'pair', oldText: '', newText: change.add.content || '' };
    }
    if (getPatchKindType(change) === 'add' && typeof change.content === 'string') {
        return { kind: 'pair', oldText: '', newText: change.content };
    }
    if (change.delete) {
        return { kind: 'pair', oldText: change.delete.content || '', newText: '' };
    }
    if (getPatchKindType(change) === 'delete' && typeof change.content === 'string') {
        return { kind: 'pair', oldText: change.content, newText: '' };
    }
    return null;
}

function getPatchKindType(change: CodexPatchEntry): string | null {
    return change.kind?.type ?? change.type ?? null;
}

function getPatchKindLabel(change: CodexPatchEntry): string | null {
    switch (getPatchKindType(change)) {
        case 'add':
            return 'new';
        case 'delete':
            return 'delete';
        case 'update':
            return getPatchMovePath(change) ? 'move' : 'edit';
        default:
            return null;
    }
}

function getPatchMovePath(change: CodexPatchEntry): string | null {
    return change.kind?.move_path ?? change.move_path ?? null;
}

export const CodexPatchView = React.memo<CodexPatchViewProps>(({ tool, metadata, permissionFooter }) => {
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
                    permissionFooter={index === entries.length - 1 ? permissionFooter : null}
                />
            ))}
        </>
    );
});

const CodexPatchFileView = React.memo(function CodexPatchFileView(props: {
    file: string;
    change: CodexPatchEntry;
    metadata: Metadata | null;
    permissionFooter?: React.ReactNode;
}) {
    const { file, change, metadata, permissionFooter } = props;
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);

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
            ? getPatchDiffStats(displayPatch ?? diffInput.patch)
            : getDiffStats(diffInput.oldText, diffInput.newText);

    return (
        <ToolSectionView fullWidth>
            <View style={styles.editedFileGroup}>
                <Pressable
                    onPress={() => setExpanded((value) => !value)}
                    style={({ pressed }) => [
                        styles.editToggle,
                        pressed && styles.editTogglePressed,
                    ]}
                >
                    <Text style={styles.editToggleText} numberOfLines={1}>
                        {t('toolGroup.editedFile')}
                    </Text>
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
                {expanded ? (
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
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    editedFileGroup: {
        gap: 6,
    },
    editToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
        maxWidth: '100%',
        paddingHorizontal: 14,
        paddingTop: 2,
        paddingBottom: 4,
    },
    editTogglePressed: {
        opacity: 0.6,
    },
    editToggleText: {
        flexShrink: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    patchContainer: {
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        marginHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    permissionFooterContainer: {
        paddingHorizontal: 12,
        paddingTop: 8,
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
