import * as React from 'react';
import { Text, View, ScrollView, Pressable, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useIsTablet } from '@/utils/responsive';
import { Header } from '@/components/navigation/Header';
import { StatusDot } from '@/components/StatusDot';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import {
    useLearnCardStats,
    useLearnApiStatus,
    useLearnChatSessions,
    useLearnCourseOrder,
    learnStorage,
} from '../learnStorage';
import { learnApi } from '../learnApi';
import { FlashcardReview } from './FlashcardReview';
import { LearnSettingsView } from './LearnSettingsView';
import type { ChatSession } from '../learnTypes';

type LearnTab = 'sessions' | 'review' | 'settings';

interface LearnMainViewProps {
    variant: 'phone' | 'sidebar';
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    tabBar: {
        flexDirection: 'row',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
        paddingBottom: 0,
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        gap: 2,
    },
    tabLabel: {
        fontSize: 10,
        ...Typography.default(),
    },
    courseGroupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: theme.colors.groupped.item,
        gap: 8,
        marginHorizontal: 12,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        marginTop: 8,
    },
    courseGroupHeaderCollapsed: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    courseGroupIcon: {
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    courseGroupTitle: {
        fontSize: 14,
        color: theme.colors.text,
        flex: 1,
        ...Typography.default('semiBold'),
    },
    courseGroupCount: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 12,
        marginHorizontal: 12,
        marginBottom: 1,
        backgroundColor: theme.colors.groupped.item,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 0,
    },
    sessionInfo: {
        flex: 1,
        gap: 2,
    },
    sessionTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    sessionMeta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    newChatButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 8,
        paddingVertical: 12,
        borderRadius: 10,
    },
    newChatText: {
        fontSize: 15,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
}));

const TAB_CONFIG: { key: LearnTab; icon: string; label: string }[] = [
    { key: 'sessions', icon: 'chatbubbles-outline', label: 'Сессии' },
    { key: 'review', icon: 'layers-outline', label: 'Повторение' },
    { key: 'settings', icon: 'settings-outline', label: 'Настройки' },
];

function formatRelativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'сейчас';
    if (mins < 60) return `${mins} мин`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} ч`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} д`;
    return new Date(dateStr).toLocaleDateString();
}

const COURSE_COLORS = [
    '#4CAF50', '#2196F3', '#FF9800', '#9C27B0',
    '#E91E63', '#00BCD4', '#FF5722', '#607D8B',
];

function getCourseColor(title: string): string {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = title.charCodeAt(i) + ((hash << 5) - hash);
    }
    return COURSE_COLORS[Math.abs(hash) % COURSE_COLORS.length];
}

const PHONE_EXPANDED_KEY = 'learn_phone_expanded_courses';

function loadPhoneExpanded(): Set<string> {
    try {
        const saved = localStorage.getItem(PHONE_EXPANDED_KEY);
        if (saved) return new Set(JSON.parse(saved));
    } catch {}
    return new Set();
}

