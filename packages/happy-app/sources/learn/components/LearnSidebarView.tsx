import * as React from 'react';
import { Text, View, ScrollView, Pressable, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSidebarCollapse } from '@/components/SidebarNavigator';
import {
    useLearnApiStatus,
    useLearnChatSessions,
    useLearnCardStats,
    useLearnCollapsedCourses,
    useLearnCourseOrder,
    learnStorage,
} from '../learnStorage';
import type { ChatSession } from '../learnTypes';
import { learnApi } from '../learnApi';
import { LearnSettingsView } from './LearnSettingsView';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        backgroundColor: theme.colors.groupped.background,
    },
    leftGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 28,
    },
    centerGroup: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    rightGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 28,
    },
    titleText: {
        fontSize: 15,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
        color: theme.colors.header.tint,
        ...Typography.brand(),
    },
    iconButton: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
    },
    // Course group header
    courseGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        gap: 6,
        marginHorizontal: 16,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        marginTop: 4,
        ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'opacity 0.15s ease' } : {}),
    },
    courseGroupCollapsed: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    courseGroupDragOver: {
        borderTopWidth: 2,
        borderTopColor: theme.colors.accent,
    },
    courseGroupDragging: {
        opacity: 0.5,
    },
    gripperIcon: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: 0.4,
    },
    courseGroupIcon: {
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    courseGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        flex: 1,
        ...Typography.default('semiBold'),
    },
    courseGroupCount: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    // Session item (card style)
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionItem: {
        height: 68,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    // FAB area
    fabContainer: {
        position: 'absolute',
        left: 12,
        right: 12,
        flexDirection: 'row',
        gap: 8,
    },
    fabButton: {
        flex: 1,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
        backgroundColor: theme.colors.groupped.item,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'opacity 0.15s ease' } : {}),
    },
    fabText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    badge: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 5,
    },
    badgeText: {
        fontSize: 10,
        color: '#fff',
        fontWeight: '600',
    },
}));

// Course color palette for icons
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

// Course group header — clickable to expand/collapse, draggable on web
const CourseGroupRow = React.memo(({
    courseTitle, sessionCount, archivedCount, isCollapsed, isDragOver, isDragging, onToggle,
    onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: {
    courseTitle: string;
    sessionCount: number;
    archivedCount?: number;
    isCollapsed: boolean;
    isDragOver: boolean;
    isDragging: boolean;
    onToggle: () => void;
    onDragStart: () => void;
    onDragOver: (e: any) => void;
    onDragLeave: () => void;
    onDrop: (e: any) => void;
    onDragEnd: () => void;
}) => {
    const { theme } = useUnistyles();
    const color = getCourseColor(courseTitle);
    const isGeneral = courseTitle === 'Общее';
    const ref = React.useRef<View>(null);

    // Attach web drag events via ref (RN Pressable doesn't expose drag events)
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !ref.current) return;
        const el = ref.current as unknown as HTMLElement;
        el.draggable = true;
        const handleDragStart = (e: DragEvent) => {
            e.dataTransfer?.setData('text/plain', courseTitle);
            onDragStart();
        };
        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            onDragOver(e);
        };
        const handleDragLeave = () => onDragLeave();
        const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            onDrop(e);
        };
        const handleDragEnd = () => onDragEnd();

        el.addEventListener('dragstart', handleDragStart);
        el.addEventListener('dragover', handleDragOver);
        el.addEventListener('dragleave', handleDragLeave);
        el.addEventListener('drop', handleDrop);
        el.addEventListener('dragend', handleDragEnd);
        return () => {
            el.removeEventListener('dragstart', handleDragStart);
            el.removeEventListener('dragover', handleDragOver);
            el.removeEventListener('dragleave', handleDragLeave);
            el.removeEventListener('drop', handleDrop);
            el.removeEventListener('dragend', handleDragEnd);
        };
    }, [courseTitle, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd]);

    return (
        <Pressable
            ref={ref}
            style={[
                styles.courseGroup,
                isCollapsed && styles.courseGroupCollapsed,
                isDragOver && styles.courseGroupDragOver,
                isDragging && styles.courseGroupDragging,
            ]}
            onPress={onToggle}
        >
            {/* Gripper for drag */}
            <View style={styles.gripperIcon}>
                <Ionicons name="reorder-three" size={16} color={theme.colors.textSecondary} />
            </View>
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
                {sessionCount}{archivedCount ? ` +${archivedCount}` : ''}
            </Text>
            <Ionicons
                name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
                size={16}
                color={theme.colors.textSecondary}
            />
        </Pressable>
    );
});

