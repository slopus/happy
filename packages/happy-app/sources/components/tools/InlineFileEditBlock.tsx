import * as React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { ToolSectionView } from '@/components/tools/ToolSectionView';
import {
    getFileEditDiffMetrics,
    LARGE_EDIT_CHANGED_LINES,
    type FileEditDiffSection,
} from '@/components/tools/fileEditMetrics';
import { t } from '@/text';
import { trimIdent } from '@/utils/trimIdent';

// Collapsed height of a large edit. Enough to read the shape of the change
// without one edit swallowing the whole transcript.
const COLLAPSED_DIFF_MAX_HEIGHT = 300;

interface InlineFileEditBlockProps {
    filePath: string;
    fileName: string;
    kindLabel?: string | null;
    movePath?: string | null;
    patch?: string;
    oldText?: string;
    newText?: string;
    /** Multiple hunks in one file (MultiEdit). Takes precedence over oldText/newText. */
    pairs?: readonly { oldText: string; newText: string }[];
    permissionFooter?: React.ReactNode;
}

export const InlineFileEditBlock = React.memo<InlineFileEditBlockProps>(({
    filePath,
    fileName,
    kindLabel,
    movePath,
    patch,
    oldText,
    newText,
    pairs,
    permissionFooter,
}) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);

    const sections = React.useMemo<FileEditDiffSection[]>(() => {
        if (patch !== undefined) {
            return [{ patch }];
        }
        if (pairs !== undefined) {
            return pairs.map(pair => ({
                oldText: trimIdent(pair.oldText),
                newText: trimIdent(pair.newText),
            }));
        }
        if (oldText !== undefined || newText !== undefined) {
            return [{
                oldText: trimIdent(oldText ?? ''),
                newText: trimIdent(newText ?? ''),
            }];
        }
        return [];
    }, [oldText, newText, pairs, patch]);

    const metrics = React.useMemo(() => getFileEditDiffMetrics(sections), [sections]);
    const hasDiffContent = sections.some(section =>
        (section.patch?.length ?? 0) > 0
        || (section.oldText?.length ?? 0) > 0
        || (section.newText?.length ?? 0) > 0);
    const collapsed = !expanded && metrics.changedLines > LARGE_EDIT_CHANGED_LINES;

    return (
        <ToolSectionView fullWidth>
            <View style={styles.block}>
                <View style={styles.fileHeader}>
                    <View style={styles.fileHeaderMain}>
                        <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                        <Text style={styles.filePath} numberOfLines={1}>{filePath}</Text>
                        {kindLabel ? <Text style={styles.kindLabel}>{kindLabel}</Text> : null}
                        {(metrics.additions > 0 || metrics.deletions > 0) ? (
                            <View style={styles.stats}>
                                {metrics.additions > 0 ? <Text style={styles.added}>+{metrics.additions}</Text> : null}
                                {metrics.deletions > 0 ? <Text style={styles.removed}>-{metrics.deletions}</Text> : null}
                            </View>
                        ) : null}
                    </View>
                    {movePath ? <Text style={styles.movePath}>{movePath}</Text> : null}
                </View>
                {hasDiffContent ? (
                    <View style={collapsed ? styles.collapsedDiff : null}>
                        {sections.map((section, index) => (
                            <View key={index}>
                                {index > 0 ? <View style={styles.sectionSeparator} /> : null}
                                {section.patch !== undefined ? (
                                    <ToolDiffView patch={section.patch} fileName={fileName} />
                                ) : (
                                    <ToolDiffView
                                        oldText={section.oldText ?? ''}
                                        newText={section.newText ?? ''}
                                        fileName={fileName}
                                    />
                                )}
                            </View>
                        ))}
                    </View>
                ) : null}
                {collapsed ? (
                    <TouchableOpacity
                        style={styles.expandButton}
                        onPress={() => setExpanded(true)}
                        activeOpacity={0.7}
                    >
                        <Ionicons name="chevron-down" size={14} color={theme.colors.textSecondary} />
                        <Text style={styles.expandButtonText}>
                            {t('tools.fileEdit.showAllLines', { count: metrics.changedLines })}
                        </Text>
                    </TouchableOpacity>
                ) : null}
                {permissionFooter ? (
                    <View style={styles.permissionFooterContainer}>
                        {permissionFooter}
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    block: {
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        overflow: 'hidden',
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
    collapsedDiff: {
        maxHeight: COLLAPSED_DIFF_MAX_HEIGHT,
        overflow: 'hidden',
    },
    sectionSeparator: {
        height: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    expandButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    expandButtonText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
}));
