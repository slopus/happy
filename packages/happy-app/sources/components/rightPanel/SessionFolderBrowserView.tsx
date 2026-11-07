import { encodeFilePath } from '@/utils/filePathEncoding';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { FileIcon } from '@/components/FileIcon';
import { sessionListDirectory } from '@/sync/ops';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { t } from '@/text';
import { hapticsLight } from '../haptics';
import { useRightSwipePanel } from '../RightSwipePanelHost';
import { canGoUp, getParentPath, joinChild, resolveBack } from './folderBrowserNav';

type Entry = { name: string; type: 'file' | 'directory' | 'other'; size?: number; modified?: number };

// 逐层懒加载的目录浏览器：HOME 内可上爬到 HOME，外部工作目录封顶于自身。
// 视觉上对齐能力中心的 CapabilityHubDetailView（同款 header + rowCard 行）。
export const SessionFolderBrowserView = React.memo(function SessionFolderBrowserView(props: {
    sessionId: string;
    rootPath: string;
    homeDir: string;
    onExit: () => void;
}) {
    const { sessionId, rootPath, homeDir, onExit } = props;
    const { theme } = useUnistyles();
    const router = useRouter();
    const panel = useRightSwipePanel();
    const [currentPath, setCurrentPath] = React.useState(rootPath);
    const [entries, setEntries] = React.useState<Entry[]>([]);
    const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
    const [reloadTick, setReloadTick] = React.useState(0);

    // 路径变化（或手动重试）时拉取当前目录列表。
    React.useEffect(() => {
        let cancelled = false;
        setStatus('loading');
        (async () => {
            const res = await sessionListDirectory(sessionId, currentPath);
            if (cancelled) return;
            if (res.success && Array.isArray(res.entries)) {
                setEntries(res.entries as Entry[]);
                setStatus('ready');
            } else {
                setStatus('error');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId, currentPath, reloadTick]);

    const handleBack = React.useCallback(() => {
        const target = resolveBack(currentPath, rootPath, homeDir);
        if (target.kind === 'up') {
            setCurrentPath(target.path);
        } else {
            onExit();
        }
        return true;
    }, [currentPath, rootPath, homeDir, onExit]);

    // 把面板返回手势也接到同一套逻辑；路径变化时重挂，保证读到最新位置。
    React.useEffect(() => {
        return panel?.registerBackHandler(handleBack);
    }, [panel, handleBack]);

    const goUp = React.useCallback(() => {
        if (!canGoUp(currentPath, homeDir, rootPath)) return;
        hapticsLight();
        setCurrentPath(getParentPath(currentPath));
    }, [currentPath, homeDir, rootPath]);

    const openEntry = React.useCallback((entry: Entry) => {
        hapticsLight();
        const childPath = joinChild(currentPath, entry.name);
        if (entry.type === 'directory') {
            setCurrentPath(childPath);
        } else {
            // 打开文件查看器但**不关闭右侧面板**——看完文件返回后仍停在当前文件夹，可继续浏览。
            router.push(`/session/${sessionId}/file?path=${encodeFilePath(childPath)}` as any);
        }
    }, [currentPath, router, sessionId]);

    const upEnabled = canGoUp(currentPath, homeDir, rootPath);

    return (
        <View style={styles.container}>
            <View style={[styles.header, { borderBottomColor: theme.colors.divider }]}>
                <Pressable hitSlop={8} onPress={handleBack} style={styles.backButton}>
                    <Ionicons color={theme.colors.text} name="chevron-back" size={18} />
                    <Text style={[styles.backText, { color: theme.colors.text }]}>
                        {t('rightPanelCapabilityHub.back')}
                    </Text>
                </Pressable>
                <View style={styles.headerCopy}>
                    <Text ellipsizeMode="head" numberOfLines={1} style={[styles.headerPath, { color: theme.colors.text }]}>
                        {formatPathRelativeToHome(currentPath, homeDir)}
                    </Text>
                    {status === 'ready' ? (
                        <Text style={[styles.headerMeta, { color: theme.colors.textSecondary }]}>
                            {entries.length}
                        </Text>
                    ) : null}
                </View>
                <Pressable
                    accessibilityLabel={t('rightPanelCapabilityHub.folderBrowser.upOneLevel')}
                    disabled={!upEnabled}
                    hitSlop={8}
                    onPress={goUp}
                    style={[styles.upButton, { backgroundColor: theme.colors.surfaceHigh, opacity: upEnabled ? 1 : 0.5 }]}
                >
                    <Ionicons color={upEnabled ? theme.colors.text : theme.colors.textSecondary} name="arrow-up" size={16} />
                </Pressable>
            </View>

            {status === 'loading' ? (
                <View style={styles.emptyWrap}>
                    <ActivityIndicator color={theme.colors.textSecondary} size="small" />
                </View>
            ) : status === 'error' ? (
                <View style={styles.emptyWrap}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t('rightPanelCapabilityHub.folderBrowser.loadError')}
                    </Text>
                    <Pressable
                        onPress={() => setReloadTick((n) => n + 1)}
                        style={({ pressed }) => [
                            styles.retryButton,
                            { backgroundColor: theme.colors.button.primary.background, opacity: pressed ? 0.82 : 1 },
                        ]}
                    >
                        <Text style={[styles.retryText, { color: theme.colors.button.primary.tint }]}>
                            {t('rightPanelCapabilityHub.folderBrowser.retry')}
                        </Text>
                    </Pressable>
                </View>
            ) : entries.length === 0 ? (
                <View style={styles.emptyWrap}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t('rightPanelCapabilityHub.empty.folderBrowser')}
                    </Text>
                </View>
            ) : (
                <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                    {entries.map((entry) => (
                        <Pressable
                            key={entry.name}
                            onPress={() => openEntry(entry)}
                            style={({ pressed }) => [
                                styles.rowCard,
                                {
                                    backgroundColor: theme.colors.surface,
                                    borderColor: theme.colors.divider,
                                    transform: [{ scale: pressed ? 0.99 : 1 }],
                                },
                            ]}
                        >
                            <View style={[styles.rowIconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                                {entry.type === 'directory' ? (
                                    <Ionicons color={theme.colors.text} name="folder-outline" size={16} />
                                ) : (
                                    <FileIcon fileName={entry.name} size={16} />
                                )}
                            </View>
                            <View style={styles.rowCopy}>
                                <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text }]}>
                                    {entry.name}
                                </Text>
                            </View>
                            <Ionicons color={theme.colors.textSecondary} name="chevron-forward" size={16} />
                        </Pressable>
                    ))}
                </ScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
        minHeight: 0,
    },
    header: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 8,
        paddingBottom: 10,
        paddingHorizontal: 14,
        paddingTop: 10,
    },
    backButton: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 2,
    },
    backText: {
        fontSize: 13,
        fontWeight: '600',
    },
    headerCopy: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'flex-end',
        minWidth: 0,
    },
    headerPath: {
        flexShrink: 1,
        fontSize: 15,
        fontWeight: '600',
    },
    headerMeta: {
        fontSize: 12,
        fontWeight: '600',
    },
    upButton: {
        alignItems: 'center',
        borderRadius: 14,
        height: 28,
        justifyContent: 'center',
        width: 28,
    },
    emptyWrap: {
        alignItems: 'center',
        flex: 1,
        gap: 12,
        justifyContent: 'center',
        paddingHorizontal: 18,
        paddingVertical: 40,
    },
    emptyText: {
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
    },
    retryButton: {
        alignItems: 'center',
        borderRadius: 12,
        justifyContent: 'center',
        minHeight: 40,
        paddingHorizontal: 16,
    },
    retryText: {
        fontSize: 14,
        fontWeight: '700',
    },
    scrollContent: {
        paddingHorizontal: 12,
        paddingVertical: 12,
        rowGap: 8,
    },
    rowCard: {
        alignItems: 'center',
        borderRadius: 16,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 10,
        minHeight: 64,
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    rowIconWrap: {
        alignItems: 'center',
        borderRadius: 11,
        height: 30,
        justifyContent: 'center',
        width: 30,
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        fontSize: 14,
        fontWeight: '600',
    },
}));
