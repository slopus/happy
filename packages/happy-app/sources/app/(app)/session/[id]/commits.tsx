import * as React from 'react';
import { View, ActivityIndicator, FlatList, Platform, Pressable } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { getWorkspaceRepos } from '@/utils/workspaceRepos';
import { RepoSelector } from '@/components/RepoSelector';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import { ActionMenuItem } from '@/components/ActionMenu';
import { t } from '@/text';

const PAGE_SIZE = 30;

interface CommitInfo {
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    date: Date;
    title: string;
}

function parseGitLog(stdout: string): CommitInfo[] {
    return stdout.split('---END---')
        .filter(block => block.trim())
        .map(block => {
            const lines = block.trim().split('\n');
            return {
                hash: lines[0] || '',
                shortHash: lines[1] || '',
                author: lines[2] || '',
                email: lines[3] || '',
                date: new Date(parseInt(lines[4] || '0') * 1000),
                title: lines[5] || '',
            };
        })
        .filter(c => c.hash);
}

function formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diffSeconds = Math.floor((now - date.getTime()) / 1000);

    if (diffSeconds < 60) return 'just now';
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears}y ago`;
}

export default function CommitsScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const searchParams = useLocalSearchParams();
    const fileFilter = searchParams.file as string | undefined;
    const { theme } = useUnistyles();

    const session = storage.getState().sessions[sessionId];
    const sessionPath = session?.metadata?.path || '';

    // Multi-repo workspace support
    const workspaceRepos = getWorkspaceRepos(session?.metadata);
    const [selectedRepoIndex, setSelectedRepoIndex] = React.useState(0);
    const selectedRepo = workspaceRepos[selectedRepoIndex];
    const repoBaseCwd = selectedRepo?.path || sessionPath;

    const [commits, setCommits] = React.useState<CommitInfo[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);
    const [isLoadingMore, setIsLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    // Diff stats for headerRight badge
    const [diffStats, setDiffStats] = React.useState<{ insertions: number; deletions: number } | null>(null);

    // Branch selector state
    const [localBranches, setLocalBranches] = React.useState<string[]>([]);
    const [remoteBranches, setRemoteBranches] = React.useState<string[]>([]);
    const [currentBranch, setCurrentBranch] = React.useState<string>('');
    const [selectedBranch, setSelectedBranch] = React.useState<string>('');
    const [branchMenuVisible, setBranchMenuVisible] = React.useState(false);

    // Worktree branch→path mapping
    const [worktreeMap, setWorktreeMap] = React.useState<Record<string, string>>({});

    // Load branches and worktree list on mount (re-runs when selected repo changes)
    React.useEffect(() => {
        (async () => {
            try {
                const [localResult, remoteResult, currentResult, worktreeResult] = await Promise.all([
                    sessionBash(sessionId, {
                        command: "git branch --list --format='%(refname:short)'",
                        cwd: repoBaseCwd,
                        timeout: 10000,
                    }),
                    sessionBash(sessionId, {
                        command: "git branch -r --format='%(refname:short)'",
                        cwd: repoBaseCwd,
                        timeout: 10000,
                    }),
                    sessionBash(sessionId, {
                        command: 'git branch --show-current',
                        cwd: repoBaseCwd,
                        timeout: 5000,
                    }),
                    sessionBash(sessionId, {
                        command: 'git worktree list --porcelain',
                        cwd: repoBaseCwd,
                        timeout: 10000,
                    }),
                ]);
                if (localResult.success && localResult.stdout) {
                    setLocalBranches(localResult.stdout.trim().split('\n').filter(Boolean));
                }
                if (remoteResult.success && remoteResult.stdout) {
                    // Filter out HEAD pointers like "origin/HEAD"
                    setRemoteBranches(remoteResult.stdout.trim().split('\n').filter(b => b && !b.includes('/HEAD')));
                }
                if (currentResult.success && currentResult.stdout) {
                    setCurrentBranch(currentResult.stdout.trim());
                }
                // Parse worktree list: each entry has "worktree <path>\nHEAD ...\nbranch refs/heads/<name>\n"
                if (worktreeResult.success && worktreeResult.stdout) {
                    const map: Record<string, string> = {};
                    const entries = worktreeResult.stdout.split('\n\n');
                    for (const entry of entries) {
                        const lines = entry.trim().split('\n');
                        let path = '';
                        let branch = '';
                        for (const line of lines) {
                            if (line.startsWith('worktree ')) {
                                path = line.substring('worktree '.length);
                            } else if (line.startsWith('branch refs/heads/')) {
                                branch = line.substring('branch refs/heads/'.length);
                            }
                        }
                        if (path && branch) {
                            map[branch] = path;
                        }
                    }
                    setWorktreeMap(map);
                }
            } catch { /* ignore */ }
        })();
    }, [sessionId, repoBaseCwd]);

    // Resolve the working directory for the active branch
    // selectedBranch='' means current branch (use repoBaseCwd)
    // Otherwise check if this branch has a worktree
    const activeCwd = React.useMemo(() => {
        if (!selectedBranch) return repoBaseCwd; // current branch = repo's own path
        return worktreeMap[selectedBranch] || null; // null = no worktree for this branch
    }, [selectedBranch, worktreeMap, repoBaseCwd]);

    // Load diff stats when active branch/worktree changes
    React.useEffect(() => {
        setDiffStats(null);
        if (!activeCwd) return;
        let cancelled = false;
        (async () => {
            try {
                const result = await sessionBash(sessionId, {
                    command: "git diff HEAD --shortstat",
                    cwd: activeCwd,
                    timeout: 10000,
                });
                if (cancelled) return;
                if (result.success && result.stdout) {
                    const ins = result.stdout.match(/(\d+) insertion/);
                    const del = result.stdout.match(/(\d+) deletion/);
                    const insertions = ins ? parseInt(ins[1], 10) : 0;
                    const deletions = del ? parseInt(del[1], 10) : 0;
                    if (insertions > 0 || deletions > 0) {
                        setDiffStats({ insertions, deletions });
                    }
                }
            } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
    }, [sessionId, activeCwd]);

    const handleRepoSelect = React.useCallback((index: number) => {
        if (index === selectedRepoIndex) return;
        setSelectedRepoIndex(index);
        // Reset branch state when switching repos since branches differ per repo
        setSelectedBranch('');
        setCurrentBranch('');
        setLocalBranches([]);
        setRemoteBranches([]);
        setWorktreeMap({});
        setHasMore(true);
    }, [selectedRepoIndex]);

    const handleBranchSelect = React.useCallback((branch: string) => {
        setSelectedBranch(branch === currentBranch ? '' : branch);
        setHasMore(true);
    }, [currentBranch]);

    const loadCommits = React.useCallback(async (offset: number, append: boolean) => {
        if (!activeCwd) return;
        if (!append) setIsLoading(true);
        else setIsLoadingMore(true);
        setError(null);

        try {
            const branchArg = selectedBranch ? `"${selectedBranch}" ` : '';
            const fileArg = fileFilter ? ` -- "${fileFilter}"` : '';
            const response = await sessionBash(sessionId, {
                command: `git log ${branchArg}--format="%H%n%h%n%an%n%ae%n%at%n%s%n---END---" -${PAGE_SIZE} --skip=${offset}${fileArg}`,
                cwd: activeCwd,
                timeout: 10000,
            });

            if (response.success && response.stdout) {
                const parsed = parseGitLog(response.stdout);
                if (append) {
                    setCommits(prev => [...prev, ...parsed]);
                } else {
                    setCommits(parsed);
                }
                setHasMore(parsed.length === PAGE_SIZE);
            } else {
                if (!append) setError(response.error || t('commits.failedToLoad'));
                setHasMore(false);
            }
        } catch {
            if (!append) setError(t('commits.failedToLoad'));
            setHasMore(false);
        } finally {
            setIsLoading(false);
            setIsLoadingMore(false);
        }
    }, [sessionId, activeCwd, fileFilter, selectedBranch]);

    React.useEffect(() => {
        loadCommits(0, false);
    }, [loadCommits]);

    const handleLoadMore = React.useCallback(() => {
        if (!isLoadingMore && hasMore) {
            loadCommits(commits.length, true);
        }
    }, [isLoadingMore, hasMore, commits.length, loadCommits]);

    const handleCommitPress = React.useCallback((commit: CommitInfo) => {
        const cwdParam = activeCwd && activeCwd !== sessionPath
            ? `&cwd=${encodeURIComponent(activeCwd)}`
            : '';
        router.push(`/session/${sessionId}/commit?hash=${commit.hash}${cwdParam}`);
    }, [router, sessionId, activeCwd, sessionPath]);

    const renderCommit = React.useCallback(({ item, index }: { item: CommitInfo; index: number }) => (
        <Pressable
            key={item.hash}
            onPress={() => handleCommitPress(item)}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderBottomWidth: index < commits.length - 1 ? Platform.select({ ios: 0.33, default: 1 }) : 0,
                borderBottomColor: theme.colors.divider,
            }}
        >
            <View style={{ flex: 1, marginRight: 8 }}>
                <Text
                    style={{
                        fontSize: 15,
                        color: theme.colors.text,
                        fontWeight: '500',
                        marginBottom: 4,
                        ...Typography.default('semiBold'),
                    }}
                    numberOfLines={2}
                >
                    {item.title}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.textSecondary,
                        ...Typography.mono(),
                    }}>
                        {item.shortHash}
                    </Text>
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.textSecondary,
                        marginHorizontal: 6,
                        ...Typography.default(),
                    }}>
                        ·
                    </Text>
                    <Text
                        style={{
                            fontSize: 13,
                            color: theme.colors.textSecondary,
                            flex: 1,
                            ...Typography.default(),
                        }}
                        numberOfLines={1}
                    >
                        {item.author} · {formatRelativeTime(item.date)}
                    </Text>
                </View>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.groupped?.chevron || theme.colors.textSecondary} />
        </Pressable>
    ), [commits.length, theme, handleCommitPress]);

    if (isLoading && commits.length === 0) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (error && commits.length === 0) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
                <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                    {error}
                </Text>
            </View>
        );
    }

    if (!isLoading && commits.length === 0) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
                <Ionicons name="git-commit-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                    {t('commits.noCommits')}
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <Stack.Screen
                options={{
                    ...(fileFilter ? { headerTitle: fileFilter.split('/').pop() || t('commits.title') } : {}),
                    headerRight: () => (
                        <Pressable
                            onPress={() => router.push(activeCwd && activeCwd !== sessionPath
                                ? `/session/${sessionId}/status?cwd=${encodeURIComponent(activeCwd)}`
                                : `/session/${sessionId}/status`
                            )}
                            style={diffStats
                                ? { flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 0, paddingVertical: 4, gap: 6 }
                                : { paddingHorizontal: 8, paddingVertical: 4 }
                            }
                        >
                            <Ionicons name="git-compare-outline" size={22} color={theme.colors.header.tint} />
                            {diffStats ? (
                                <View style={{ flexDirection: 'row', gap: 2 }}>
                                    <Text style={{ fontSize: 11, color: '#34C759', fontWeight: '700', ...Typography.mono() }}>
                                        +{diffStats.insertions}
                                    </Text>
                                    <Text style={{ fontSize: 11, color: '#FF3B30', fontWeight: '700', ...Typography.mono() }}>
                                        -{diffStats.deletions}
                                    </Text>
                                </View>
                            ) : null}
                        </Pressable>
                    ),
                }}
            />
            <FlatList
                data={commits}
                renderItem={renderCommit}
                keyExtractor={item => item.hash}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.3}
                ListHeaderComponent={!fileFilter ? (
                    <View>
                        {workspaceRepos.length > 1 && (
                            <View style={{
                                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                borderBottomColor: theme.colors.divider,
                            }}>
                                <RepoSelector
                                    repos={workspaceRepos}
                                    selectedIndex={selectedRepoIndex}
                                    onSelect={handleRepoSelect}
                                />
                            </View>
                        )}
                        {(localBranches.length > 1 || remoteBranches.length > 0) ? (
                            <Pressable
                                onPress={() => setBranchMenuVisible(true)}
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    paddingHorizontal: 16,
                                    paddingVertical: 10,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: theme.colors.divider,
                                    backgroundColor: theme.colors.surfaceHigh,
                                }}
                            >
                                <Octicons name="git-branch" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                                <Text style={{
                                    fontSize: 15,
                                    color: theme.colors.text,
                                    flex: 1,
                                    ...Typography.default('semiBold'),
                                }}>
                                    {selectedBranch || currentBranch || 'HEAD'}
                                </Text>
                                <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                            </Pressable>
                        ) : null}
                    </View>
                ) : null}
                ListFooterComponent={
                    isLoadingMore ? (
                        <View style={{ paddingVertical: 20 }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </View>
                    ) : null
                }
            />
            {isLoading && commits.length > 0 ? (
                <View style={{
                    position: 'absolute',
                    top: 0, left: 0, right: 0, bottom: 0,
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: theme.colors.surface + '80',
                }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : null}
            <ActionMenuModal
                visible={branchMenuVisible}
                title={t('commits.selectBranch')}
                items={(() => {
                    const activeBranch = selectedBranch || currentBranch;
                    const localSet = new Set(localBranches);
                    // Local branches first
                    const items: ActionMenuItem[] = localBranches.map(branch => ({
                        label: branch,
                        selected: branch === activeBranch,
                        onPress: () => handleBranchSelect(branch),
                    }));
                    // Remote-only branches (filter out those that have a local counterpart)
                    for (const remote of remoteBranches) {
                        // remote is like "origin/xxx" — extract the part after first "/"
                        const shortName = remote.includes('/') ? remote.substring(remote.indexOf('/') + 1) : remote;
                        if (!localSet.has(shortName)) {
                            items.push({
                                label: remote,
                                selected: remote === activeBranch,
                                onPress: () => handleBranchSelect(remote),
                                secondary: true,
                            });
                        }
                    }
                    return items;
                })()}
                onClose={() => setBranchMenuVisible(false)}
            />
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
