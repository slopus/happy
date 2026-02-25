import * as React from 'react';
import { View, ActivityIndicator, Pressable } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import * as Clipboard from 'expo-clipboard';
import { t } from '@/text';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';

interface CommitDetail {
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    date: Date;
    title: string;
    body: string;
}

interface CommitFile {
    fileName: string;
    filePath: string;
    additions: number;
    deletions: number;
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

function parseCommitDetail(stdout: string): CommitDetail | null {
    const lines = stdout.trim().split('\n');
    if (lines.length < 6) return null;
    return {
        hash: lines[0] || '',
        shortHash: lines[1] || '',
        author: lines[2] || '',
        email: lines[3] || '',
        date: new Date(parseInt(lines[4] || '0') * 1000),
        title: lines[5] || '',
        body: lines.slice(6).join('\n').trim(),
    };
}

function parseDiffTree(stdout: string): CommitFile[] {
    return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [add, del, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t'); // handle filenames with tabs (unlikely but safe)
        return {
            fileName: filePath.split('/').pop() || filePath,
            filePath,
            additions: add === '-' ? 0 : parseInt(add || '0'),
            deletions: del === '-' ? 0 : parseInt(del || '0'),
        };
    });
}

export default function CommitScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const searchParams = useLocalSearchParams();
    const hash = searchParams.hash as string;
    const { theme } = useUnistyles();

    const session = storage.getState().sessions[sessionId];
    const sessionPath = session?.metadata?.path || '';

    const [commitDetail, setCommitDetail] = React.useState<CommitDetail | null>(null);
    const [files, setFiles] = React.useState<CommitFile[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;

        const load = async () => {
            setIsLoading(true);
            setError(null);
            try {
                // Fetch commit info and changed files in parallel
                const [infoRes, filesRes] = await Promise.all([
                    sessionBash(sessionId, {
                        command: `git show --format="%H%n%h%n%an%n%ae%n%at%n%s%n%b" --no-patch ${hash}`,
                        cwd: sessionPath,
                        timeout: 10000,
                    }),
                    sessionBash(sessionId, {
                        command: `git diff-tree --no-commit-id -r --numstat ${hash}`,
                        cwd: sessionPath,
                        timeout: 10000,
                    }),
                ]);

                if (cancelled) return;

                if (infoRes.success && infoRes.stdout) {
                    setCommitDetail(parseCommitDetail(infoRes.stdout));
                } else {
                    setError(infoRes.error || 'Failed to load commit');
                }

                if (filesRes.success && filesRes.stdout) {
                    setFiles(parseDiffTree(filesRes.stdout));
                }
            } catch {
                if (!cancelled) setError('Failed to load commit');
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [sessionId, sessionPath, hash]);

    const handleFilePress = React.useCallback((file: CommitFile) => {
        const fullPath = `${sessionPath}/${file.filePath}`;
        const encodedPath = btoa(
            new TextEncoder().encode(fullPath).reduce((s, b) => s + String.fromCharCode(b), '')
        );
        router.push(`/session/${sessionId}/file?path=${encodeURIComponent(encodedPath)}&ref=${hash}`);
    }, [router, sessionId, sessionPath, hash]);

    // Action menu
    const [menuVisible, setMenuVisible] = React.useState(false);
    const menuItems: ActionMenuItem[] = React.useMemo(() => {
        if (!commitDetail) return [];
        return [
            {
                label: t('commits.copyHash'),
                onPress: async () => {
                    await Clipboard.setStringAsync(commitDetail.hash);
                    hapticsLight(); showCopiedToast();
                },
            },
            {
                label: t('commits.copyMessage'),
                onPress: async () => {
                    const message = commitDetail.body
                        ? `${commitDetail.title}\n\n${commitDetail.body}`
                        : commitDetail.title;
                    await Clipboard.setStringAsync(message);
                    hapticsLight(); showCopiedToast();
                },
            },
        ];
    }, [commitDetail]);

    // Calculate totals
    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    if (isLoading) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }]}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (error || !commitDetail) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center', padding: 20 }]}>
                <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginTop: 16, ...Typography.default() }}>
                    {error || 'Failed to load commit'}
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.groupped?.background || theme.colors.surface }]}>
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <Pressable
                            onPress={() => setMenuVisible(true)}
                            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                        >
                            <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.header.tint} />
                        </Pressable>
                    ),
                }}
            />
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
            />
            <ItemList style={{ flex: 1 }}>
                {/* Commit message */}
                <ItemGroup>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                        <Text style={{
                            fontSize: 17,
                            fontWeight: '600',
                            color: theme.colors.text,
                            marginBottom: commitDetail.body ? 8 : 4,
                            ...Typography.default('semiBold'),
                        }}>
                            {commitDetail.title}
                        </Text>
                        {commitDetail.body ? (
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                marginBottom: 8,
                                lineHeight: 20,
                                ...Typography.default(),
                            }}>
                                {commitDetail.body}
                            </Text>
                        ) : null}
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.mono() }}>
                                {commitDetail.shortHash}
                            </Text>
                            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, marginHorizontal: 6, ...Typography.default() }}>
                                ·
                            </Text>
                            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                                {commitDetail.author} · {formatRelativeTime(commitDetail.date)}
                            </Text>
                        </View>
                    </View>
                </ItemGroup>

                {/* Stats summary */}
                <ItemGroup>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        <Text style={{ fontSize: 14, color: theme.colors.text, ...Typography.default() }}>
                            {t('commits.filesChanged', { count: files.length })}
                        </Text>
                        {totalAdditions > 0 && (
                            <Text style={{ fontSize: 14, color: '#34C759', ...Typography.default() }}>
                                +{totalAdditions}
                            </Text>
                        )}
                        {totalDeletions > 0 && (
                            <Text style={{ fontSize: 14, color: '#FF3B30', ...Typography.default() }}>
                                -{totalDeletions}
                            </Text>
                        )}
                    </View>
                </ItemGroup>

                {/* Changed files */}
                <ItemGroup>
                    {files.map((file, index) => {
                        return (
                            <Item
                                key={file.filePath}
                                title={file.fileName}
                                subtitle={file.filePath}
                                icon={<FileIcon fileName={file.fileName} size={29} />}
                                rightElement={
                                    <View style={{ flexDirection: 'row', gap: 4 }}>
                                        {file.additions > 0 && (
                                            <Text style={{ fontSize: 13, color: '#34C759', ...Typography.mono() }}>
                                                +{file.additions}
                                            </Text>
                                        )}
                                        {file.deletions > 0 && (
                                            <Text style={{ fontSize: 13, color: '#FF3B30', ...Typography.mono() }}>
                                                -{file.deletions}
                                            </Text>
                                        )}
                                    </View>
                                }
                                onPress={() => handleFilePress(file)}
                                showDivider={index < files.length - 1}
                            />
                        );
                    })}
                </ItemGroup>
            </ItemList>
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
