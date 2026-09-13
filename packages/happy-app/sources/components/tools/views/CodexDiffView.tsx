import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { DiffFileHeader } from '@/components/diff/DiffFileHeader';
import { Metadata } from '@/sync/storageTypes';
import { parseUnifiedDiff } from '@/utils/codexUnifiedDiff';
import { countPatchStats } from '@/components/diff/engine/stats';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool, metadata }) => {
    const { input } = tool;
    const patch = typeof input?.unified_diff === 'string' ? input.unified_diff : undefined;
    // Gemini sends the path alongside the diff; Codex only has the diff headers.
    // Either way the name drives syntax highlighting, so prefer the explicit one.
    const explicitPath =
        typeof input?.path === 'string' ? input.path :
        typeof input?.filePath === 'string' ? input.filePath :
        undefined;
    const fileName = explicitPath ?? (patch ? parseUnifiedDiff(patch).fileName : undefined);
    const stats = React.useMemo(() => (patch ? countPatchStats(patch) : null), [patch]);

    if (!patch) return null;

    return (
        <ToolSectionView fullWidth>
            {fileName ? (
                <DiffFileHeader file={{ path: fileName, kind: 'modified', additions: stats?.additions ?? 0, deletions: stats?.deletions ?? 0 }} />
            ) : null}
            <ToolDiffView patch={patch} fileName={fileName} />
        </ToolSectionView>
    );
});

// Full-screen variant used by the tool detail screen: renders the diff as a
// bordered card instead of the chat-bubble section with negative margins.
export const CodexDiffViewFull = React.memo<CodexDiffViewProps>(({ tool }) => {
    const { input } = tool;
    const patch = typeof input?.unified_diff === 'string' ? input.unified_diff : undefined;
    const explicitPath =
        typeof input?.path === 'string' ? input.path :
        typeof input?.filePath === 'string' ? input.filePath :
        undefined;
    const fileName = explicitPath ?? (patch ? parseUnifiedDiff(patch).fileName : undefined);
    const stats = React.useMemo(() => (patch ? countPatchStats(patch) : null), [patch]);

    if (!patch) return null;

    return (
        <View style={styles.fullViewContainer}>
            <View style={styles.fullViewCard}>
                {fileName ? (
                    <DiffFileHeader file={{ path: fileName, kind: 'modified', additions: stats?.additions ?? 0, deletions: stats?.deletions ?? 0 }} />
                ) : null}
                <ToolDiffView patch={patch} fileName={fileName} />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    fullViewContainer: {
        paddingHorizontal: 12,
        marginBottom: 28,
    },
    fullViewCard: {
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
}));
