import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';
import { parseUnifiedDiff } from '@/utils/codexUnifiedDiff';

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

function getPatchTexts(change: CodexPatchEntry): { oldText: string; newText: string } | null {
    if (change.modify) {
        return {
            oldText: change.modify.old_content || '',
            newText: change.modify.new_content || '',
        };
    }

    if (change.add) {
        return {
            oldText: '',
            newText: change.add.content || '',
        };
    }

    if (change.delete) {
        return {
            oldText: change.delete.content || '',
            newText: '',
        };
    }

    if (typeof change.diff === 'string') {
        const parsed = parseUnifiedDiff(change.diff);
        return {
            oldText: parsed.oldText,
            newText: parsed.newText,
        };
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
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
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
                const texts = getPatchTexts(change);
                const kindLabel = getPatchKindLabel(change);
                const movePath = change.kind?.move_path ? resolvePath(change.kind.move_path, metadata) : null;
                const hasDiff = !!texts && (texts.oldText.length > 0 || texts.newText.length > 0);

                return (
                    <ToolSectionView key={file} fullWidth>
                        <View style={styles.patchContainer}>
                            <View style={styles.fileHeader}>
                                <View style={styles.fileHeaderMain}>
                                    <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                                    <Text style={styles.filePath}>{filePath}</Text>
                                    {kindLabel ? <Text style={styles.kindLabel}>{kindLabel}</Text> : null}
                                </View>
                                {movePath ? <Text style={styles.movePath}>{movePath}</Text> : null}
                            </View>
                            {hasDiff ? (
                                <ToolDiffView
                                    oldText={texts.oldText}
                                    newText={texts.newText}
                                    showLineNumbers={showLineNumbersInToolViews}
                                    showPlusMinusSymbols={showLineNumbersInToolViews}
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
}));