// Session item row with context menu
const SessionItemRow = React.memo(({
    session,
    isSelected,
    isLast,
    onPress,
    onArchive,
    onDelete,
}: {
    session: ChatSession;
    isSelected: boolean;
    isLast: boolean;
    onPress: () => void;
    onArchive: () => void;
    onDelete: () => void;
}) => {
    const { theme } = useUnistyles();
    const isArchived = !!session.archived;
    const dotColor = isSelected ? theme.colors.status.connected : theme.colors.status.disconnected;
    const [hovered, setHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);

    const webHoverProps = Platform.OS === 'web' ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => { setHovered(false); setMenuOpen(false); },
    } as any : {};

    // Escape key to close context menu
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !menuOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setMenuOpen(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [menuOpen]);

    return (
        <View
            style={[
                styles.sessionItemContainer,
                isLast && styles.sessionItemContainerLast,
            ]}
            {...webHoverProps}
        >
            <Pressable
                style={[
                    styles.sessionItem,
                    isSelected && styles.sessionItemSelected,
                    !isSelected && hovered && Platform.OS === 'web' && { backgroundColor: 'rgba(255,255,255,0.03)' },
                    isArchived && { opacity: 0.5 },
                    Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease' } as any : {},
                ]}
                onPress={onPress}
            >
                <View style={styles.sessionContent}>
                    <View style={styles.sessionTitleRow}>
                        {isArchived && (
                            <Ionicons name="archive-outline" size={12} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
                        )}
                        <Text
                            style={[
                                styles.sessionTitle,
                                isSelected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
                                { flex: 1 },
                            ]}
                            numberOfLines={1}
                        >
                            {session.title || 'Untitled'}
                        </Text>
                        {/* More button (visible on hover) */}
                        {(hovered || menuOpen) && (
                            <Pressable
                                onPress={(e) => { e.stopPropagation?.(); setMenuOpen(prev => !prev); }}
                                hitSlop={4}
                                style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
                            >
                                <Ionicons name="ellipsis-horizontal" size={14} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                    </View>
                    <View style={styles.statusRow}>
                        <View style={styles.statusDotContainer}>
                            <StatusDot color={dotColor} />
                        </View>
                        <Text style={[styles.statusText, { color: dotColor }]}>
                            {isSelected ? 'активна' : `${session.messageCount} сбщ`}
                        </Text>
                    </View>
                </View>
            </Pressable>
            {/* Dropdown menu */}
            {menuOpen && (
                <View style={{
                    position: 'absolute', right: 8, top: 32, zIndex: 200,
                    backgroundColor: theme.colors.groupped.item,
                    borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider,
                    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 12px rgba(0,0,0,0.3)' } as any : {}),
                    overflow: 'hidden', minWidth: 150,
                }}>
                    <Pressable
                        onPress={() => { setMenuOpen(false); onArchive(); }}
                        style={({ hovered }: any) => ({
                            flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10,
                            backgroundColor: hovered ? 'rgba(255,255,255,0.06)' : 'transparent',
                            ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.1s ease' } as any : {}),
                        })}
                    >
                        <Ionicons name={isArchived ? 'arrow-undo-outline' : 'archive-outline'} size={15} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default() }}>
                            {isArchived ? 'Разархивировать' : 'Архивировать'}
                        </Text>
                    </Pressable>
                    <View style={{ height: 0.5, backgroundColor: theme.colors.divider }} />
                    <Pressable
                        onPress={() => {
                            setMenuOpen(false);
                            if (Platform.OS === 'web') {
                                const confirmed = window.confirm(`Удалить "${session.title || 'Untitled'}"?`);
                                if (confirmed) onDelete();
                            } else {
                                onDelete();
                            }
                        }}
                        style={({ hovered }: any) => ({
                            flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10,
                            backgroundColor: hovered ? 'rgba(220,80,80,0.1)' : 'transparent',
                            ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.1s ease' } as any : {}),
                        })}
                    >
                        <Ionicons name="trash-outline" size={15} color="rgb(220,80,80)" />
                        <Text style={{ fontSize: 13, color: 'rgb(220,80,80)', ...Typography.default() }}>
                            Удалить
                        </Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
});

export const LearnSidebarView = React.memo(() => {
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const apiStatus = useLearnApiStatus();
    const chatSessions = useLearnChatSessions();
    const cardStats = useLearnCardStats();
    const collapsedCourses = useLearnCollapsedCourses();
    const courseOrder = useLearnCourseOrder();
    const sidebar = useSidebarCollapse();
    const [hideInactive, setHideInactive] = React.useState(false);
    const [showSettings, setShowSettings] = React.useState(false);

    // Drag & drop state
    const [draggingCourse, setDraggingCourse] = React.useState<string | null>(null);
    const [dropTarget, setDropTarget] = React.useState<string | null>(null);

    // Load course order from localStorage on mount
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        try {
            const saved = localStorage.getItem('learn_course_order');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    learnStorage.getState().setCourseOrder(parsed);
                }
            }
        } catch {}
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

    const statusColor = (() => {
        switch (apiStatus) {
            case 'connected': return theme.colors.status.connected;
            case 'error': return theme.colors.status.error;
            default: return theme.colors.status.disconnected;
        }
    })();

    // Active session from URL
    const activeSessionId = React.useMemo(() => {
        const match = pathname.match(/\/learn\/chat\/([^/]+)/);
        return match?.[1] || null;
    }, [pathname]);

    // Group sessions by courseTitle
    const courseGroups = React.useMemo(() => {
        const sorted = [...chatSessions].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );

        const groups = new Map<string, ChatSession[]>();
        for (const session of sorted) {
            const key = session.courseTitle || 'Общее';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(session);
        }

        // Sort keys: use courseOrder if set, then fallback to date, General last
        const sortedKeys = [...groups.keys()].sort((a, b) => {
            const aIdx = courseOrder.indexOf(a);
            const bIdx = courseOrder.indexOf(b);
            // Both in custom order — sort by order
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            // Only one in custom order — it goes first
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            // Neither in custom order — General last, rest by date
            if (a === 'Общее') return 1;
            if (b === 'Общее') return -1;
            const aTime = new Date(groups.get(a)![0].updatedAt).getTime();
            const bTime = new Date(groups.get(b)![0].updatedAt).getTime();
            return bTime - aTime;
        });

        return { groups, sortedKeys };
    }, [chatSessions, courseOrder]);

    const handleSessionPress = React.useCallback((session: ChatSession) => {
        learnStorage.getState().setActiveSessionId(session.id);
        router.push(`/learn/chat/${session.id}` as any);
    }, [router]);

    const handleNewChat = React.useCallback(() => {
        router.push('/learn/chat/new' as any);
    }, [router]);

    const handleReview = React.useCallback(() => {
        router.push('/learn/review' as any);
    }, [router]);

    const handleToggleSidebar = React.useCallback(() => {
        sidebar.toggle();
    }, [sidebar]);

    const handleToggleCourse = React.useCallback((courseTitle: string) => {
        learnStorage.getState().toggleCourseCollapsed(courseTitle);
    }, []);

    const toggleHideInactive = React.useCallback(() => {
        setHideInactive(prev => !prev);
    }, []);

    // Drag & drop handlers
    const handleDragDrop = React.useCallback((sourceCourse: string, targetCourse: string) => {
        if (sourceCourse === targetCourse) return;
        const { sortedKeys } = courseGroups;
        const newOrder = [...sortedKeys];
        const sourceIdx = newOrder.indexOf(sourceCourse);
        const targetIdx = newOrder.indexOf(targetCourse);
        if (sourceIdx === -1 || targetIdx === -1) return;
        // Remove source and insert before target
        newOrder.splice(sourceIdx, 1);
        const insertIdx = newOrder.indexOf(targetCourse);
        newOrder.splice(insertIdx, 0, sourceCourse);
        learnStorage.getState().setCourseOrder(newOrder);
    }, [courseGroups]);

    const dueCount = cardStats?.due ?? 0;

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={[styles.header, { height: headerHeight }]}>
                {/* Left: hide sidebar + hide inactive */}
                <View style={styles.leftGroup}>
                    <Pressable
                        onPress={handleToggleSidebar}
                        hitSlop={10}
                        style={styles.iconButton}
                    >
                        <Ionicons
                            name="chevron-back-outline"
                            size={20}
                            color={theme.colors.textSecondary}
                        />
                    </Pressable>
                    <Pressable
                        onPress={toggleHideInactive}
                        hitSlop={10}
                        style={styles.iconButton}
                    >
                        <Ionicons
                            name={hideInactive ? 'eye-off-outline' : 'eye-outline'}
                            size={20}
                            color={theme.colors.textSecondary}
                        />
                    </Pressable>
                </View>

                {/* Center: indicator + logo */}
                <View style={styles.centerGroup}>
                    <StatusDot
                        color={statusColor}
                        isPulsing={apiStatus === 'disconnected'}
                        size={8}
                    />
                    <Text style={[styles.titleText, { WebkitTextStroke: '1.2px' } as any]}>learn.304</Text>
                </View>

                {/* Right: settings + add */}
                <View style={styles.rightGroup}>
                    <Pressable
                        onPress={() => setShowSettings(prev => !prev)}
                        hitSlop={10}
                        style={styles.iconButton}
                    >
                        <Ionicons
                            name={showSettings ? 'settings' : 'settings-outline'}
                            size={20}
                            color={showSettings ? theme.colors.text : theme.colors.header.tint}
                        />
                    </Pressable>
                    <Pressable
                        onPress={handleNewChat}
                        hitSlop={10}
                        style={styles.iconButton}
                    >
                        <Ionicons name="add-outline" size={22} color={theme.colors.header.tint} />
                    </Pressable>
                </View>
            </View>

            {/* Settings panel (replaces sessions list) */}
            {showSettings ? (
                <LearnSettingsView />
            ) : (
            /* Sessions list grouped by course — ScrollView for drag & drop support */
            <ScrollView
                contentContainerStyle={{ paddingBottom: 120, paddingTop: 8 }}
                showsVerticalScrollIndicator={false}
            >
                {courseGroups.sortedKeys.length === 0 && (
                    <View style={{ paddingHorizontal: 20, paddingTop: 40, alignItems: 'center' }}>
                        <Text style={{
                            fontSize: 13,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            ...Typography.default(),
                        }}>
                            No sessions yet
                        </Text>
                    </View>
                )}

                {courseGroups.sortedKeys.map((courseTitle) => {
                    const allSessions = courseGroups.groups.get(courseTitle)!;
                    const displaySessions = hideInactive ? allSessions.filter(s => !s.archived) : allSessions;
                    if (displaySessions.length === 0) return null;
                    const isCollapsed = collapsedCourses.has(courseTitle);
                    const activeCount = allSessions.filter(s => !s.archived).length;
                    const archivedCount = allSessions.filter(s => s.archived).length;

                    return (
                        <React.Fragment key={`group-${courseTitle}`}>
                            <CourseGroupRow
                                courseTitle={courseTitle}
                                sessionCount={hideInactive ? activeCount : activeCount + archivedCount}
                                archivedCount={hideInactive ? 0 : archivedCount}
                                isCollapsed={isCollapsed}
                                isDragOver={dropTarget === courseTitle}
                                isDragging={draggingCourse === courseTitle}
                                onToggle={() => handleToggleCourse(courseTitle)}
                                onDragStart={() => setDraggingCourse(courseTitle)}
                                onDragOver={(e: any) => {
                                    setDropTarget(courseTitle);
                                }}
                                onDragLeave={() => {
                                    if (dropTarget === courseTitle) setDropTarget(null);
                                }}
                                onDrop={(e: any) => {
                                    const source = e.dataTransfer?.getData('text/plain');
                                    if (source && source !== courseTitle) {
                                        handleDragDrop(source, courseTitle);
                                    }
                                    setDropTarget(null);
                                    setDraggingCourse(null);
                                }}
                                onDragEnd={() => {
                                    setDraggingCourse(null);
                                    setDropTarget(null);
                                }}
                            />
                            {!isCollapsed && displaySessions.map((session, i) => (
                                <SessionItemRow
                                    key={`session-${session.id}`}
                                    session={session}
                                    isSelected={session.id === activeSessionId}
                                    isLast={i === displaySessions.length - 1}
                                    onPress={() => handleSessionPress(session)}
                                    onArchive={() => handleArchiveSession(session.id, !!session.archived)}
                                    onDelete={() => handleDeleteSession(session.id)}
                                />
                            ))}
                        </React.Fragment>
                    );
                })}
            </ScrollView>
            )}

            {/* FAB Buttons */}
            <View style={[styles.fabContainer, { bottom: insets.bottom + 16 }]}>
                <Pressable
                    style={({ pressed }) => [styles.fabButton, pressed && { opacity: 0.7 }]}
                    onPress={handleReview}
                >
                    <Ionicons name="layers-outline" size={18} color={theme.colors.text} />
                    <Text style={styles.fabText}>Review</Text>
                    {dueCount > 0 && (
                        <View style={[styles.badge, { backgroundColor: theme.colors.accent }]}>
                            <Text style={styles.badgeText}>
                                {dueCount > 99 ? '99+' : dueCount}
                            </Text>
                        </View>
                    )}
                </Pressable>

                <Pressable
                    style={({ pressed }) => [styles.fabButton, pressed && { opacity: 0.7 }]}
                    onPress={handleNewChat}
                >
                    <Ionicons name="add" size={18} color={theme.colors.text} />
                    <Text style={styles.fabText}>Новый чат</Text>
                </Pressable>
            </View>
        </View>
    );
});
