import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Image, Alert, BackHandler, Platform, StyleSheet as RNStyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, FadeIn, FadeOut } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DatePickerSheet } from '@/components/dootask/DatePickerSheet';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HtmlContent } from '@/components/dootask/HtmlContent';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage, useDootaskProfile, useDootaskUserCache, useDootaskTaskDetailCache } from '@/sync/storage';
import { dootaskFetchTaskDetail, dootaskFetchTaskContent, dootaskFetchTaskFlow, dootaskUpdateTask, dootaskFetchSubTasks, dootaskFetchTaskFiles, dootaskFetchTaskDialog } from '@/sync/dootask/api';
import { storeTempData, type NewSessionData } from '@/utils/tempDataStore';
import { ImageViewer } from '@/components/ImageViewer';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { useLinkedSessions } from '@/hooks/useLinkedSessions';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionName } from '@/utils/sessionUtils';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import * as Clipboard from 'expo-clipboard';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';
import { layout } from '@/components/layout';
import { parseFlowItem, getFlowColor, FLOW_STATUS_COLORS } from '@/sync/dootask/types';
import type { DooTaskItem, DooTaskFile } from '@/sync/dootask/types';

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

function buildDooTaskPrompt(task: DooTaskItem): string {
    return `Here's a task from DooTask.\nTask ID: ${task.id}\nTitle: ${task.name}`;
}

function DetailField({ label, value, color, theme, onLongPress }: {
    label: string; value: string; color?: string; theme: any; onLongPress?: () => void;
}) {
    return (
        <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
            {onLongPress ? (
                <Pressable onLongPress={onLongPress} style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Text style={[styles.fieldValue, { color: color || theme.colors.text }]}>{value}</Text>
                </Pressable>
            ) : (
                <Text style={[styles.fieldValue, { color: color || theme.colors.text }]}>{value}</Text>
            )}
        </View>
    );
}

function formatSessionAge(ts: number): string {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return '<1m';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    return `${day}d`;
}