function savePhoneExpanded(expanded: Set<string>) {
    try {
        localStorage.setItem(PHONE_EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {}
}

// ============================================
// Context menu (right-click on MacBook)
// ============================================

interface ContextMenuState {
    x: number;
    y: number;
    type: 'session' | 'course';
    sessionId?: string;
    courseId?: string;
    courseTitle?: string;
    isArchived: boolean;
}

const ContextMenu = React.memo(({
    menu, onClose,
}: {
    menu: ContextMenuState;
    onClose: () => void;
}) => {
    const { theme } = useUnistyles();

    const handleArchive = React.useCallback(async () => {
        onClose();
        try {
            if (menu.type === 'session' && menu.sessionId) {
                if (menu.isArchived) {
                    await learnApi.unarchiveSession(menu.sessionId);
                    learnStorage.getState().updateSession(menu.sessionId, { archived: false });
                } else {
                    await learnApi.archiveSession(menu.sessionId);
                    learnStorage.getState().updateSession(menu.sessionId, { archived: true });
                }
            } else if (menu.type === 'course' && menu.courseId) {
                await learnApi.archiveCourse(menu.courseId);
                // Update all sessions of this course to archived
                const sessions = learnStorage.getState().chatSessions;
                const updated = sessions.map((s) =>
                    s.courseId === menu.courseId ? { ...s, archived: true } : s
                );
                learnStorage.getState().setChatSessions(updated);
            }
        } catch (e) {
            console.error('Archive error:', e);
        }
    }, [menu, onClose]);

    const handleDelete = React.useCallback(async () => {
        onClose();
        const msg = menu.type === 'course'
            ? `Delete all sessions for "${menu.courseTitle}"?`
            : 'Delete this session permanently?';
        if (!window.confirm(msg)) return;
        try {
            if (menu.type === 'session' && menu.sessionId) {
                await learnApi.deleteSession(menu.sessionId);
                learnStorage.getState().removeSession(menu.sessionId);
            } else if (menu.type === 'course' && menu.courseId) {
                await learnApi.deleteCourse(menu.courseId);
                learnStorage.getState().removeSessionsByCourse(menu.courseId);
            }
        } catch (e) {
            console.error('Delete error:', e);
        }
    }, [menu, onClose]);

    const menuStyle = React.useMemo(() => {
        const menuW = 200;
        const menuH = 90;
        let x = menu.x;
        let y = menu.y;
        if (typeof window !== 'undefined') {
            if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
            if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
        }
        return { top: y, left: x };
    }, [menu]);

    const archiveLabel = menu.type === 'course'
        ? 'Архивировать курс'
        : (menu.isArchived ? 'Восстановить' : 'Архив');
    const archiveIcon = menu.type === 'course'
        ? 'archive-outline'
        : (menu.isArchived ? 'arrow-undo-outline' : 'archive-outline');
    const deleteLabel = menu.type === 'course' ? 'Удалить курс' : 'Удалить';

    return (
        <Pressable
            style={{ position: 'fixed' as any, top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 }}
            onPress={onClose}
        >
            <View style={{
                position: 'absolute',
                ...menuStyle,
                width: 200,
                backgroundColor: theme.colors.groupped.item,
                borderRadius: 10,
                overflow: 'hidden',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 12,
                elevation: 8,
                borderWidth: 0.5,
                borderColor: theme.colors.divider,
            }}>
                <Pressable
                    onPress={handleArchive}
                    style={({ pressed }: any) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        backgroundColor: pressed ? theme.colors.divider : 'transparent',
                    })}
                >
                    <Ionicons name={archiveIcon as any} size={18} color={theme.colors.text} />
                    <Text style={{ fontSize: 14, color: theme.colors.text, ...Typography.default() }}>
                        {archiveLabel}
                    </Text>
                </Pressable>
                <View style={{ height: 0.5, backgroundColor: theme.colors.divider }} />
                <Pressable
                    onPress={handleDelete}
                    style={({ pressed }: any) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        backgroundColor: pressed ? theme.colors.divider : 'transparent',
                    })}
                >
                    <Ionicons name="trash-outline" size={18} color="#FF3B30" />
                    <Text style={{ fontSize: 14, color: '#FF3B30', ...Typography.default() }}>
                        {deleteLabel}
                    </Text>
                </Pressable>
            </View>
        </Pressable>
    );
});

// ============================================
// Swipeable session row (touch swipe right → action buttons)
// ============================================

