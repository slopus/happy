import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { getGitStatusFiles, GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import { ActionMenuItem } from '@/components/ActionMenu';
import { t } from '@/text';
import { shellEscape } from '@/utils/shellEscape';

export default function StatusScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const searchParams = useLocalSearchParams();
    const cwdParam = searchParams.cwd as string | undefined;
    const { theme } = useUnistyles();

    const session = storage.getState().sessions[sessionId];
    const defaultSessionPath = session?.metadata?.path || '';
    const targetRepoPath = cwdParam || defaultSessionPath;
    const useGitPathOverride = Boolean(cwdParam && defaultSessionPath && cwdParam !== defaultSessionPath);
    const commandCwd = useGitPathOverride ? defaultSessionPath : targetRepoPath;
    const gitPrefix = React.useMemo(() => (
        useGitPathOverride
            ? `git -C ${shellEscape(targetRepoPath)}`
            : 'git'
    ), [useGitPathOverride, targetRepoPath]);
    const gitCommand = React.useCallback((args: string) => `${gitPrefix} ${args}`, [gitPrefix]);

    const [gitStatus, setGitStatus] = React.useState<GitStatusFiles | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [isOperating, setIsOperating] = React.useState(false);

    const loadStatus = React.useCallback(async (silent?: boolean) => {
        if (!silent) setIsLoading(true);
        try {
            const result = await getGitStatusFiles(sessionId, cwdParam);
            setGitStatus(result);
        } catch {
            setGitStatus(null);
        } finally {
            if (!silent) setIsLoading(false);
        }
    }, [sessionId, cwdParam]);

    React.useEffect(() => {
        loadStatus();
    }, [loadStatus]);

    useFocusEffect(
        React.useCallback(() => {
            if (gitStatus) {
                loadStatus(true);
            }
        }, [gitStatus, loadStatus])
    );

    // Stage a file
    const handleStageFile = React.useCallback(async (file: GitFileStatus) => {
        setIsOperating(true);
        try {
            await sessionBash(sessionId, {
                command: gitCommand(`add -- ${shellEscape(file.fullPath)}`),
                cwd: commandCwd,
                timeout: 10000,
            });
            await loadStatus(true);
        } catch {
            Modal.alert(t('common.error'), t('status.operationFailed'));
        } finally {
            setIsOperating(false);
        }
    }, [sessionId, gitCommand, commandCwd, loadStatus]);

    // Unstage a file
    const handleUnstageFile = React.useCallback(async (file: GitFileStatus) => {
        setIsOperating(true);
        try {
            await sessionBash(sessionId, {
                command: gitCommand(`reset HEAD -- ${shellEscape(file.fullPath)}`),
                cwd: commandCwd,
                timeout: 10000,
            });
            await loadStatus(true);
        } catch {
            Modal.alert(t('common.error'), t('status.operationFailed'));
        } finally {
            setIsOperating(false);
        }
    }, [sessionId, gitCommand, commandCwd, loadStatus]);

    // Stage all files
    const handleStageAll = React.useCallback(async () => {
        setIsOperating(true);
        try {
            await sessionBash(sessionId, {
                command: gitCommand('add -A'),
                cwd: commandCwd,
                timeout: 10000,
            });
            await loadStatus(true);
        } catch {
            Modal.alert(t('common.error'), t('status.operationFailed'));
        } finally {
            setIsOperating(false);
        }
    }, [sessionId, gitCommand, commandCwd, loadStatus]);

    // Unstage all files
    const handleUnstageAll = React.useCallback(async () => {
        setIsOperating(true);
        try {
            await sessionBash(sessionId, {
                command: gitCommand('reset HEAD'),
                cwd: commandCwd,
                timeout: 10000,
            });
            await loadStatus(true);
        } catch {
            Modal.alert(t('common.error'), t('status.operationFailed'));
        } finally {
            setIsOperating(false);
        }
    }, [sessionId, gitCommand, commandCwd, loadStatus]);

    // Commit staged changes
    const handleCommit = React.useCallback(async () => {
        const message = await Modal.prompt(
            t('status.commitTitle'),
            t('status.commitMessage'),
            { placeholder: t('status.commitPlaceholder') },
        );
        if (!message) return;

        setIsOperating(true);
        try {
            const result = await sessionBash(sessionId, {
                command: gitCommand(`commit -m ${shellEscape(message)}`),
                cwd: commandCwd,
                timeout: 30000,
            });
            if (result.success && result.exitCode === 0) {
                Modal.alert(t('common.success'), t('status.commitSuccess'));
                await loadStatus(true);
            } else {
                Modal.alert(t('common.error'), result.stderr || t('status.commitFailed'));
            }
        } catch {
            Modal.alert(t('common.error'), t('status.commitFailed'));
        } finally {
            setIsOperating(false);
        }
    }, [sessionId, gitCommand, commandCwd, loadStatus]);

    // Discard changes for a file
    const handleDiscardFile = React.useCallback(async (file: GitFileStatus) => {
        const confirmed = await Modal.confirm(
            t('status.discardTitle'),
            t('status.discardMessage', { fileName: file.fileName }),
            { destructive: true },
        );
        if (!confirmed) return;

        setIsOperating(true);
        try {
            const escapedPath = shellEscape(file.fullPath);
            if (file.status === 'untracked') {
                await sessionBash(sessionId, {
                    command: gitCommand(`clean -f -- ${escapedPath}`),
                    cwd: commandCwd,
                    timeout: 10000,
                });
            } else if (file.isStaged) {
                // Staged file: reset from index first, then restore working tree
                await sessionBash(sessionId, {
                    command: `${gitCommand(`reset HEAD -- ${escapedPath}`)} && ${gitCommand(`checkout -- ${escapedPath}`)}`,
                    cwd: commandCwd,
                    timeout: 10000,
                });
            } else {
                await sessionBash(sessionId, {
                    command: gitCommand(`checkout -- ${escapedPath}`),
                    cwd: commandCwd,
                    timeout: 10000,
                });
            }
            await loadStatus(true);
        } catch {
            Modal.alert(t('common.error'), t('status.operationFailed'));
        } finally {
            setIsOperating(false);
        }
    }, [sessionId, gitCommand, commandCwd, loadStatus]);

    // Navigate to file diff viewer
    const handleFilePress = React.useCallback((file: GitFileStatus, staged?: boolean) => {
        const encodedPath = btoa(
            new TextEncoder().encode(file.fullPath).reduce((s, b) => s + String.fromCharCode(b), '')
        );
        const stagedParam = staged ? '&staged=1' : '';
        router.push(`/session/${sessionId}/file?path=${encodeURIComponent(encodedPath)}${stagedParam}`);
    }, [router, sessionId]);

    // Long press menu
    const [menuVisible, setMenuVisible] = React.useState(false);
    const [menuItems, setMenuItems] = React.useState<ActionMenuItem[]>([]);

    const handleLongPress = React.useCallback((file: GitFileStatus, staged: boolean) => {
        const items: ActionMenuItem[] = [];
        if (staged) {
            items.push({
                label: t('status.unstage'),
                onPress: () => handleUnstageFile(file),
            });
        } else {
            items.push({
                label: t('status.stage'),
                onPress: () => handleStageFile(file),
            });
        }
        items.push({
            label: t('status.discard'),
            onPress: () => handleDiscardFile(file),
            destructive: true,
        });
        setMenuItems(items);
        setMenuVisible(true);
    }, [handleStageFile, handleUnstageFile, handleDiscardFile]);

    const isWeb = Platform.OS === 'web';

    const renderStatusIcon = React.useCallback((file: GitFileStatus) => {
        let statusColor: string;
        let statusIcon: string;

        switch (file.status) {
            case 'modified':
                statusColor = '#FF9500';
                statusIcon = 'diff-modified';
                break;
            case 'added':
                statusColor = '#34C759';
                statusIcon = 'diff-added';
                break;
            case 'deleted':
                statusColor = '#FF3B30';
                statusIcon = 'diff-removed';
                break;
            case 'renamed':
                statusColor = '#007AFF';
                statusIcon = 'arrow-right';
                break;
            case 'untracked':
                statusColor = theme.dark ? '#b0b0b0' : '#8E8E93';
                statusIcon = 'file';
                break;
            default:
                return null;
        }

        return <Octicons name={statusIcon as any} size={16} color={statusColor} />;
    }, [theme.dark]);

    const renderFileSubtitle = React.useCallback((file: GitFileStatus) => {
        return file.filePath || t('files.projectRoot');
    }, []);

    const renderRightElement = React.useCallback((file: GitFileStatus, staged: boolean) => {
        const statusIcon = renderStatusIcon(file);
        const hasAdded = file.linesAdded > 0;
        const hasRemoved = file.linesRemoved > 0;
        const hasChanges = hasAdded || hasRemoved;

        const lineChangesEl = hasChanges ? (
            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                {hasAdded && <Text style={{ color: '#34C759' }}>+{file.linesAdded}</Text>}
                {hasAdded && hasRemoved && ' '}
                {hasRemoved && <Text style={{ color: '#FF3B30' }}>-{file.linesRemoved}</Text>}
            </Text>
        ) : null;

        if (!isWeb) {
            return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {lineChangesEl}
                    {statusIcon}
                </View>
            );
        }
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {lineChangesEl}
                {statusIcon}
                <Pressable
                    onPress={() => handleLongPress(file, staged)}
                    hitSlop={8}
                    style={{ padding: 4 }}
                >
                    <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
        );
    }, [isWeb, renderStatusIcon, handleLongPress, theme.colors.textSecondary]);

    const hasStagedFiles = (gitStatus?.totalStaged ?? 0) > 0;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <Pressable
                            onPress={handleCommit}
                            disabled={!hasStagedFiles || isOperating}
                            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                        >
                            <Text style={{
                                fontSize: 17,
                                color: hasStagedFiles && !isOperating ? theme.colors.header.tint : theme.colors.textSecondary,
                                ...Typography.default('semiBold'),
                            }}>
                                {t('status.commit')}
                            </Text>
                        </Pressable>
                    ),
                }}
            />

            <ItemList style={{ flex: 1 }}>
                {isLoading ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !gitStatus ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 }}>
                        <Octicons name="git-branch" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                            {t('files.notRepo')}
                        </Text>
                    </View>
                ) : gitStatus.totalStaged === 0 && gitStatus.totalUnstaged === 0 ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 }}>
                        <Ionicons name="checkmark-circle-outline" size={48} color={theme.colors.success} />
                        <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                            {t('status.noChanges')}
                        </Text>
                    </View>
                ) : (
                    <>
                        {/* Staged Changes Section */}
                        {gitStatus.stagedFiles.length > 0 && (
                            <>
                                <Pressable
                                    onPress={handleUnstageAll}
                                    disabled={isOperating}
                                    style={{
                                        backgroundColor: theme.colors.surfaceHigh,
                                        paddingHorizontal: 16,
                                        paddingVertical: 12,
                                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                        borderBottomColor: theme.colors.divider,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: theme.colors.success,
                                        ...Typography.default(),
                                    }}>
                                        {t('files.stagedChanges', { count: gitStatus.stagedFiles.length })}
                                    </Text>
                                    <Text style={{
                                        fontSize: 13,
                                        color: theme.colors.header.tint,
                                        ...Typography.default(),
                                    }}>
                                        {t('status.unstageAll')}
                                    </Text>
                                </Pressable>
                                {gitStatus.stagedFiles.map((file, index) => (
                                    <Item
                                        key={`staged-${file.fullPath}-${index}`}
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={<FileIcon fileName={file.fileName} size={32} />}
                                        rightElement={renderRightElement(file, true)}
                                        onPress={() => handleFilePress(file, true)}
                                        onLongPress={() => handleLongPress(file, true)}
                                        showChevron={true}
                                        showDivider={index < gitStatus.stagedFiles.length - 1 || gitStatus.unstagedFiles.length > 0}
                                    />
                                ))}
                            </>
                        )}

                        {/* Unstaged Changes Section */}
                        {gitStatus.unstagedFiles.length > 0 && (
                            <>
                                <Pressable
                                    onPress={handleStageAll}
                                    disabled={isOperating}
                                    style={{
                                        backgroundColor: theme.colors.surfaceHigh,
                                        paddingHorizontal: 16,
                                        paddingVertical: 12,
                                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                        borderBottomColor: theme.colors.divider,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                    }}
                                >
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: theme.colors.warning,
                                        ...Typography.default(),
                                    }}>
                                        {t('files.unstagedChanges', { count: gitStatus.unstagedFiles.length })}
                                    </Text>
                                    <Text style={{
                                        fontSize: 13,
                                        color: theme.colors.header.tint,
                                        ...Typography.default(),
                                    }}>
                                        {t('status.stageAll')}
                                    </Text>
                                </Pressable>
                                {gitStatus.unstagedFiles.map((file, index) => (
                                    <Item
                                        key={`unstaged-${file.fullPath}-${index}`}
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={<FileIcon fileName={file.fileName} size={32} />}
                                        rightElement={renderRightElement(file, false)}
                                        onPress={() => handleFilePress(file)}
                                        onLongPress={() => handleLongPress(file, false)}
                                        showChevron={true}
                                        showDivider={index < gitStatus.unstagedFiles.length - 1}
                                    />
                                ))}
                            </>
                        )}
                    </>
                )}
            </ItemList>
            <ActionMenuModal visible={menuVisible} items={menuItems} onClose={() => setMenuVisible(false)} />
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
        width: '100%',
    },
}));
