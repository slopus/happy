import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, Platform, RefreshControl, Image } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { WebView } from 'react-native-webview';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage, useDootaskProfile, useDootaskUserCache, useDootaskTaskDetailCache } from '@/sync/storage';
import { dootaskFetchTaskDetail, dootaskFetchTaskContent, dootaskFetchTaskFlow, dootaskUpdateTask, dootaskFetchSubTasks, dootaskFetchTaskFiles } from '@/sync/dootask/api';
import { storeTempData, type NewSessionData } from '@/utils/tempDataStore';
import { ImageViewer } from '@/components/ImageViewer';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { useLinkedSessions } from '@/hooks/useLinkedSessions';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionName } from '@/utils/sessionUtils';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import type { DooTaskItem, DooTaskFile } from '@/sync/dootask/types';

/**
 * Parse DooTask flow_item_name "status|name|color" format.
 * Matches DooTask's convertWorkflow() logic.
 */
function parseFlowItem(raw: string): { status: string | null; name: string; color: string | null } {
    if (raw.indexOf('|') !== -1) {
        const arr = `${raw}||`.split('|');
        return { status: arr[0] || null, name: arr[1] || raw, color: arr[2] || null };
    }
    return { status: null, name: raw, color: null };
}

/** Default colors per workflow status type, matching DooTask's SCSS variables. */
const FLOW_STATUS_COLORS: Record<string, string> = {
    start: '#FF7070',
    progress: '#fc984b',
    test: '#2f99ec',
    end: '#0bc037',
};

function getFlowColor(status: string | null, color: string | null): string {
    if (color) return color;
    if (status && FLOW_STATUS_COLORS[status]) return FLOW_STATUS_COLORS[status];
    return '#7f7f7f';
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(ext: string): string {
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
    const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'];
    if (imageExts.includes(ext.toLowerCase())) return 'image-outline';
    if (docExts.includes(ext.toLowerCase())) return 'document-text-outline';
    return 'document-outline';
}

function DetailField({ label, value, color, theme }: {
    label: string; value: string; color?: string; theme: any;
}) {
    return (
        <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
            <Text style={[styles.fieldValue, { color: color || theme.colors.text }]}>{value}</Text>
        </View>
    );
}

// --- HTML Content Renderer ---
type HtmlContentProps = {
    html: string;
    theme: any;
    onImagePress?: (url: string) => void;
    onImagesFound?: (urls: string[]) => void;
};

const HtmlContent = React.memo(({ html, theme, onImagePress, onImagesFound }: HtmlContentProps) => {
    const [height, setHeight] = React.useState(100);
    const containerRef = React.useRef<any>(null);

    // Web: attach click delegation and extract images from DOM
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !containerRef.current) return;
        const el = containerRef.current as HTMLElement;
        // Extract images from actual DOM
        if (onImagesFound) {
            const imgs = el.querySelectorAll('img');
            const urls = Array.from(imgs).map((img: any) => img.src).filter(Boolean);
            if (urls.length > 0) onImagesFound(urls);
        }
        if (!onImagePress) return;
        const handler = (e: Event) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'IMG') {
                e.preventDefault();
                onImagePress((target as HTMLImageElement).src);
            }
        };
        el.addEventListener('click', handler);
        return () => el.removeEventListener('click', handler);
    }, [onImagePress, onImagesFound, html]);

    if (Platform.OS === 'web') {
        return (
            <View style={styles.htmlContainer}>
                {/* @ts-ignore - Web only */}
                <div
                    ref={containerRef}
                    style={{ color: theme.colors.text, fontSize: 14, lineHeight: 1.6, wordBreak: 'break-word' }}
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            </View>
        );
    }

    const wrappedHtml = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<style>