const SessionItem = React.memo(({
    session,
    isLast,
    onPress,
    onArchive,
    onDelete,
    onContextMenu,
}: {
    session: ChatSession;
    isLast: boolean;
    onPress: () => void;
    onArchive: () => void;
    onDelete: () => void;
    onContextMenu: (e: any) => void;
}) => {
    const { theme } = useUnistyles();
    const isArchived = !!session.archived;
    const [menuOpen, setMenuOpen] = React.useState(false);

    return (
        <View style={[
            { marginHorizontal: 12, marginBottom: 1 },
            isLast && { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, overflow: 'hidden' },
        ]}>
            <Pressable
                style={[
                    styles.sessionItem,
                    isLast && styles.sessionItemLast,
                    { marginHorizontal: 0, marginBottom: 0 },
                    isArchived && { opacity: 0.5 },
                ]}
                onPress={() => {
                    if (menuOpen) { setMenuOpen(false); return; }
                    onPress();
                }}
                {...(Platform.OS === 'web' ? {
                    onContextMenu: (e: any) => {
                        e.preventDefault?.();
                        e.stopPropagation?.();
                        onContextMenu(e);
                    },
                } as any : {})}
            >
                {isArchived && (
                    <Ionicons name="archive-outline" size={14} color={theme.colors.textSecondary} style={{ marginRight: -4 }} />
                )}
                <View style={styles.sessionInfo}>
                    <Text style={[styles.sessionTitle, isArchived && { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        {session.title || 'Без названия'}
                    </Text>
                    <Text style={styles.sessionMeta}>
                        {formatRelativeTime(session.updatedAt)}
                        {session.messageCount > 0 ? ` \u00B7 ${session.messageCount} сбщ` : ''}
                    </Text>
                </View>
                <Pressable
                    onPress={(e) => {
                        e.stopPropagation?.();
                        setMenuOpen(prev => !prev);
                    }}
                    hitSlop={8}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                >
                    <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            </Pressable>

            {/* Inline action buttons */}
            {menuOpen && (
                <View style={{
                    flexDirection: 'row',
                    backgroundColor: theme.colors.groupped.item,
                    borderTopWidth: 0.5,
                    borderTopColor: theme.colors.divider,
                }}>
                    <Pressable
                        onPress={() => { setMenuOpen(false); onArchive(); }}
                        style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            paddingVertical: 10,
                        }}
                    >
                        <Ionicons
                            name={isArchived ? 'arrow-undo-outline' : 'archive-outline'}
                            size={16}
                            color="#FF9500"
                        />
                        <Text style={{ fontSize: 13, color: '#FF9500', ...Typography.default('semiBold') }}>
                            {isArchived ? 'Восстановить' : 'Архив'}
                        </Text>
                    </Pressable>
                    <View style={{ width: 0.5, backgroundColor: theme.colors.divider, marginVertical: 6 }} />
                    <Pressable
                        onPress={() => { setMenuOpen(false); onDelete(); }}
                        style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            paddingVertical: 10,
                        }}
                    >
                        <Ionicons name="trash-outline" size={16} color="#FF3B30" />
                        <Text style={{ fontSize: 13, color: '#FF3B30', ...Typography.default('semiBold') }}>
                            Удалить
                        </Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
});

// ============================================
// Session list
// ============================================

const SessionsList = React.memo(({ hideInactive }: { hideInactive: boolean }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const sessions = useLearnChatSessions();
    const courseOrder = useLearnCourseOrder();
    const [expanded, setExpanded] = React.useState(loadPhoneExpanded);
    const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);

    const handleToggle = React.useCallback((courseTitle: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(courseTitle)) {
                next.delete(courseTitle);
            } else {
                next.add(courseTitle);
            }
            savePhoneExpanded(next);
            return next;
        });
    }, []);

    const openSessionMenu = React.useCallback((sessionId: string, isArchived: boolean, e: any) => {
        const x = e?.nativeEvent?.pageX ?? e?.pageX ?? 100;
        const y = e?.nativeEvent?.pageY ?? e?.pageY ?? 100;
        setContextMenu({ x, y, type: 'session', sessionId, isArchived });
    }, []);

    const openCourseMenu = React.useCallback((courseId: string | undefined, courseTitle: string, e: any) => {
        if (Platform.OS !== 'web') return;
        e.preventDefault?.();
        e.stopPropagation?.();
        const x = e?.nativeEvent?.pageX ?? e?.pageX ?? 100;
        const y = e?.nativeEvent?.pageY ?? e?.pageY ?? 100;
        setContextMenu({ x, y, type: 'course', courseId: courseId || undefined, courseTitle, isArchived: false });
    }, []);

    const handleArchiveSession = React.useCallback(async (sessionId: string, isArchived: boolean) => {
        try {
            if (isArchived) {
                await learnApi.unarchiveSession(sessionId);
                learnStorage.getState().updateSession(sessionId, { archived: false });
            } else {
                await learnApi.archiveSession(sessionId);
                learnStorage.getState().updateSession(sessionId, { archived: true });
            }
        } catch (e) {
            console.error('Archive error:', e);
        }
    }, []);

    const handleDeleteSession = React.useCallback(async (sessionId: string) => {
        try {
            await learnApi.deleteSession(sessionId);
            learnStorage.getState().removeSession(sessionId);
        } catch (e) {
            console.error('Delete error:', e);
        }
    }, []);

    // Group sessions by courseTitle (both active + archived together)
    const courseGroups = React.useMemo(() => {
        const sorted = [...sessions].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );

        const groups = new Map<string, { sessions: ChatSession[]; courseId: string | null }>();
        for (const session of sorted) {
            const key = session.courseTitle || 'Общее';
            if (!groups.has(key)) groups.set(key, { sessions: [], courseId: session.courseId });
            groups.get(key)!.sessions.push(session);
        }

        const sortedKeys = [...groups.keys()].sort((a, b) => {
            const aIdx = courseOrder.indexOf(a);
            const bIdx = courseOrder.indexOf(b);
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            if (a === 'Общее') return 1;
            if (b === 'Общее') return -1;
            const aTime = new Date(groups.get(a)!.sessions[0].updatedAt).getTime();
            const bTime = new Date(groups.get(b)!.sessions[0].updatedAt).getTime();
            return bTime - aTime;
        });

        return { groups, sortedKeys };
    }, [sessions, courseOrder]);

    // Filter: hide courses with no recent activity (> 7 days)
    // But still show if there are any archived sessions (so user can see them)
    const visibleKeys = React.useMemo(() => {
        if (!hideInactive) return courseGroups.sortedKeys;
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        return courseGroups.sortedKeys.filter(key => {
            const group = courseGroups.groups.get(key)!;
            // Show if any active session is recent
            const hasRecent = group.sessions.some(s => !s.archived && new Date(s.updatedAt).getTime() > weekAgo);
            if (hasRecent) return true;
            // Also show if has active (non-archived) sessions at all
            return group.sessions.some(s => !s.archived);
        });
    }, [courseGroups, hideInactive]);

    if (sessions.length === 0) {
        return (
            <View style={styles.emptyContainer}>
                <Ionicons name="chatbubbles-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={[styles.emptyText, { marginTop: 12 }]}>Пока нет сессий</Text>
                <Pressable
                    style={[styles.newChatButton, { backgroundColor: theme.colors.accent, marginTop: 16 }]}
                    onPress={() => router.push('/learn/chat/new' as any)}
                >
                    <Ionicons name="add" size={20} color="#fff" />
                    <Text style={styles.newChatText}>Начать обучение</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <>
            <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingTop: 4 }}>
                {visibleKeys.map((courseTitle) => {
                    const group = courseGroups.groups.get(courseTitle)!;
                    const allSessions = group.sessions;
                    const displaySessions = hideInactive ? allSessions.filter(s => !s.archived) : allSessions;
                    if (displaySessions.length === 0) return null;
                    const activeCount = allSessions.filter(s => !s.archived).length;
                    const archivedCount = allSessions.filter(s => s.archived).length;
                    const isExpanded = expanded.has(courseTitle);
                    const isGeneral = courseTitle === 'Общее';
                    const color = getCourseColor(courseTitle);

                    return (
                        <React.Fragment key={`group-${courseTitle}`}>
                            <Pressable
                                style={[
                                    styles.courseGroupHeader,
                                    !isExpanded && styles.courseGroupHeaderCollapsed,
                                ]}
                                onPress={() => handleToggle(courseTitle)}
                                {...(Platform.OS === 'web' ? {
                                    onContextMenu: (e: any) => openCourseMenu(group.courseId, courseTitle, e),
                                } as any : {})}
                            >
                                <View style={[styles.courseGroupIcon, { backgroundColor: color + '22' }]}>
                                    <Ionicons
                                        name={isGeneral ? 'chatbubbles-outline' : 'book-outline'}
                                        size={16}
                                        color={color}
                                    />
                                </View>
                                <Text style={styles.courseGroupTitle} numberOfLines={1}>
                                    {courseTitle}
                                </Text>
                                <Text style={styles.courseGroupCount}>
                                    {hideInactive ? activeCount : `${activeCount}${archivedCount > 0 ? ` +${archivedCount}` : ''}`}
                                </Text>
                                <Ionicons
                                    name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            </Pressable>

                            {isExpanded && displaySessions.map((session, i) => {
                                const isLast = i === displaySessions.length - 1;
                                return (
                                    <SessionItem
                                        key={session.id}
                                        session={session}
                                        isLast={isLast}
                                        onPress={() => router.push(`/learn/chat/${session.id}` as any)}
                                        onArchive={() => handleArchiveSession(session.id, !!session.archived)}
                                        onDelete={() => handleDeleteSession(session.id)}
                                        onContextMenu={(e) => openSessionMenu(session.id, !!session.archived, e)}
                                    />
                                );
                            })}
                        </React.Fragment>
                    );
                })}
            </ScrollView>

            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </>
    );
});

