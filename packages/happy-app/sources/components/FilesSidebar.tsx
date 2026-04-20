import * as React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { storage, useSessionGitStatus, useSessionGitStatusFiles } from '@/sync/storage';
import { getGitStatusFiles, GitFileStatus } from '@/sync/gitStatusFiles';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

interface FilesSidebarProps {
    sessionId: string;
    selectedPath?: string | null;
    onFilePress?: (file: GitFileStatus) => void;
}

export const FilesSidebar = React.memo<FilesSidebarProps>(({ sessionId, selectedPath, onFilePress }) => {
    const router = useRouter();
    const gitStatusFiles = useSessionGitStatusFiles(sessionId);
    const gitStatus = useSessionGitStatus(sessionId);

    // Fetch file-level git status on mount and when summary status changes
    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            const result = await getGitStatusFiles(sessionId);
            if (!cancelled && result) {
                storage.getState().applyGitStatusFiles(sessionId, result);
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId, gitStatus?.lastUpdatedAt]);

    const handleFilePress = React.useCallback((file: GitFileStatus) => {
        if (file.status === 'deleted') return;
        if (onFilePress) {
            onFilePress(file);
            return;
        }
        const encodedPath = btoa(file.fullPath);
        router.push(`/session/${sessionId}/file?path=${encodedPath}`);
    }, [router, sessionId, onFilePress]);

    const renderFileGroup = (files: GitFileStatus[], label: string) => {
        if (files.length === 0) return null;
        return (
            <View>
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{label}</Text>
                    <Text style={styles.sectionHeaderCount}>{files.length}</Text>
                </View>
                <View style={styles.cardGroup}>
                    {files.map((file, index) => {
                        const isLast = index === files.length - 1;
                        const isFirst = index === 0;
                        const isSingle = files.length === 1;
                        const isDeleted = file.status === 'deleted';
                        const isSelected = selectedPath === file.fullPath;

                        return (
                            <Pressable
                                key={`${file.fullPath}-${index}`}
                                onPress={() => handleFilePress(file)}
                                disabled={isDeleted}
                                style={({ pressed }) => [
                                    styles.fileItem,
                                    isSingle && styles.fileItemSingle,
                                    !isSingle && isFirst && styles.fileItemFirst,
                                    !isSingle && isLast && styles.fileItemLast,
                                    pressed && !isDeleted && styles.fileItemPressed,
                                    isSelected && !isDeleted && styles.fileItemSelected,
                                    isDeleted && styles.fileItemDeleted,
                                ]}
                            >
                                <FileIcon fileName={file.fileName} size={18} />
                                <View style={styles.fileInfo}>
                                    <Text
                                        style={[
                                            styles.fileName,
                                            isDeleted && styles.fileNameDeleted,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {file.fileName}
                                    </Text>
                                </View>
                                <FileStatusBadge status={file.status} linesAdded={file.linesAdded} linesRemoved={file.linesRemoved} />
                            </Pressable>
                        );
                    })}
                </View>
            </View>
        );
    };

    const stagedFiles = gitStatusFiles?.stagedFiles ?? [];
    const unstagedFiles = gitStatusFiles?.unstagedFiles ?? [];
    const hasFiles = stagedFiles.length > 0 || unstagedFiles.length > 0;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{t('files.changes')}</Text>
                {hasFiles && (
                    <Text style={styles.headerCount}>{stagedFiles.length + unstagedFiles.length}</Text>
                )}
            </View>
            <ScrollView style={styles.list} showsVerticalScrollIndicator={false} contentContainerStyle={styles.listContent}>
                {!hasFiles ? (
                    <View style={styles.emptyState}>
                        <Octicons name="check-circle" size={24} style={styles.emptyIcon} />
                        <Text style={styles.emptyText}>{t('files.noChanges')}</Text>
                    </View>
                ) : (
                    <>
                        {renderFileGroup(stagedFiles, t('files.stagedChanges', { count: stagedFiles.length }))}
                        {renderFileGroup(unstagedFiles, t('files.unstagedChanges', { count: unstagedFiles.length }))}
                    </>
                )}
            </ScrollView>
        </View>
    );
});

const FileStatusBadge = React.memo<{ status: GitFileStatus['status']; linesAdded: number; linesRemoved: number }>(({ status, linesAdded, linesRemoved }) => {
    let letter: string;
    let colorStyle: typeof styles.badgeM;

    switch (status) {
        case 'modified':
            letter = 'M';
            colorStyle = styles.badgeM;
            break;
        case 'added':
            letter = 'A';
            colorStyle = styles.badgeA;
            break;
        case 'deleted':
            letter = 'D';
            colorStyle = styles.badgeD;
            break;
        case 'renamed':
            letter = 'R';
            colorStyle = styles.badgeR;
            break;
        case 'untracked':
            letter = 'U';
            colorStyle = styles.badgeU;
            break;
        default:
            return null;
    }

    return (
        <View style={styles.badgeRow}>
            {(linesAdded > 0 || linesRemoved > 0) && (
                <Text style={styles.lineStats}>
                    {linesAdded > 0 && <Text style={styles.linesAdded}>+{linesAdded}</Text>}
                    {linesAdded > 0 && linesRemoved > 0 && ' '}
                    {linesRemoved > 0 && <Text style={styles.linesRemoved}>-{linesRemoved}</Text>}
                </Text>
            )}
            <Text style={[styles.badge, colorStyle]}>{letter}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 14,
        paddingBottom: 8,
    },
    headerTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerCount: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    list: {
        flex: 1,
    },
    listContent: {
        paddingBottom: 16,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 6,
    },
    sectionHeaderText: {
        fontSize: 12,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sectionHeaderCount: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    cardGroup: {
        marginHorizontal: 16,
        overflow: 'hidden',
    },
    fileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    fileItemFirst: {
        borderTopLeftRadius: 10,
        borderTopRightRadius: 10,
    },
    fileItemLast: {
        borderBottomLeftRadius: 10,
        borderBottomRightRadius: 10,
        borderBottomWidth: 0,
    },
    fileItemSingle: {
        borderRadius: 10,
        borderBottomWidth: 0,
    },
    fileItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    fileItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    fileItemDeleted: {
        opacity: 0.5,
    },
    fileInfo: {
        flex: 1,
        minWidth: 0,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    fileNameDeleted: {
        textDecorationLine: 'line-through',
        color: theme.colors.textSecondary,
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    lineStats: {
        fontSize: 11,
        ...Typography.mono(),
    },
    linesAdded: {
        color: '#34C759',
    },
    linesRemoved: {
        color: '#FF3B30',
    },
    badge: {
        fontSize: 12,
        fontWeight: '700',
        width: 18,
        textAlign: 'center',
        ...Typography.mono(),
    },
    badgeM: {
        color: '#FF9500',
    },
    badgeA: {
        color: '#34C759',
    },
    badgeD: {
        color: '#FF3B30',
    },
    badgeR: {
        color: '#007AFF',
    },
    badgeU: {
        color: theme.colors.textSecondary,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        paddingTop: 40,
        gap: 8,
    },
    emptyIcon: {
        color: theme.colors.textSecondary,
    },
    emptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