body { margin: 0; padding: 0; color: ${theme.colors.text}; font-size: 14px; line-height: 1.6; background: transparent; font-family: -apple-system, BlinkMacSystemFont, sans-serif; word-break: break-word; }
img { max-width: 100%; height: auto; border-radius: 4px; cursor: pointer; }
a { color: #0A84FF; }
pre, code { background: ${theme.colors.surfaceHighest || '#2a2a2a'}; border-radius: 4px; padding: 2px 4px; font-size: 13px; }
pre { padding: 8px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid ${theme.colors.divider || '#333'}; padding: 6px 8px; text-align: left; }
blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid ${theme.colors.divider || '#333'}; color: ${theme.colors.textSecondary}; }
</style>
</head><body>${html}
<script>
function sendHeight() { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'height', height: document.body.scrollHeight })); }
function sendImages() {
    var imgs = document.querySelectorAll('img');
    var urls = [];
    for (var i = 0; i < imgs.length; i++) { if (imgs[i].src) urls.push(imgs[i].src); }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'images', urls: urls }));
}
sendHeight();
sendImages();
new MutationObserver(function() { sendHeight(); sendImages(); }).observe(document.body, { childList: true, subtree: true });
window.addEventListener('load', function() { sendHeight(); sendImages(); });
document.addEventListener('click', function(e) {
    var el = e.target;
    if (el.tagName === 'IMG') {
        e.preventDefault();
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'imagePress', url: el.src }));
    }
});
</script>
</body></html>`;

    return (
        <View style={{ height, minHeight: 50 }}>
            <WebView
                source={{ html: wrappedHtml }}
                style={{ flex: 1, backgroundColor: 'transparent' }}
                scrollEnabled={false}
                originWhitelist={['*']}
                onMessage={(event) => {
                    try {
                        const data = JSON.parse(event.nativeEvent.data);
                        if (data.type === 'height' && data.height > 0) {
                            setHeight(data.height + 16);
                        } else if (data.type === 'imagePress' && data.url && onImagePress) {
                            onImagePress(data.url);
                        } else if (data.type === 'images' && data.urls && onImagesFound) {
                            onImagesFound(data.urls);
                        }
                    } catch { }
                }}
            />
        </View>
    );
});

export default function DooTaskDetail() {
    const { taskId } = useLocalSearchParams<{ taskId: string }>();
    const router = useRouter();
    const { theme } = useUnistyles();
    const profile = useDootaskProfile();
    const userCache = useDootaskUserCache();
    const id = Number(taskId);
    const cached = useDootaskTaskDetailCache(id);
    const linkedSessions = useLinkedSessions('dootask', String(id));
    const navigateToSession = useNavigateToSession();

    const [task, setTask] = React.useState<DooTaskItem | null>(cached?.task ?? null);
    const [taskContent, setTaskContent] = React.useState<string | null>(cached?.content ?? null);
    const [loading, setLoading] = React.useState(!cached);
    const [refreshing, setRefreshing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    // Action menu
    const [menuVisible, setMenuVisible] = React.useState(false);

    // Status change menu
    const [statusMenuVisible, setStatusMenuVisible] = React.useState(false);
    const [statusMenuItems, setStatusMenuItems] = React.useState<ActionMenuItem[]>([]);
    const [statusLoading, setStatusLoading] = React.useState(false);

    // Image viewer state
    const [imageViewerVisible, setImageViewerVisible] = React.useState(false);
    const [imageViewerIndex, setImageViewerIndex] = React.useState(0);
    const [contentImages, setContentImages] = React.useState<Array<{ uri: string }>>([]);

    // Sub-tasks & files
    const [subTasks, setSubTasks] = React.useState<DooTaskItem[]>([]);
    const [taskFiles, setTaskFiles] = React.useState<DooTaskFile[]>([]);

    // Sub-task status change menu
    const [subStatusMenuVisible, setSubStatusMenuVisible] = React.useState(false);
    const [subStatusMenuItems, setSubStatusMenuItems] = React.useState<ActionMenuItem[]>([]);
    const [subStatusLoading, setSubStatusLoading] = React.useState<number | null>(null);
    const [subStatusTitle, setSubStatusTitle] = React.useState('');

    const handleImagesFound = React.useCallback((urls: string[]) => {
        setContentImages(urls.map((uri) => ({ uri })));
    }, []);

    const handleImagePress = React.useCallback((url: string) => {
        const idx = contentImages.findIndex((img) => img.uri === url);
        setImageViewerIndex(idx >= 0 ? idx : 0);
        setImageViewerVisible(true);
    }, [contentImages]);

    const fetchData = React.useCallback(async () => {
        if (!profile || !taskId) return;

        // Fetch task detail and content in parallel
        const [detailRes, contentRes, subTasksRes, filesRes] = await Promise.all([
            dootaskFetchTaskDetail(profile.serverUrl, profile.token, id),
            dootaskFetchTaskContent(profile.serverUrl, profile.token, id),
            dootaskFetchSubTasks(profile.serverUrl, profile.token, id),
            dootaskFetchTaskFiles(profile.serverUrl, profile.token, id),
        ]);

        let newTask: DooTaskItem | null = null;
        let newContent: string | null = null;

        if (detailRes.ret === 1) {
            newTask = detailRes.data;
            setTask(newTask);
            // Fetch user nicknames via global SWR cache (only fetches missing ones)
            const userIds = (newTask!.task_user || []).map((u: any) => u.userid).filter(Boolean);
            if (userIds.length > 0) {
                storage.getState().fetchDootaskUsers(userIds);
            }
        } else {
            setError(detailRes.msg || 'Failed to load task');
        }

        if (contentRes.ret === 1 && contentRes.data) {
            const raw = typeof contentRes.data === 'string'
                ? contentRes.data
                : contentRes.data.content || '';
            if (raw) {
                // Replace {{RemoteURL}} placeholder with actual server URL
                const baseUrl = profile.serverUrl.replace(/\/+$/, '') + '/';
                newContent = raw.replace(/\{\{RemoteURL\}\}/g, baseUrl);
                setTaskContent(newContent);
            }
        }

        if (subTasksRes.ret === 1 && subTasksRes.data) {
            const list = Array.isArray(subTasksRes.data) ? subTasksRes.data : subTasksRes.data.data;
            if (Array.isArray(list)) setSubTasks(list);
        }

        if (filesRes.ret === 1 && filesRes.data) {
            const list = Array.isArray(filesRes.data) ? filesRes.data : filesRes.data.data;
            if (Array.isArray(list)) setTaskFiles(list);
        }

        // Write to global cache for SWR on next visit + sync list item
        if (newTask) {
            const prev = storage.getState().dootaskTaskDetailCache;
            storage.setState({ dootaskTaskDetailCache: { ...prev, [id]: { task: newTask, content: newContent } } });
            storage.getState().updateDootaskTask(id, newTask);
        }
    }, [id, profile?.serverUrl, profile?.token]);

    React.useEffect(() => {
        if (!profile || !taskId) return;
        if (!cached) setLoading(true);
        fetchData()
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, [fetchData]);

    const handleRefresh = React.useCallback(async () => {
        setRefreshing(true);
        setError(null);
        try {
            await fetchData();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to refresh');
        } finally {
            setRefreshing(false);
        }
    }, [fetchData]);

    const handleStatusPress = React.useCallback(async () => {
        if (!profile || !task || statusLoading) return;
        setStatusLoading(true);
        try {
            const res = await dootaskFetchTaskFlow(profile.serverUrl, profile.token, task.id);
            if (res.ret !== 1 || !res.data) {
                setError(res.msg || 'Failed to load workflow');
                return;
            }

            const { flow_item_id, turns } = res.data as {
                flow_item_id: number;
                turns: Array<{ id: number; name: string; status: string; color: string; turns: number[] }>;
            };

            let items: ActionMenuItem[];

            if (turns.length === 0) {
                // No workflow — offer complete/uncomplete toggle
                const willComplete = !task.complete_at;
                items = [{
                    label: willComplete ? t('dootask.completed') : t('dootask.uncompleted'),
                    color: willComplete ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start,
                    onPress: async () => {
                        try {
                            const updateRes = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                                task_id: task.id,
                                complete_at: willComplete,
                            });
                            if (updateRes.ret === 1) {
                                await fetchData();
                            } else {
                                setError(updateRes.msg || 'Failed to update status');
                            }
                        } catch (e) {
                            setError(e instanceof Error ? e.message : 'Failed to update status');
                        }
                    },
                }];
            } else {
                // Find the current flow item to get its allowed transitions
                const currentItem = turns.find((item) => item.id === flow_item_id);
                const allowedIds = currentItem?.turns || [];

                // Build menu: current status (selected) + allowed transitions
                items = turns
                    .filter((item) => item.id === flow_item_id || allowedIds.includes(item.id))
                    .map((item) => ({
                        label: item.name,
                        color: getFlowColor(item.status, item.color || null),
                        selected: item.id === flow_item_id,
                        onPress: async () => {
                            try {
                                const updateRes = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                                    task_id: task.id,
                                    flow_item_id: item.id,
                                });
                                if (updateRes.ret === 1) {
                                    await fetchData();
                                } else {
                                    setError(updateRes.msg || 'Failed to update status');
                                }
                            } catch (e) {
                                setError(e instanceof Error ? e.message : 'Failed to update status');
                            }
                        },
                    }));
            }

            if (items.length === 0) {
                // No transitions available — nothing to show
                return;
            }

            setStatusMenuItems(items);
            setStatusMenuVisible(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load workflow');
        } finally {
            setStatusLoading(false);
        }
    }, [profile, task, statusLoading, fetchData]);

    const handleSubTaskStatusPress = React.useCallback(async (subTask: DooTaskItem) => {
        if (!profile || subStatusLoading) return;
        setSubStatusLoading(subTask.id);
        try {
            const res = await dootaskFetchTaskFlow(profile.serverUrl, profile.token, subTask.id);
            if (res.ret !== 1 || !res.data) {
                setError(res.msg || 'Failed to load workflow');
                return;
            }

            const { flow_item_id, turns } = res.data as {
                flow_item_id: number;
                turns: Array<{ id: number; name: string; status: string; color: string; turns: number[] }>;
            };

            let items: ActionMenuItem[];

            if (turns.length === 0) {
                const willComplete = !subTask.complete_at;
                items = [{
                    label: willComplete ? t('dootask.completed') : t('dootask.uncompleted'),
                    color: willComplete ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start,
                    onPress: async () => {
                        try {
                            const updateRes = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                                task_id: subTask.id,
                                complete_at: willComplete,
                            });
                            if (updateRes.ret === 1) await fetchData();
                            else setError(updateRes.msg || 'Failed to update status');
                        } catch (e) {
                            setError(e instanceof Error ? e.message : 'Failed to update status');
                        }
                    },
                }];
            } else {
                const currentItem = turns.find((item) => item.id === flow_item_id);
                const allowedIds = currentItem?.turns || [];
                items = turns
                    .filter((item) => item.id === flow_item_id || allowedIds.includes(item.id))
                    .map((item) => ({
                        label: item.name,
                        color: getFlowColor(item.status, item.color || null),
                        selected: item.id === flow_item_id,
                        onPress: async () => {
                            try {
                                const updateRes = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                                    task_id: subTask.id,
                                    flow_item_id: item.id,
                                });
                                if (updateRes.ret === 1) await fetchData();
                                else setError(updateRes.msg || 'Failed to update status');
                            } catch (e) {
                                setError(e instanceof Error ? e.message : 'Failed to update status');
                            }
                        },
                    }));
            }

            if (items.length === 0) return;
            setSubStatusMenuItems(items);
            setSubStatusTitle(`${t('dootask.subTasks')}：${subTask.name}`);
            setSubStatusMenuVisible(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load workflow');
        } finally {
            setSubStatusLoading(null);
        }
    }, [profile, subStatusLoading, fetchData]);

    const handleStartAiSession = React.useCallback(() => {
        if (!profile || !task) return;

        const dataId = storeTempData({
            prompt: [
                'I need your help with a task from DooTask.',
                `Task ID: ${task.id}`,
                `Title: ${task.name}`,
                `Project: ${task.project_name}`,
                task.desc ? `Description:\n${task.desc}` : '',
                '',
                'Use DooTask MCP tools when needed.',
            ].filter(Boolean).join('\n'),
            sessionTitle: `DooTask: ${task.name}`,
            sessionIcon: '📋',
            mcpServers: [{
                name: 'dootask',
                url: `${profile.serverUrl}/apps/mcp_server/mcp`,
                headers: { Authorization: `Bearer ${profile.token}` },
            }],
            externalContext: {
                source: 'dootask',
                sourceUrl: profile.serverUrl,
                resourceType: 'task',
                resourceId: String(task.id),
                title: task.name,
                deepLink: `/dootask/${task.id}`,
                extra: {
                    projectId: task.project_id,
                    projectName: task.project_name,
                },
            },
        } satisfies NewSessionData);

        router.push(`/new?dataId=${dataId}`);
    }, [profile, task, router]);

    const menuItems: ActionMenuItem[] = React.useMemo(() => [
        {
            label: t('dootask.startAiSession'),
            onPress: () => handleStartAiSession(),
        },
        {
            label: t('dootask.changeStatus'),
            onPress: () => handleStatusPress(),
        },
        {
            label: t('dootask.refresh'),
            onPress: () => handleRefresh(),
        },
    ], [handleStartAiSession, handleStatusPress, handleRefresh]);

    if (loading) {
        return <ActivityIndicator style={{ flex: 1 }} />;
    }

    if (error || !task) {
        return (
            <View style={styles.empty}>
                <Text style={{ color: theme.colors.textDestructive }}>{error || 'Task not found'}</Text>
            </View>
        );
    }

    const ownerNames = (task.task_user || []).filter((u) => u.owner === 1).map((u) => userCache[u.userid] || String(u.userid)).reverse();
    const assistantNames = (task.task_user || []).filter((u) => u.owner === 0).map((u) => userCache[u.userid] || String(u.userid)).reverse();
    const flow = task.flow_item_name ? parseFlowItem(task.flow_item_name) : null;
    const flowColor = flow ? getFlowColor(flow.status, flow.color) : '';
    const isCompleted = !!task.complete_at;
    const completedColor = isCompleted ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start;

    return (
        <>
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
        <ScrollView
            contentContainerStyle={styles.container}
            style={{ backgroundColor: theme.colors.surface }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
            <Text style={[styles.title, { color: theme.colors.text }]}>{task.name}</Text>

            <View style={styles.fieldGroup}>
                <DetailField label={t('dootask.project')} value={task.project_name} theme={theme} />
                <View style={styles.field}>
                    <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{t('dootask.status')}</Text>
                    <Pressable onPress={handleStatusPress} disabled={statusLoading}>
                        {flow ? (
                            <View style={[styles.statusBadge, { backgroundColor: flowColor + '20' }]}>
                                <Text style={[styles.statusBadgeText, { color: flowColor, opacity: statusLoading ? 0 : 1 }]}>{flow.name}</Text>
                                {statusLoading ? <ActivityIndicator size="small" color={flowColor} style={[StyleSheet.absoluteFillObject, { transform: [{ scale: 0.6 }] }]} /> : null}
                            </View>
                        ) : (
                            <View style={[styles.statusBadge, { backgroundColor: completedColor + '20' }]}>
                                <Text style={[styles.statusBadgeText, { color: completedColor, opacity: statusLoading ? 0 : 1 }]}>
                                    {isCompleted ? t('dootask.completed') : t('dootask.uncompleted')}
                                </Text>
                                {statusLoading ? <ActivityIndicator size="small" color={completedColor} style={[StyleSheet.absoluteFillObject, { transform: [{ scale: 0.6 }] }]} /> : null}
                            </View>
                        )}
                    </Pressable>
                </View>
                <DetailField label={t('dootask.priority')} value={task.p_name} color={task.p_color} theme={theme} />
                {ownerNames.length > 0 ? (
                    <DetailField
                        label={t('dootask.assignee')}
                        value={ownerNames.join(', ')}
                        theme={theme}
                    />
                ) : null}
                {assistantNames.length > 0 ? (
                    <DetailField
                        label={t('dootask.assistants')}
                        value={assistantNames.join(', ')}
                        theme={theme}
                    />
                ) : null}
                {task.end_at ? (
                    <DetailField
                        label={t('dootask.dueDate')}
                        value={task.end_at}
                        color={task.overdue && !task.complete_at ? theme.colors.deleteAction : undefined}
                        theme={theme}
                    />
                ) : null}
            </View>

            {taskContent ? (
                <View style={styles.descSection}>
                    <Text style={[styles.descLabel, { color: theme.colors.textSecondary }]}>
                        {t('dootask.description')}
                    </Text>
                    <HtmlContent html={taskContent} theme={theme} onImagePress={handleImagePress} onImagesFound={handleImagesFound} />
                </View>
            ) : task.desc ? (
                <View style={styles.descSection}>
                    <Text style={[styles.descLabel, { color: theme.colors.textSecondary }]}>
                        {t('dootask.description')}
                    </Text>
                    <Text style={[styles.descText, { color: theme.colors.text }]}>{task.desc}</Text>
                </View>
            ) : null}

            {/* Tags */}
            {task.task_tag && task.task_tag.length > 0 ? (
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>{t('dootask.tags')}</Text>
                    <View style={styles.tagsContainer}>
                        {task.task_tag.map((tag) => (
                            <View key={tag.id} style={[styles.tagChip, { backgroundColor: tag.color + '20' }]}>
                                <Text style={[styles.tagText, { color: tag.color }]}>{tag.name}</Text>
                            </View>
                        ))}
                    </View>
                </View>
            ) : null}

            {/* Sub-tasks */}
            {subTasks.length > 0 ? (
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>{t('dootask.subTasks')}</Text>
                    {subTasks.map((sub) => {
                        const subFlow = sub.flow_item_name ? parseFlowItem(sub.flow_item_name) : null;
                        const subFlowColor = subFlow ? getFlowColor(subFlow.status, subFlow.color) : '';
                        const subCompleted = !!sub.complete_at;
                        const subCompletedColor = subCompleted ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start;
                        return (
                            <View key={sub.id} style={styles.subTaskRow}>
                                <Pressable onPress={() => handleSubTaskStatusPress(sub)} style={{ flexShrink: 0 }}>
                                    {subFlow ? (
                                        <View style={[styles.statusBadge, { backgroundColor: subFlowColor + '20' }]}>
                                            <Text style={[styles.statusBadgeText, { color: subFlowColor, opacity: subStatusLoading === sub.id ? 0 : 1 }]}>{subFlow.name}</Text>
                                            {subStatusLoading === sub.id ? <ActivityIndicator size="small" color={subFlowColor} style={[StyleSheet.absoluteFillObject, { transform: [{ scale: 0.6 }] }]} /> : null}
                                        </View>
                                    ) : (
                                        <View style={[styles.statusBadge, { backgroundColor: subCompletedColor + '20' }]}>
                                            <Text style={[styles.statusBadgeText, { color: subCompletedColor, opacity: subStatusLoading === sub.id ? 0 : 1 }]}>
                                                {subCompleted ? t('dootask.completed') : t('dootask.uncompleted')}
                                            </Text>
                                            {subStatusLoading === sub.id ? <ActivityIndicator size="small" color={subCompletedColor} style={[StyleSheet.absoluteFillObject, { transform: [{ scale: 0.6 }] }]} /> : null}
                                        </View>
                                    )}
                                </Pressable>
                                <Text style={[styles.subTaskName, { color: theme.colors.text }]} numberOfLines={2}>{sub.name}</Text>
                            </View>
                        );
                    })}
                </View>
            ) : null}

            {/* Files */}
            {taskFiles.length > 0 ? (
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>{t('dootask.files')}</Text>
                    {taskFiles.map((file) => {
                        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(file.ext.toLowerCase());
                        const resolveUrl = (path: string) => {
                            if (path.startsWith('http')) return path;
                            if (!profile) return path;
                            return profile.serverUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
                        };
                        const fileUrl = resolveUrl(file.path);
                        return (
                            <Pressable key={file.id} style={styles.fileRow} onPress={() => WebBrowser.openBrowserAsync(fileUrl)}>
                                {isImage && file.thumb ? (
                                    <Image source={{ uri: resolveUrl(file.thumb) }} style={styles.fileThumbnail} />
                                ) : (
                                    <Ionicons name={getFileIcon(file.ext) as any} size={24} color={theme.colors.textSecondary} />
                                )}
                                <View style={styles.fileInfo}>
                                    <Text style={[styles.fileName, { color: theme.colors.text }]} numberOfLines={1}>{file.name}</Text>
                                    <Text style={[styles.fileSize, { color: theme.colors.textSecondary }]}>{formatFileSize(file.size)}</Text>
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            ) : null}

            {linkedSessions.length > 0 ? (
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('dootask.relatedSessions')} ({linkedSessions.length})
                    </Text>
                    {linkedSessions.map((session) => (
                        <Pressable
                            key={session.id}
                            style={[styles.sessionCard, { backgroundColor: theme.colors.surface }]}
                            onPress={() => navigateToSession(session.id)}
                        >
                            <Text style={[styles.sessionTitle, { color: theme.colors.text }]} numberOfLines={1}>
                                {getSessionName(session)}
                            </Text>
                            <Text style={[styles.sessionMeta, { color: theme.colors.textSecondary }]}>
                                {session.metadata?.host ?? ''}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}

            <Pressable
                style={[styles.aiButton, { backgroundColor: theme.colors.button.primary.background }]}
                onPress={handleStartAiSession}
            >
                <Text style={[styles.aiButtonText, { color: theme.colors.button.primary.tint }]}>
                    {t('dootask.startAiSession')}
                </Text>
            </Pressable>

            <ImageViewer
                images={contentImages}
                initialIndex={imageViewerIndex}
                visible={imageViewerVisible}
                onClose={() => setImageViewerVisible(false)}
            />
        </ScrollView>
        <ActionMenuModal
            visible={menuVisible}
            items={menuItems}
            onClose={() => setMenuVisible(false)}
            deferItemPress
        />
        <ActionMenuModal
            visible={statusMenuVisible}
            items={statusMenuItems}
            onClose={() => setStatusMenuVisible(false)}
            title={t('dootask.status')}
        />
        <ActionMenuModal
            visible={subStatusMenuVisible}
            items={subStatusMenuItems}
            onClose={() => setSubStatusMenuVisible(false)}
            title={subStatusTitle}
        />
        </>
    );
}

const styles = StyleSheet.create((_theme) => ({
    container: { padding: 20, gap: 16 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    title: { ...Typography.default('semiBold'), fontSize: 20 },
    fieldGroup: { gap: 12 },
    field: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    fieldLabel: { ...Typography.default(), fontSize: 14 },
    fieldValue: { ...Typography.default('semiBold'), fontSize: 14 },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
    statusBadgeText: { ...Typography.default('semiBold'), fontSize: 13 },
    descSection: { gap: 6 },
    descLabel: { ...Typography.default('semiBold'), fontSize: 14 },
    descText: { ...Typography.default(), fontSize: 14, lineHeight: 20 },
    htmlContainer: { minHeight: 20 },
    aiButton: {
        height: 48,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 8,
    },
    aiButtonText: { ...Typography.default('semiBold'), fontSize: 16 },
    section: { gap: 8 },
    sectionTitle: { ...Typography.default('semiBold'), fontSize: 14 },
    tagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    tagChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
    tagText: { ...Typography.default('semiBold'), fontSize: 12 },
    subTaskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
    subTaskName: { ...Typography.default(), fontSize: 14, flex: 1 },
    fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    fileThumbnail: { width: 32, height: 32, borderRadius: 4 },
    fileInfo: { flex: 1 },
    fileName: { ...Typography.default(), fontSize: 14 },
    fileSize: { ...Typography.default(), fontSize: 12 },
    sessionCard: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        gap: 2,
    },
    sessionTitle: { ...Typography.default('semiBold'), fontSize: 14 },
    sessionMeta: { ...Typography.default(), fontSize: 12 },
}));