export default function DooTaskDetail() {
    const { taskId } = useLocalSearchParams<{ taskId: string }>();
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const profile = useDootaskProfile();
    const userCache = useDootaskUserCache();
    const id = Number(taskId);
    const cached = useDootaskTaskDetailCache(id);
    const linkedSessions = useLinkedSessions('dootask', String(id), 'task', profile?.serverUrl);
    const navigateToSession = useNavigateToSession();

    const [task, setTask] = React.useState<DooTaskItem | null>(cached?.task ?? null);
    const [taskContent, setTaskContent] = React.useState<string | null>(cached?.content ?? null);
    const [loading, setLoading] = React.useState(!cached);
    const [refreshing, setRefreshing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Sync local task state when the global cache updates (e.g. via WebSocket)
    React.useEffect(() => {
        if (cached?.task) setTask(cached.task);
    }, [cached?.task]);
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
    const [chatLoading, setChatLoading] = React.useState(false);

    const handleImagesFound = React.useCallback((urls: string[]) => {
        setContentImages(prev => {
            if (urls.length === prev.length && urls.every((u, i) => u === prev[i].uri)) return prev;
            return urls.map((uri) => ({ uri }));
        });
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
            setError(detailRes.msg || t('dootask.errorLoadTask'));
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
            Alert.alert(t('dootask.refresh'), e instanceof Error ? e.message : t('dootask.errorRefresh'));
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
                Alert.alert(t('dootask.changeStatus'), res.msg || t('dootask.errorLoadWorkflow'));
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
                // DooTask API expects a date string (YYYY-MM-DD HH:mm:ss) to complete, or false to uncomplete
                const completeValue: string | false = willComplete
                    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
                    : false;
                items = [{
                    label: willComplete ? t('dootask.completed') : t('dootask.uncompleted'),
                    color: willComplete ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start,
                    onPress: async () => {
                        try {
                            const updateRes = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                                task_id: task.id,
                                complete_at: completeValue,
                            });
                            if (updateRes.ret === 1) {
                                await fetchData();
                            } else {
                                Alert.alert(t('dootask.changeStatus'), updateRes.msg || t('dootask.errorUpdateStatus'));
                            }
                        } catch (e) {
                            Alert.alert(t('dootask.changeStatus'), e instanceof Error ? e.message : t('dootask.errorUpdateStatus'));
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
                                    Alert.alert(t('dootask.changeStatus'), updateRes.msg || t('dootask.errorUpdateStatus'));
                                }
                            } catch (e) {
                                Alert.alert(t('dootask.changeStatus'), e instanceof Error ? e.message : t('dootask.errorUpdateStatus'));
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
            Alert.alert(t('dootask.changeStatus'), e instanceof Error ? e.message : t('dootask.errorLoadWorkflow'));
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
                Alert.alert(t('dootask.changeStatus'), res.msg || t('dootask.errorLoadWorkflow'));
                return;
            }

            const { flow_item_id, turns } = res.data as {
                flow_item_id: number;
                turns: Array<{ id: number; name: string; status: string; color: string; turns: number[] }>;
            };

            let items: ActionMenuItem[];

            if (turns.length === 0) {
                const willComplete = !subTask.complete_at;
                const completeValue: string | false = willComplete
                    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
                    : false;
                items = [{
                    label: willComplete ? t('dootask.completed') : t('dootask.uncompleted'),
                    color: willComplete ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start,
                    onPress: async () => {
                        try {
                            const updateRes = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                                task_id: subTask.id,
                                complete_at: completeValue,
                            });
                            if (updateRes.ret === 1) await fetchData();
                            else Alert.alert(t('dootask.changeStatus'), updateRes.msg || t('dootask.errorUpdateStatus'));
                        } catch (e) {
                            Alert.alert(t('dootask.changeStatus'), e instanceof Error ? e.message : t('dootask.errorUpdateStatus'));
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
                                else Alert.alert(t('dootask.changeStatus'), updateRes.msg || t('dootask.errorUpdateStatus'));
                            } catch (e) {
                                Alert.alert(t('dootask.changeStatus'), e instanceof Error ? e.message : t('dootask.errorUpdateStatus'));
                            }
                        },
                    }));
            }

            if (items.length === 0) return;
            setSubStatusMenuItems(items);
            setSubStatusTitle(`${t('dootask.subTasks')}：${subTask.name}`);
            setSubStatusMenuVisible(true);
        } catch (e) {
            Alert.alert(t('dootask.changeStatus'), e instanceof Error ? e.message : t('dootask.errorLoadWorkflow'));
        } finally {
            setSubStatusLoading(null);
        }
    }, [profile, subStatusLoading, fetchData]);

    // Claim task modal state
    const [claimModalVisible, setClaimModalVisible] = React.useState(false);
    const [claimStartDate, setClaimStartDate] = React.useState(new Date());
    const [claimEndDate, setClaimEndDate] = React.useState(() => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        return d;
    });
    const [claimLoading, setClaimLoading] = React.useState(false);
    const datePickerRef = React.useRef<BottomSheetModal>(null);
    const [activePickerField, setActivePickerField] = React.useState<'start' | 'end'>('start');

    const handleClaimDateChange = React.useCallback((d: Date) => {
        if (activePickerField === 'start') {
            setClaimStartDate(d);
        } else {
            setClaimEndDate(d);
        }
    }, [activePickerField]);

    // Handle Android back button when claim overlay is visible
    React.useEffect(() => {
        if (!claimModalVisible || Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setClaimModalVisible(false);
            return true;
        });
        return () => sub.remove();
    }, [claimModalVisible]);

    const handleOpenClaimModal = React.useCallback(() => {
        if (!task) return;
        // Pre-fill from task times if available
        const now = new Date();
        setClaimStartDate(task.start_at ? new Date(task.start_at) : now);
        const defaultEnd = new Date(now);
        defaultEnd.setDate(defaultEnd.getDate() + 7);
        setClaimEndDate(task.end_at ? new Date(task.end_at) : defaultEnd);
        setClaimModalVisible(true);
    }, [task]);

    const handleClaimConfirm = React.useCallback(async () => {
        if (!profile || !task || claimLoading) return;
        if (claimEndDate <= claimStartDate) {
            Alert.alert(t('dootask.claimTask'), t('dootask.claimTimeRequired'));
            return;
        }
        const fmt = (d: Date) => d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');
        setClaimLoading(true);
        try {
            const res = await dootaskUpdateTask(profile.serverUrl, profile.token, {
                task_id: task.id,
                owner: [profile.userId],
                times: [fmt(claimStartDate), fmt(claimEndDate)],
            });
            if (res.ret === 1) {
                setClaimModalVisible(false);
                await fetchData();
            } else {
                Alert.alert(t('dootask.claimTask'), res.msg || t('dootask.errorUpdateStatus'));
            }
        } catch (e) {
            Alert.alert(t('dootask.claimTask'), e instanceof Error ? e.message : t('dootask.errorUpdateStatus'));
        } finally {
            setClaimLoading(false);
        }
    }, [profile, task, claimLoading, claimStartDate, claimEndDate, fetchData]);

    const handleOpenChat = React.useCallback(async () => {
        if (!profile || !task || chatLoading) return;
        // Use dialog_id from task detail if available, otherwise fetch it
        if (task.dialog_id) {
            router.push(`/dootask/chat/${task.dialog_id}?taskName=${encodeURIComponent(task.name)}`);
            return;
        }
        setChatLoading(true);
        try {
            const res = await dootaskFetchTaskDialog(profile.serverUrl, profile.token, task.id);
            if (res.ret === 1 && res.data?.dialog_id) {
                router.push(`/dootask/chat/${res.data.dialog_id}?taskName=${encodeURIComponent(task.name)}`);
            } else {
                Alert.alert(t('dootask.taskChat'), res.msg || t('dootask.errorLoadChat'));
            }
        } catch (e) {
            Alert.alert(t('dootask.taskChat'), e instanceof Error ? e.message : t('dootask.errorLoadChat'));
        } finally {
            setChatLoading(false);
        }
    }, [profile, task, chatLoading, router]);

    const handleStartAiSession = React.useCallback(() => {
        if (!profile || !task) return;

        const dataId = storeTempData({
            prompt: buildDooTaskPrompt(task),
            sessionTitle: `DooTask: ${task.name}`,
            sessionIcon: 'dootask',
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
    }, [profile, task, subTasks, taskFiles, userCache, router]);

    const menuItems: ActionMenuItem[] = React.useMemo(() => [
        {
            label: t('dootask.startAiSession'),
            onPress: () => handleStartAiSession(),
        },
        {
            label: t('dootask.taskChat'),
            onPress: () => handleOpenChat(),
        },
        {
            label: t('dootask.changeStatus'),
            onPress: () => handleStatusPress(),
        },
        {
            label: t('dootask.refresh'),
            onPress: () => handleRefresh(),
        },
    ], [handleStartAiSession, handleOpenChat, handleStatusPress, handleRefresh]);

    const [scrolledPastTitle, setScrolledPastTitle] = React.useState(false);
    const handleScroll = React.useCallback((e: any) => {
        const y = e.nativeEvent.contentOffset.y;
        setScrolledPastTitle(prev => {
            const next = y > 100;
            return prev === next ? prev : next;
        });
    }, []);

    // Fade-out → swap text → fade-in for smooth subtitle transition
    const subtitleOpacity = useSharedValue(1);
    const targetSubtitle = scrolledPastTitle && task ? task.name : `#${taskId}`;
    const [displayedSubtitle, setDisplayedSubtitle] = React.useState(targetSubtitle);

    React.useEffect(() => {
        if (targetSubtitle === displayedSubtitle) return;
        subtitleOpacity.value = withTiming(0, { duration: 120 });
        const timer = setTimeout(() => {
            setDisplayedSubtitle(targetSubtitle);
            subtitleOpacity.value = withTiming(1, { duration: 160 });
        }, 120);
        return () => clearTimeout(timer);
    }, [targetSubtitle]);

    const subtitleAnimStyle = useAnimatedStyle(() => ({ opacity: subtitleOpacity.value }));

    const headerTitle = React.useCallback(() => (
        <Pressable onLongPress={() => { Clipboard.setStringAsync(taskId!); hapticsLight(); showCopiedToast(); }} style={{ alignItems: 'center', justifyContent: 'center', maxWidth: 220 }}>
            <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.header.tint }]}>
                {t('dootask.taskDetail')}
            </Text>
            <Animated.Text
                numberOfLines={1}
                style={[styles.headerSubtitle, { color: theme.colors.textSecondary }, subtitleAnimStyle]}
            >
                {displayedSubtitle}
            </Animated.Text>
        </Pressable>
    ), [taskId, theme, displayedSubtitle, subtitleAnimStyle]);

    if (loading) {
        return (<><Stack.Screen options={{ headerTitle }} /><ActivityIndicator style={{ flex: 1 }} /></>);
    }

    if (error || !task) {
        return (
            <><Stack.Screen options={{ headerTitle }} />
            <View style={styles.empty}>
                <Text style={{ color: theme.colors.textDestructive }}>{error || t('dootask.taskNotFound')}</Text>
            </View></>
        );
    }

    const owners = (task.task_user || []).filter((u) => u.owner === 1);
    const ownerNames = owners.map((u) => userCache[u.userid] || String(u.userid)).reverse();
    const assistantNames = (task.task_user || []).filter((u) => u.owner === 0).map((u) => userCache[u.userid] || String(u.userid)).reverse();
    const hasNoOwner = task.task_user !== undefined && owners.length === 0;
    const flow = task.flow_item_name ? parseFlowItem(task.flow_item_name) : null;
    const flowColor = flow ? getFlowColor(flow.status, flow.color) : '';
    const isCompleted = !!task.complete_at;
    const completedColor = isCompleted ? FLOW_STATUS_COLORS.end : FLOW_STATUS_COLORS.start;

    return (
        <View style={{ flex: 1 }}>
        <Stack.Screen
            options={{
                headerTitle,
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
        <View style={{ flex: 1, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
        <ScrollView
            contentContainerStyle={styles.container}
            style={{ backgroundColor: theme.colors.surface }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
            onScroll={handleScroll}
            scrollEventThrottle={16}
        >
            <Pressable onLongPress={() => { Clipboard.setStringAsync(task.name); hapticsLight(); showCopiedToast(); }}>
                <Text style={[styles.title, { color: theme.colors.text }]}>{task.name}</Text>
            </Pressable>

            <View style={styles.fieldGroup}>
                <DetailField label={t('dootask.project')} value={task.project_name} theme={theme} onLongPress={() => { Clipboard.setStringAsync(task.project_name); hapticsLight(); showCopiedToast(); }} />
                {task.column_name ? (
                    <DetailField label={t('dootask.column')} value={task.column_name} theme={theme} onLongPress={() => { Clipboard.setStringAsync(task.column_name!); hapticsLight(); showCopiedToast(); }} />
                ) : null}
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

            {/* Claim task banner when no owner */}
            {hasNoOwner && (
                <Pressable
                    onPress={handleOpenClaimModal}
                    style={[styles.claimBanner, { backgroundColor: '#FF9500' + '18', borderColor: '#FF9500' + '40' }]}
                >
                    <View style={{ flex: 1 }}>
                        <Text style={[styles.claimText, { color: '#FF9500' }]}>{t('dootask.noOwner')}</Text>
                    </View>
                    <View style={[styles.claimButton, { backgroundColor: '#FF9500' }]}>
                        <Text style={styles.claimButtonText}>{t('dootask.claimTask')}</Text>
                    </View>
                </Pressable>
            )}

            {taskContent ? (
                <View style={styles.descSection}>
                    <Text style={[styles.descLabel, { color: theme.colors.textSecondary }]}>
                        {t('dootask.description')}
                    </Text>
                    <HtmlContent html={taskContent} theme={theme} selectable onImagePress={handleImagePress} onImagesFound={handleImagesFound} />
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
                                {[
                                    session.metadata?.flavor || 'claude',
                                    session.metadata?.host,
                                    formatSessionAge(session.createdAt),
                                ].filter(Boolean).join(' · ')}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}

            <ImageViewer
                images={contentImages}
                initialIndex={imageViewerIndex}
                visible={imageViewerVisible}
                onClose={() => setImageViewerVisible(false)}
            />
        </ScrollView>
        <View style={[styles.bottomBar, { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.divider, paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Pressable
                style={[styles.chatButton, { borderColor: theme.colors.divider, flex: 1 }]}
                onPress={handleOpenChat}
                disabled={chatLoading}
            >
                {chatLoading ? (
                    <ActivityIndicator size="small" />
                ) : (
                    <View style={styles.bottomButtonInner}>
                        <Ionicons name="chatbubbles-outline" size={17} color={theme.colors.text} />
                        <Text style={[styles.bottomButtonText, { color: theme.colors.text }]} numberOfLines={1}>
                            {t('dootask.taskChat')}{task.msg_num ? ` (${task.msg_num})` : ''}
                        </Text>
                    </View>
                )}
            </Pressable>
            <Pressable
                style={[styles.aiButton, { flex: 1, backgroundColor: theme.colors.button.primary.background }]}
                onPress={handleStartAiSession}
            >
                <View style={styles.bottomButtonInner}>
                    <Ionicons name="sparkles" size={17} color={theme.colors.button.primary.tint} />
                    <Text style={[styles.bottomButtonText, { color: theme.colors.button.primary.tint }]} numberOfLines={1}>
                        {t('dootask.startAiSession')}
                    </Text>
                </View>
            </Pressable>
        </View>
        </View>
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

        {/* Claim task overlay - uses absolute positioning instead of Modal to avoid
             iOS UIKit UIViewController creation which corrupts UINavigationBar title centering */}
        {claimModalVisible && (
            <Animated.View
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(200)}
                style={[RNStyleSheet.absoluteFillObject, { zIndex: 999 }]}
            >
                <Pressable style={styles.claimModalOverlay} onPress={() => setClaimModalVisible(false)}>
                    <Pressable style={[styles.claimModalContent, { backgroundColor: theme.colors.surface }]} onPress={() => {}}>
                        <Text style={[styles.claimModalTitle, { color: theme.colors.text }]}>{t('dootask.claimTask')}</Text>

                        {/* Start time */}
                        <View style={styles.claimTimeRow}>
                            <Text style={[styles.claimTimeLabel, { color: theme.colors.textSecondary }]}>{t('dootask.claimStartTime')}</Text>
                            <Pressable style={styles.claimTimeValueBtn} onPress={() => { setActivePickerField('start'); datePickerRef.current?.present(); }}>
                                <Text style={[styles.claimTimeValue, { color: theme.colors.text }]}>
                                    {claimStartDate.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </Pressable>
                        </View>

                        {/* End time */}
                        <View style={styles.claimTimeRow}>
                            <Text style={[styles.claimTimeLabel, { color: theme.colors.textSecondary }]}>{t('dootask.claimEndTime')}</Text>
                            <Pressable style={styles.claimTimeValueBtn} onPress={() => { setActivePickerField('end'); datePickerRef.current?.present(); }}>
                                <Text style={[styles.claimTimeValue, { color: theme.colors.text }]}>
                                    {claimEndDate.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </Pressable>
                        </View>

                        {/* Action buttons */}
                        <View style={styles.claimModalButtons}>
                            <Pressable style={[styles.claimModalBtn, { backgroundColor: theme.colors.surfaceHigh }]} onPress={() => setClaimModalVisible(false)}>
                                <Text style={[styles.claimModalBtnText, { color: theme.colors.textSecondary }]}>{t('dootask.claimCancel')}</Text>
                            </Pressable>
                            <Pressable style={[styles.claimModalBtn, { backgroundColor: '#FF9500' }]} onPress={handleClaimConfirm} disabled={claimLoading}>
                                {claimLoading ? (
                                    <ActivityIndicator size="small" color="#fff" style={{ transform: [{ scale: 0.7 }] }} />
                                ) : (
                                    <Text style={[styles.claimModalBtnText, { color: '#fff' }]}>{t('dootask.claimConfirm')}</Text>
                                )}
                            </Pressable>
                        </View>
                    </Pressable>
                </Pressable>
            </Animated.View>
        )}
        <DatePickerSheet
            ref={datePickerRef}
            date={activePickerField === 'start' ? claimStartDate : claimEndDate}
            onChange={handleClaimDateChange}
            minDate={activePickerField === 'end' ? claimStartDate : undefined}
            title={activePickerField === 'start' ? t('dootask.claimStartTime') : t('dootask.claimEndTime')}
        />
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    container: { padding: 20, gap: 16 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    title: { ...Typography.default('semiBold'), fontSize: 20 },
    headerTitle: { ...Typography.default('semiBold'), fontSize: 17 },
    headerSubtitle: { ...Typography.default(), fontSize: 12, lineHeight: 16, marginTop: -2 },
    fieldGroup: { gap: 12 },
    field: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    fieldLabel: { ...Typography.default(), fontSize: 14, flexShrink: 0, marginRight: 12 },
    fieldValue: { ...Typography.default('semiBold'), fontSize: 14, flex: 1, textAlign: 'right' },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
    statusBadgeText: { ...Typography.default('semiBold'), fontSize: 13 },
    descSection: { gap: 6 },
    descLabel: { ...Typography.default('semiBold'), fontSize: 14 },
    descText: { ...Typography.default(), fontSize: 14, lineHeight: 20 },
    bottomBar: {
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    aiButton: {
        height: 44,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bottomButtonInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    bottomButtonText: { ...Typography.default('semiBold'), fontSize: 15, flexShrink: 1 },
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
        paddingVertical: 10,
        gap: 2,
    },
    sessionTitle: { ...Typography.default('semiBold'), fontSize: 14 },
    sessionMeta: { ...Typography.default(), fontSize: 12 },
    chatButton: {
        height: 44,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
    claimBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: _theme.margins.lg,
        paddingVertical: _theme.margins.md,
        borderRadius: _theme.borderRadius.md,
        borderWidth: 1,
        gap: _theme.margins.md,
    },
    claimText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
    },
    claimButton: {
        paddingHorizontal: _theme.margins.md,
        paddingVertical: 6,
        borderRadius: 6,
        minWidth: 72,
        alignItems: 'center',
    },
    claimButtonText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: '#fff',
    },
    claimModalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    claimModalContent: {
        width: '100%',
        maxWidth: 800,
        borderRadius: 14,
        padding: 20,
        gap: 16,
    },
    claimModalTitle: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        textAlign: 'center',
    },
    claimTimeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    claimTimeLabel: {
        ...Typography.default(),
        fontSize: 14,
    },
    claimTimeValueBtn: {
        paddingVertical: 8,
        paddingLeft: 12,
    },
    claimTimeValue: {
        ...Typography.default('semiBold'),
        fontSize: 14,
    },
    claimModalButtons: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 4,
    },
    claimModalBtn: {
        flex: 1,
        height: 40,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    claimModalBtnText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
    },
}));
