import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { WebView } from 'react-native-webview';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage, useDootaskProfile } from '@/sync/storage';
import { dootaskFetchTaskDetail, dootaskFetchTaskContent, dootaskFetchUsersBasic } from '@/sync/dootask/api';
import { machineSpawnNewSession } from '@/sync/ops';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { ImageViewer } from '@/components/ImageViewer';
import type { DooTaskItem } from '@/sync/dootask/types';

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
    const navigateToSession = useNavigateToSession();

    const [task, setTask] = React.useState<DooTaskItem | null>(null);
    const [taskContent, setTaskContent] = React.useState<string | null>(null);
    const [userMap, setUserMap] = React.useState<Record<number, string>>({});
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [spawning, setSpawning] = React.useState(false);

    // Image viewer state
    const [imageViewerVisible, setImageViewerVisible] = React.useState(false);
    const [imageViewerIndex, setImageViewerIndex] = React.useState(0);
    const [contentImages, setContentImages] = React.useState<Array<{ uri: string }>>([]);

    const handleImagesFound = React.useCallback((urls: string[]) => {
        setContentImages(urls.map((uri) => ({ uri })));
    }, []);

    const handleImagePress = React.useCallback((url: string) => {
        const idx = contentImages.findIndex((img) => img.uri === url);
        setImageViewerIndex(idx >= 0 ? idx : 0);
        setImageViewerVisible(true);
    }, [contentImages]);

    React.useEffect(() => {
        if (!profile || !taskId) return;
        setLoading(true);
        const id = Number(taskId);

        // Fetch task detail and content in parallel
        Promise.all([
            dootaskFetchTaskDetail(profile.serverUrl, profile.token, id),
            dootaskFetchTaskContent(profile.serverUrl, profile.token, id),
        ])
            .then(async ([detailRes, contentRes]) => {
                if (detailRes.ret === 1) {
                    const taskData = detailRes.data;
                    setTask(taskData);
                    // Resolve user nicknames from task_user userids
                    const userIds = (taskData.task_user || []).map((u: any) => u.userid).filter(Boolean);
                    if (userIds.length > 0) {
                        try {
                            const usersRes = await dootaskFetchUsersBasic(profile!.serverUrl, profile!.token, userIds);
                            if (usersRes.ret === 1 && Array.isArray(usersRes.data)) {
                                const map: Record<number, string> = {};
                                for (const u of usersRes.data) {
                                    if (u.userid && u.nickname) map[u.userid] = u.nickname;
                                }
                                setUserMap(map);
                            }
                        } catch { }
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
                        const baseUrl = profile!.serverUrl.replace(/\/+$/, '') + '/';
                        setTaskContent(raw.replace(/\{\{RemoteURL\}\}/g, baseUrl));
                    }
                }
            })
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, [taskId, profile?.serverUrl, profile?.token]);

    const handleStartAiSession = React.useCallback(async () => {
        if (!profile || !task) return;
        setSpawning(true);
        try {
            const state = storage.getState();
            const machines = Object.values(state.machines);
            const onlineMachine = machines.find((m) => m.active);

            if (!onlineMachine) {
                router.push('/new');
                return;
            }

            const mcpServers = [{
                name: 'dootask',
                url: `${profile.serverUrl}/apps/mcp_server/mcp`,
                headers: { Authorization: `Bearer ${profile.token}` },
            }];

            const result = await machineSpawnNewSession({
                machineId: onlineMachine.id,
                directory: onlineMachine.metadata?.homeDir || '~',
                agent: 'claude',
                sessionTitle: `DooTask: ${task.name}`,
                mcpServers,
            });

            if (result.type === 'success') {
                const taskPrompt = [
                    'I need your help with a task from DooTask.',
                    `Task ID: ${task.id}`,
                    `Title: ${task.name}`,
                    `Project: ${task.project_name}`,
                    task.desc ? `Description:\n${task.desc}` : '',
                    '',
                    'Use DooTask MCP tools when needed: get_task, send_message, update_task, complete_task.',
                ].filter(Boolean).join('\n');

                storage.getState().updateSessionDraft(result.sessionId, taskPrompt);
                navigateToSession(result.sessionId);
            } else if (result.type === 'error') {
                setError(result.errorMessage);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to start session');
        } finally {
            setSpawning(false);
        }
    }, [profile, task, router, navigateToSession]);

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

    const ownerNames = (task.task_user || []).filter((u) => u.owner === 1).map((u) => userMap[u.userid] || '').filter(Boolean);
    const assistantNames = (task.task_user || []).filter((u) => u.owner === 0).map((u) => userMap[u.userid] || '').filter(Boolean);
    const flow = task.flow_item_name ? parseFlowItem(task.flow_item_name) : null;
    const flowColor = flow?.color || theme.colors.textSecondary;

    return (
        <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.surface }}>
            <Text style={[styles.title, { color: theme.colors.text }]}>{task.name}</Text>

            <View style={styles.fieldGroup}>
                <DetailField label={t('dootask.project')} value={task.project_name} theme={theme} />
                {flow ? (
                    <View style={styles.field}>
                        <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{t('dootask.status')}</Text>
                        <View style={[styles.statusBadge, { backgroundColor: flowColor + '20' }]}>
                            <Text style={[styles.statusBadgeText, { color: flowColor }]}>{flow.name}</Text>
                        </View>
                    </View>
                ) : null}
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
                        color={task.overdue ? theme.colors.deleteAction : undefined}
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

            <Pressable
                style={[styles.aiButton, { backgroundColor: theme.colors.button.primary.background }, spawning && { opacity: 0.6 }]}
                onPress={handleStartAiSession}
                disabled={spawning}
            >
                {spawning ? (
                    <ActivityIndicator color={theme.colors.button.primary.tint} />
                ) : (
                    <Text style={[styles.aiButtonText, { color: theme.colors.button.primary.tint }]}>
                        {t('dootask.startAiSession')}
                    </Text>
                )}
            </Pressable>

            <ImageViewer
                images={contentImages}
                initialIndex={imageViewerIndex}
                visible={imageViewerVisible}
                onClose={() => setImageViewerVisible(false)}
            />
        </ScrollView>
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
}));
