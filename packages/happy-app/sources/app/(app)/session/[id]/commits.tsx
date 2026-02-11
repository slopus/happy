import * as React from 'react';
import { View, ActivityIndicator, FlatList, Platform } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
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

    const [commits, setCommits] = React.useState<CommitInfo[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);
    const [isLoadingMore, setIsLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const loadCommits = React.useCallback(async (offset: number, append: boolean) => {
        if (!append) setIsLoading(true);
        else setIsLoadingMore(true);
        setError(null);

        try {
            const fileArg = fileFilter ? ` -- "${fileFilter}"` : '';
            const response = await sessionBash(sessionId, {
                command: `git log --format="%H%n%h%n%an%n%ae%n%at%n%s%n---END---" -${PAGE_SIZE} --skip=${offset}${fileArg}`,
                cwd: sessionPath,
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
    }, [sessionId, sessionPath, fileFilter]);

    React.useEffect(() => {
        loadCommits(0, false);
    }, [loadCommits]);

    const handleLoadMore = React.useCallback(() => {
        if (!isLoadingMore && hasMore) {
            loadCommits(commits.length, true);
        }
    }, [isLoadingMore, hasMore, commits.length, loadCommits]);

    const handleCommitPress = React.useCallback((commit: CommitInfo) => {
        router.push(`/session/${sessionId}/commit?hash=${commit.hash}`);
    }, [router, sessionId]);

    const renderCommit = React.useCallback(({ item, index }: { item: CommitInfo; index: number }) => (
        <View
            key={item.hash}
            style={{
                borderBottomWidth: index < commits.length - 1 ? Platform.select({ ios: 0.33, default: 1 }) : 0,
                borderBottomColor: theme.colors.divider,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                }}
                // Use Pressable wrapper for press handling
            >
                <View style={{ flex: 1, marginRight: 8 }}
                    onTouchEnd={() => handleCommitPress(item)}
                    accessible={true}
                    accessibilityRole="button"
                >
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
            </View>
        </View>
    ), [commits.length, theme, handleCommitPress]);

    if (isLoading) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (error) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
                <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                    {error}
                </Text>
            </View>
        );
    }

    if (commits.length === 0) {
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
            {fileFilter && (
                <Stack.Screen
                    options={{
                        headerTitle: fileFilter.split('/').pop() || t('commits.title'),
                    }}
                />
            )}
            <FlatList
                data={commits}
                renderItem={renderCommit}
                keyExtractor={item => item.hash}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.3}
                ListFooterComponent={
                    isLoadingMore ? (
                        <View style={{ paddingVertical: 20 }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </View>
                    ) : null
                }
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