// ============================================
// Header
// ============================================

const LearnHeaderTitle = React.memo(() => {
    const { theme } = useUnistyles();
    const apiStatus = useLearnApiStatus();

    const statusColor = (() => {
        switch (apiStatus) {
            case 'connected': return theme.colors.status.connected;
            case 'error': return theme.colors.status.error;
            default: return theme.colors.status.disconnected;
        }
    })();

    return (
        <View style={{ position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, pointerEvents: 'none' }}>
            <StatusDot color={statusColor} isPulsing={apiStatus === 'disconnected'} size={8} />
            <Text style={{
                fontSize: 15,
                letterSpacing: 2,
                textTransform: 'uppercase' as any,
                color: theme.colors.header.tint,
                ...Typography.brand(),
            }}>learn.304</Text>
        </View>
    );
});

// ============================================
// Main
// ============================================

export const LearnMainView = React.memo(({ variant }: LearnMainViewProps) => {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const [activeTab, setActiveTab] = React.useState<LearnTab>('sessions');
    const [hideInactive, setHideInactive] = React.useState(false);
    const cardStats = useLearnCardStats();
    const chatSessions = useLearnChatSessions();

    if (variant === 'sidebar') {
        return <View style={styles.container} />;
    }

    if (isTablet) {
        return <View style={styles.container} />;
    }

    const renderContent = () => {
        switch (activeTab) {
            case 'sessions':
                return <SessionsList hideInactive={hideInactive} />;
            case 'review':
                return <FlashcardReview />;
            case 'settings':
                return <LearnSettingsView />;
        }
    };

    return (
        <>
            <View style={styles.container}>
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <Header
                        title={<LearnHeaderTitle />}
                        headerLeft={() => (
                            <View style={{ width: 72, flexDirection: 'row', alignItems: 'center' }}>
                                {activeTab === 'sessions' && (
                                    <Pressable
                                        onPress={() => setHideInactive(prev => !prev)}
                                        hitSlop={10}
                                        style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                                    >
                                        <Ionicons
                                            name={hideInactive ? 'eye-off-outline' : 'eye-outline'}
                                            size={20}
                                            color={theme.colors.textSecondary}
                                        />
                                    </Pressable>
                                )}
                            </View>
                        )}
                        headerRight={() => {
                            const lastSession = chatSessions[0];
                            return (
                                <View style={{ width: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                                    {lastSession && (
                                        <Pressable
                                            onPress={() => router.push(`/learn/chat/${lastSession.id}` as any)}
                                            hitSlop={10}
                                            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                                        >
                                            <Ionicons name="play" size={18} color={theme.colors.textLink} />
                                        </Pressable>
                                    )}
                                    <Pressable
                                        onPress={() => router.push('/learn/chat/new' as any)}
                                        hitSlop={10}
                                        style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                                    >
                                        <Ionicons name="add" size={24} color={theme.colors.header.tint} />
                                    </Pressable>
                                </View>
                            );
                        }}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                </View>
                {renderContent()}
            </View>
            <View style={[styles.tabBar, { paddingBottom: insets.bottom }]}>
                {TAB_CONFIG.map((tab) => {
                    const isActive = activeTab === tab.key;
                    const accentColor = theme.colors.textLink;
                    const color = isActive ? accentColor : theme.colors.textSecondary;
                    const badge = tab.key === 'review' && cardStats && cardStats.due > 0 ? cardStats.due : 0;

                    return (
                        <Pressable
                            key={tab.key}
                            style={styles.tab}
                            onPress={() => setActiveTab(tab.key)}
                        >
                            <View>
                                <Ionicons name={tab.icon as any} size={22} color={color} />
                                {badge > 0 && (
                                    <View style={{
                                        position: 'absolute', top: -4, right: -8,
                                        backgroundColor: accentColor,
                                        borderRadius: 8, minWidth: 16, height: 16,
                                        alignItems: 'center', justifyContent: 'center',
                                        paddingHorizontal: 4,
                                    }}>
                                        <Text style={{ fontSize: 10, color: '#fff', fontWeight: '600' }}>
                                            {badge > 99 ? '99+' : badge}
                                        </Text>
                                    </View>
                                )}
                            </View>
                            <Text style={[styles.tabLabel, { color }]}>{tab.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </>
    );
});
