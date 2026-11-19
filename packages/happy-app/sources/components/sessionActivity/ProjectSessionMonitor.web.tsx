import * as React from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { createPortal } from 'react-dom';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { isProjectSessionDeleted, subscribeProjectSessionDeletions, getProjectSessionDeletionRevision } from '@/sync/projectSessionLinks';
import { formatLastSeen, getSessionName } from '@/utils/sessionUtils';
import { getCurrentLanguage, t } from '@/text';
import { Typography } from '@/constants/Typography';
import { GoalBoardButton as Button } from '../goalBoard/GoalBoardButton';
import { activityCategories, buildSessionActivity, countSessionActivity, matchesActivityScope, type ActivityCategory, type ActivityScope, type SessionActivity } from './sessionActivity';
import type { ProjectSessionMonitorProps, ProjectTaskSessionsProps } from './ProjectSessionMonitor.types';

function copy() {
    const zh = getCurrentLanguage().startsWith('zh');
    return zh ? { title: '全局会话', project: '本项目会话', sessions: '会话', empty: '当前没有这类会话', unavailable: '服务器连接中断，执行状态尚未确认', noAttention: '无需处理', open: '查看会话', awaiting: '等待你回复或授权', failed: '执行失败', running: '正在执行', unread: '结果等待查看', unknown: '连接中断，无法确认执行状态', scopeUnknown: '独立会话', disconnected: '未连接', labels: { attention: '需处理', running: '执行中', unread: '待查看', unknown: '状态未知' } }
        : { title: 'Global sessions', project: 'Project sessions', sessions: 'Sessions', empty: 'No sessions in this category', unavailable: 'Server disconnected; execution status is unconfirmed', noAttention: 'No action needed', open: 'Open session', awaiting: 'Waiting for your reply or approval', failed: 'Execution failed', running: 'Running', unread: 'Result not viewed', unknown: 'Disconnected; execution status unknown', scopeUnknown: 'Independent session', disconnected: 'Disconnected', labels: { attention: 'Needs action', running: 'Running', unread: 'Unviewed', unknown: 'Unknown' } };
}
type ProjectOptions = { scope?: ActivityScope; knownScopes: ActivityScope[] };
type Monitor = { setProject: React.Dispatch<React.SetStateAction<ProjectOptions>>; rows: SessionActivity[]; scope?: ActivityScope; open: (scope?: ActivityScope, category?: ActivityCategory) => void; close: () => void; isOpen: boolean };
const Context = React.createContext<Monitor | null>(null);
function colorFor(category: ActivityCategory, colors: ReturnType<typeof useUnistyles>['theme']['colors']) {
    return category === 'attention' ? colors.permission.bypass : category === 'running' ? colors.textLink : category === 'unread' ? colors.success : colors.textSecondary;
}
export function ProjectSessionMonitor(props: ProjectSessionMonitorProps) {
    const parent = React.useContext(Context);
    if (parent) return <ProjectScopeRegistration {...props} monitor={parent} />;
    return <SessionMonitorRoot {...props} />;
}
function ProjectScopeRegistration({ scope, knownScopes = [], children, monitor }: ProjectSessionMonitorProps & { monitor: Monitor }) {
    const key = JSON.stringify({ scope, knownScopes });
    const setProject = monitor.setProject;
    React.useEffect(() => {
        setProject(JSON.parse(key));
        return () => setProject(previous => ({ ...previous, scope: undefined }));
    }, [key, setProject]);
    return <Context.Provider value={{ ...monitor, scope }}>{children}</Context.Provider>;
}
function SessionMonitorRoot({ scope: initialScope, knownScopes: initialScopes = [], children }: ProjectSessionMonitorProps) {
    const [project, setProject] = React.useState<ProjectOptions>({ scope: initialScope, knownScopes: initialScopes });
    const scope = project.scope, knownScopes = project.knownScopes;
    const { width, height } = useWindowDimensions();
    const sessions = storage(s => s.sessions), unread = storage(s => s.unreadSessionIds), connected = storage(s => s.socketStatus === 'connected');
    const machines = storage(s => s.machines);
    const deletionRevision = React.useSyncExternalStore(subscribeProjectSessionDeletions, getProjectSessionDeletionRevision, getProjectSessionDeletionRevision);
    const rows = React.useMemo(() => buildSessionActivity(Object.values(sessions), unread, connected).filter(row => !isProjectSessionDeleted(row.session.id)), [sessions, unread, connected, deletionRevision]);
    const [isOpen, setOpen] = React.useState(false), [filterScope, setScope] = React.useState<ActivityScope>(), [category, setCategory] = React.useState<ActivityCategory>('attention');
    const router = useRouter();
    const trigger = React.useRef<HTMLElement | null>(null);
    const panel = React.useRef<any>(null);
    React.useEffect(() => { if (isOpen) panel.current?.focus(); }, [isOpen]);
    const close = React.useCallback(() => { setOpen(false); queueMicrotask(() => { if (trigger.current?.isConnected) trigger.current.focus(); }); }, []);
    const open = React.useCallback((nextScope?: ActivityScope, nextCategory?: ActivityCategory) => {
        trigger.current = typeof document !== 'undefined' ? document.activeElement as HTMLElement : null;
        setScope(nextScope);
        const counts = countSessionActivity(nextScope ? rows.filter(row => matchesActivityScope(row, nextScope)) : rows);
        setCategory(nextCategory ?? activityCategories.find(key => counts[key] > 0) ?? 'attention'); setOpen(true);
    }, [rows]);
    React.useEffect(() => {
        if (!isOpen) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && panel.current?.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
        window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
    }, [isOpen, close]);
    // Project navigation updates the available scope without closing the global window.
    const scoped = !isOpen ? [] : filterScope ? rows.filter(row => matchesActivityScope(row, filterScope)) : rows;
    const counts = countSessionActivity(scoped), words = copy();
    const origin = (row: SessionActivity) => {
        const titles = [...knownScopes, ...(scope ? [scope] : [])].filter(owner => matchesActivityScope(row, owner)).sort((a, b) => a.path.length - b.path.length).map(owner => owner.title);
        return titles.length ? [...new Set(titles)].join(' / ') : (row.session.metadata?.goalBoard?.featurePath ?? row.session.metadata?.path)?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || words.scopeUnknown;
    };
    const visible = scoped.filter(row => row.category === category);
    const panelTitle = filterScope ? `${filterScope.title} · ${words.sessions}` : words.title;
    const { theme } = useUnistyles();
    const context = React.useMemo(() => ({ rows, scope, open, close, isOpen, setProject }), [rows, scope, open, close, isOpen]);
    const [position, setPosition] = React.useState({ x: 84, y: 72 });
    const panelWidth = Math.max(0, Math.min(360, width - 24));
    const panelHeight = Math.max(0, Math.min(560, height - 24));
    const clamp = (point: { x: number; y: number }) => ({ x: Math.max(12, Math.min(point.x, width - panelWidth - 12)), y: Math.max(12, Math.min(point.y, height - panelHeight - 12)) });
    const drag = React.useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
    const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button, [role="button"]')) return;
        const point = clamp(position);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: point.x, top: point.y };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
    };
    const stopDrag = () => { drag.current = null; };
    React.useEffect(() => { setPosition(point => clamp(point)); stopDrag(); }, [width, height]);
    React.useEffect(() => { if (!isOpen) stopDrag(); }, [isOpen]);
    React.useEffect(() => { window.addEventListener('blur', stopDrag); return () => window.removeEventListener('blur', stopDrag); }, []);
    const point = clamp(position);
    return <Context.Provider value={context}>{children}{isOpen && typeof document !== 'undefined' && createPortal(
        <View ref={panel} role="dialog" tabIndex={-1} aria-modal={false} aria-label={panelTitle} style={[styles.panel, { position: 'fixed', zIndex: 3000, top: point.y, left: point.x, width: panelWidth, maxHeight: panelHeight } as any]} testID="session-activity-panel">
            <View style={[styles.panelHeader, { cursor: 'move', touchAction: 'none', userSelect: 'none' } as any]} testID="session-activity-drag-handle" {...({
                onPointerDown: startDrag,
                onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
                    const current = drag.current;
                    if (current?.id !== event.pointerId) return;
                    setPosition(clamp({ x: current.left + event.clientX - current.x, y: current.top + event.clientY - current.y }));
                },
                onPointerUp: stopDrag, onPointerCancel: stopDrag, onLostPointerCapture: stopDrag,
            } as any)}><View style={[styles.line, { flex: 1, minWidth: 0 }]}><Ionicons name="chatbubbles-outline" size={17} color={theme.colors.textLink} /><Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{panelTitle}</Text></View><Button variant="icon" label={t('sidebarLists.close')} onPress={close} testID="session-activity-close"><Ionicons name="close" size={18} color={theme.colors.textSecondary} /></Button></View>
            <View style={styles.tabs}>{activityCategories.filter(key => key !== 'unknown' || counts.unknown > 0 || category === 'unknown').map(key => <Button key={key} variant="toolbar" label={`${words.labels[key]} ${counts[key]}`} selected={category === key} onPress={() => setCategory(key)} testID={`session-activity-tab-${key}`}><Text style={[styles.small, category === key && { color: theme.colors.textLink }]}>{words.labels[key]} {counts[key]}</Text></Button>)}</View>
            {!connected && <Text accessibilityLiveRegion="polite" style={styles.connection}>{words.unavailable}</Text>}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
                {!visible.length && <Text style={styles.empty}>{words.empty}</Text>}
                {visible.map(row => { const session = row.session, machine = machines[session.metadata?.machineId ?? '']; const title = session.metadata?.name || getSessionName(session); const status = row.category === 'attention' ? row.state === 'failed' ? words.failed : words.awaiting : words[row.category]; return <View key={session.id} style={styles.card} testID={`session-activity-row-${session.id}`}>
                    <View style={styles.between}><View style={styles.line}><View style={[styles.dot, { backgroundColor: colorFor(row.category, theme.colors) }]} /><Text style={[styles.small, { color: colorFor(row.category, theme.colors) }]}>{status}</Text></View><Text style={styles.meta}>{formatLastSeen(session.agentState?.turnStatus?.updatedAt ?? session.lastMessageAt ?? session.updatedAt)}</Text></View>
                    <Text numberOfLines={2} style={styles.rowTitle}>{title}</Text><Text numberOfLines={1} style={styles.small}>{origin(row)}</Text>
                    <View style={styles.between}><View style={[styles.line, { flex: 1, minWidth: 0 }]}><Ionicons name="desktop-outline" size={13} color={theme.colors.textSecondary} /><Text numberOfLines={1} style={[styles.meta, { flexShrink: 1 }]}>{machine?.metadata?.displayName || machine?.metadata?.host || t('projectGoals.machine')}{!row.connected ? ` · ${words.disconnected}` : ''}</Text></View><Button variant="chip" label={words.open} onPress={() => { router.push(`/session/${encodeURIComponent(session.id)}`); }} testID={`session-activity-open-${session.id}`}><Text style={styles.link}>{words.open}</Text><Ionicons name="arrow-forward" size={13} color={theme.colors.textLink} /></Button></View>
                </View> })}
            </ScrollView>
        </View>
    , document.body)}</Context.Provider>;
}
export function GlobalSessionRailEntry({ render }: { render: (props: { label: string; selected: boolean; onPress: () => void; badge?: string }) => React.ReactNode }) {
    const monitor = React.useContext(Context);
    if (!monitor) return null;
    return <>{render({ label: `${copy().title} · ${monitor.isOpen ? 'ON' : 'OFF'}`, selected: monitor.isOpen, onPress: () => monitor.isOpen ? monitor.close() : monitor.open(), badge: monitor.isOpen ? 'ON' : undefined })}</>;
}
export function GlobalSessionEntry() {
    const monitor = React.useContext(Context), { theme } = useUnistyles(), { width } = useWindowDimensions();
    if (!monitor || width < 1100) return null;
    const counts = countSessionActivity(monitor.rows), words = copy();
    return <Button variant="chip" label={`${words.title} · ${words.labels.running} ${counts.running} · ${words.labels.attention} ${counts.attention}`} expanded={monitor.isOpen} selected={monitor.isOpen} onPress={() => monitor.isOpen ? monitor.close() : monitor.open()} testID="global-session-entry"><Ionicons name="chatbubbles-outline" size={16} color={theme.colors.textLink} /><Text style={styles.small}>{words.title}</Text><Text style={[styles.small, { color: theme.colors.textLink }]}>{words.labels.running} {counts.running}</Text><Text style={[styles.small, counts.attention > 0 && { color: theme.colors.status.error }]}>{counts.attention ? `${words.labels.attention} ${counts.attention}` : words.noAttention}</Text>{counts.unknown > 0 && <Text style={styles.meta}>{words.labels.unknown} {counts.unknown}</Text>}</Button>;
}
export function ProjectSessionSummary() {
    const monitor = React.useContext(Context), { width } = useWindowDimensions(), { theme } = useUnistyles();
    if (!monitor?.scope || width < 1100) return null;
    const scope = monitor.scope, counts = countSessionActivity(monitor.rows.filter(row => matchesActivityScope(row, scope))), words = copy();
    return <View style={styles.summary}><Text style={styles.meta}>{words.project}</Text>{activityCategories.filter(key => key !== 'unknown' || counts[key] > 0).map(key => <Button key={key} variant="toolbar" label={`${words.labels[key]} ${counts[key]}`} onPress={() => monitor.open(scope, key)} testID={`project-session-${key}`}><Text style={[styles.small, { color: colorFor(key, theme.colors) }]}>{words.labels[key]} {counts[key]}</Text></Button>)}</View>;
}
export function ProjectTaskSessions({ task, machineId, featurePath, onFallback, disabled, offline }: ProjectTaskSessionsProps) {
    const monitor = React.useContext(Context), { theme } = useUnistyles();
    const scope: ActivityScope = { machineId, path: featurePath, title: task.title, taskId: task.id, directory: task.indexPath.replace(/[\\/][^\\/]+$/, '') };
    const rows = monitor?.rows.filter(row => matchesActivityScope(row, scope)) ?? [], counts = countSessionActivity(rows), words = copy();
    const category = activityCategories.find(key => counts[key] > 0);
    return <Button variant="toolbar" label={rows.length ? `${words.project} · ${task.title} · ${rows.length}` : t('projectGoals.openChat')} disabled={disabled || (!!offline && !rows.length)} onPress={() => rows.length ? monitor?.open(scope) : onFallback()} testID={`project-task-chat-${task.id}`}><Ionicons name="chatbubble-outline" size={17} color={category ? colorFor(category, theme.colors) : theme.colors.textSecondary} />{category && <Text style={[styles.meta, { color: colorFor(category, theme.colors) }]}>{counts[category]} {words.labels[category]}</Text>}</Button>;
}
const styles = StyleSheet.create(theme => ({
    panel: { position: 'absolute', borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, overflow: 'hidden', boxShadow: `0 12px 40px ${theme.colors.shadow.color}` },
    panelHeader: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    title: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 15, flexShrink: 1 },
    tabs: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: theme.colors.divider, flexDirection: 'row', paddingHorizontal: 10, gap: 2, flexWrap: 'wrap' },
    scroll: { flexShrink: 1 }, list: { padding: 10, gap: 8 },
    card: { borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh, borderRadius: 10, padding: 10, gap: 6 },
    between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, line: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 6, height: 6, borderRadius: 3 },
    rowTitle: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 18, color: theme.colors.text },
    small: { ...Typography.default(), fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary },
    meta: { ...Typography.default(), fontSize: 10, lineHeight: 15, color: theme.colors.textSecondary }, link: { ...Typography.default(), fontSize: 11, color: theme.colors.textLink },
    empty: { padding: 35, textAlign: 'center', color: theme.colors.textSecondary, fontSize: 12 }, connection: { paddingHorizontal: 16, paddingTop: 10, fontSize: 11, color: theme.colors.status.error },
    summary: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2, marginLeft: 6 },
}));
