import * as React from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
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
    return zh ? { title: '全局会话', project: '本项目会话', all: '全部项目', current: '当前项目', synced: '当前账号 · 已同步会话', search: '搜索会话或项目', empty: '当前范围没有匹配的会话', unavailable: '服务器连接中断，执行状态尚未确认', noAttention: '无需处理', open: '查看会话', awaiting: '等待你回复或授权', failed: '执行失败', running: '正在执行', unread: '结果等待查看', unknown: '连接中断，无法确认执行状态', clearTask: '清除任务筛选', scopeUnknown: '独立会话', disconnected: '未连接', countNote: '按会话去重统计；任务的待验收状态保持不变。', labels: { attention: '需处理', running: '执行中', unread: '待查看', unknown: '状态未知' } }
        : { title: 'Global sessions', project: 'Project sessions', all: 'All projects', current: 'Current project', synced: 'Current account · Synced sessions', search: 'Search sessions or projects', empty: 'No matching sessions in this scope', unavailable: 'Server disconnected; execution status is unconfirmed', noAttention: 'No action needed', open: 'Open session', awaiting: 'Waiting for your reply or approval', failed: 'Execution failed', running: 'Running', unread: 'Result not viewed', unknown: 'Disconnected; execution status unknown', clearTask: 'Clear task filter', scopeUnknown: 'Independent session', disconnected: 'Disconnected', countNote: 'Unique sessions; task acceptance states are unchanged.', labels: { attention: 'Needs action', running: 'Running', unread: 'Unviewed', unknown: 'Unknown' } };
}
type Monitor = { rows: SessionActivity[]; scope?: ActivityScope; open: (scope?: ActivityScope, category?: ActivityCategory) => void; close: () => void; isOpen: boolean };
const Context = React.createContext<Monitor | null>(null);
function colorFor(category: ActivityCategory, colors: ReturnType<typeof useUnistyles>['theme']['colors']) {
    return category === 'attention' ? colors.permission.bypass : category === 'running' ? colors.textLink : category === 'unread' ? colors.success : colors.textSecondary;
}
export function ProjectSessionMonitor({ scope, knownScopes = [], children }: ProjectSessionMonitorProps) {
    const { width, height } = useWindowDimensions();
    const sessions = storage(s => s.sessions), unread = storage(s => s.unreadSessionIds), connected = storage(s => s.socketStatus === 'connected');
    const machines = storage(s => s.machines);
    const deletionRevision = React.useSyncExternalStore(subscribeProjectSessionDeletions, getProjectSessionDeletionRevision, getProjectSessionDeletionRevision);
    const rows = React.useMemo(() => buildSessionActivity(Object.values(sessions), unread, connected).filter(row => !isProjectSessionDeleted(row.session.id)), [sessions, unread, connected, deletionRevision]);
    const [isOpen, setOpen] = React.useState(false), [filterScope, setScope] = React.useState<ActivityScope>(), [category, setCategory] = React.useState<ActivityCategory>('attention'), [query, setQuery] = React.useState('');
    const router = useRouter();
    const trigger = React.useRef<HTMLElement | null>(null);
    const close = React.useCallback(() => { setOpen(false); queueMicrotask(() => { if (trigger.current?.isConnected) trigger.current.focus(); }); }, []);
    const open = React.useCallback((nextScope?: ActivityScope, nextCategory?: ActivityCategory) => {
        trigger.current = typeof document !== 'undefined' ? document.activeElement as HTMLElement : null;
        setScope(nextScope); setQuery('');
        const counts = countSessionActivity(nextScope ? rows.filter(row => matchesActivityScope(row, nextScope)) : rows);
        setCategory(nextCategory ?? activityCategories.find(key => counts[key] > 0) ?? 'attention'); setOpen(true);
    }, [rows]);
    React.useEffect(() => {
        if (!isOpen) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
        window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
    }, [isOpen, close]);
    // A changed catalogue owner must not retain a task-filter belonging to the previous one.
    React.useEffect(() => { setOpen(false); setScope(undefined); setQuery(''); }, [scope?.machineId, scope?.path]);
    const scoped = !isOpen ? [] : filterScope ? rows.filter(row => matchesActivityScope(row, filterScope)) : rows;
    const counts = countSessionActivity(scoped), words = copy();
    const origin = (row: SessionActivity) => {
        const titles = [...knownScopes, ...(scope ? [scope] : [])].filter(owner => matchesActivityScope(row, owner)).sort((a, b) => a.path.length - b.path.length).map(owner => owner.title);
        return titles.length ? [...new Set(titles)].join(' / ') : (row.session.metadata?.goalBoard?.featurePath ?? row.session.metadata?.path)?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || words.scopeUnknown;
    };
    const visible = scoped.filter(row => row.category === category && `${getSessionName(row.session)} ${row.session.metadata?.name ?? ''} ${origin(row)} ${row.session.metadata?.goalBoard?.featurePath ?? ''} ${row.session.metadata?.path ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const { theme } = useUnistyles();
    const context = React.useMemo(() => ({ rows, scope, open, close, isOpen }), [rows, scope, open, close, isOpen]);
    return <Context.Provider value={context}>{children}{isOpen && <Modal transparent visible animationType="none" onRequestClose={close}>
        <Pressable style={StyleSheet.absoluteFillObject} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={close} />
        <View accessibilityViewIsModal style={[styles.panel, { top: Math.min(76, Math.max(12, height * .08)), right: 16, width: Math.min(450, width - 32), maxHeight: height - Math.min(76, Math.max(12, height * .08)) - 16 }]} testID="session-activity-panel">
            <View style={styles.panelHeader}><View style={styles.line}><Ionicons name="chatbubbles-outline" size={19} color={theme.colors.textLink} /><Text accessibilityRole="header" style={styles.title}>{words.title}</Text></View><Button variant="icon" label={t('sidebarLists.close')} onPress={close} testID="session-activity-close"><Ionicons name="close" size={19} color={theme.colors.textSecondary} /></Button></View>
            <View style={styles.scopeRow}><View style={styles.line}><Button variant="chip" label={words.all} selected={!filterScope} onPress={() => { setScope(undefined); setQuery(''); }} testID="session-activity-scope-all"><Text style={styles.small}>{words.all}</Text></Button>{scope && <Button variant="chip" label={words.current} selected={!!filterScope} onPress={() => { setScope(scope); setQuery(''); }} testID="session-activity-scope-project"><Text style={styles.small}>{words.current}</Text></Button>}</View><Text style={styles.meta}>{words.synced}</Text></View>
            {filterScope?.taskId && <View style={styles.scopeRow}><Text numberOfLines={1} style={[styles.meta, { flex: 1 }]}>{filterScope.title}</Text><Button variant="toolbar" label={words.clearTask} onPress={() => setScope(scope)}><Text style={styles.link}>{words.clearTask}</Text></Button></View>}
            <View style={styles.tabs}>{activityCategories.filter(key => key !== 'unknown' || counts.unknown > 0 || category === 'unknown').map(key => <Button key={key} variant="toolbar" label={`${words.labels[key]} ${counts[key]}`} selected={category === key} onPress={() => setCategory(key)} testID={`session-activity-tab-${key}`}><Text style={[styles.small, category === key && { color: theme.colors.textLink }]}>{words.labels[key]} {counts[key]}</Text></Button>)}</View>
            {!connected && <Text accessibilityLiveRegion="polite" style={styles.connection}>{words.unavailable}</Text>}
            <TextInput value={query} onChangeText={setQuery} placeholder={words.search} accessibilityLabel={words.search} placeholderTextColor={theme.colors.input.placeholder} style={styles.search} />
            <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
                {!visible.length && <Text style={styles.empty}>{words.empty}</Text>}
                {visible.map(row => { const session = row.session, machine = machines[session.metadata?.machineId ?? '']; const title = session.metadata?.name || getSessionName(session); const status = row.category === 'attention' ? row.state === 'failed' ? words.failed : words.awaiting : words[row.category]; return <View key={session.id} style={styles.card} testID={`session-activity-row-${session.id}`}>
                    <View style={styles.between}><View style={styles.line}><View style={[styles.dot, { backgroundColor: colorFor(row.category, theme.colors) }]} /><Text style={[styles.small, { color: colorFor(row.category, theme.colors) }]}>{status}</Text></View><Text style={styles.meta}>{formatLastSeen(session.agentState?.turnStatus?.updatedAt ?? session.lastMessageAt ?? session.updatedAt)}</Text></View>
                    <Text numberOfLines={2} style={styles.rowTitle}>{title}</Text><Text numberOfLines={1} style={styles.small}>{origin(row)}</Text>
                    <View style={styles.between}><View style={[styles.line, { flex: 1, minWidth: 0 }]}><Ionicons name="desktop-outline" size={13} color={theme.colors.textSecondary} /><Text numberOfLines={1} style={[styles.meta, { flexShrink: 1 }]}>{machine?.metadata?.displayName || machine?.metadata?.host || t('projectGoals.machine')}{!row.connected ? ` · ${words.disconnected}` : ''}</Text></View><Button variant="chip" label={words.open} onPress={() => { close(); router.push(`/session/${encodeURIComponent(session.id)}`); }} testID={`session-activity-open-${session.id}`}><Text style={styles.link}>{words.open}</Text><Ionicons name="arrow-forward" size={13} color={theme.colors.textLink} /></Button></View>
                </View> })}
            </ScrollView><Text style={styles.footer}>{words.countNote}</Text>
        </View>
    </Modal>}</Context.Provider>;
}
export function GlobalSessionEntry() {
    const monitor = React.useContext(Context), { theme } = useUnistyles(), { width } = useWindowDimensions();
    if (!monitor || width < 1100) return null;
    const counts = countSessionActivity(monitor.rows), words = copy();
    return <Button variant="chip" label={`${words.title} · ${words.labels.running} ${counts.running} · ${words.labels.attention} ${counts.attention}`} expanded={monitor.isOpen} selected={monitor.isOpen} onPress={() => monitor.open()} testID="global-session-entry"><Ionicons name="chatbubbles-outline" size={16} color={theme.colors.textLink} /><Text style={styles.small}>{words.title}</Text><Text style={[styles.small, { color: theme.colors.textLink }]}>{words.labels.running} {counts.running}</Text><Text style={[styles.small, counts.attention > 0 && { color: theme.colors.status.error }]}>{counts.attention ? `${words.labels.attention} ${counts.attention}` : words.noAttention}</Text>{counts.unknown > 0 && <Text style={styles.meta}>{words.labels.unknown} {counts.unknown}</Text>}</Button>;
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
    panelHeader: { paddingHorizontal: 18, paddingTop: 15, paddingBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    title: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 18 },
    scopeRow: { paddingHorizontal: 14, paddingBottom: 12, gap: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
    tabs: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: theme.colors.divider, flexDirection: 'row', paddingHorizontal: 10, gap: 2, flexWrap: 'wrap' },
    search: { margin: 16, marginBottom: 0, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: theme.colors.input.background, color: theme.colors.text, fontSize: 12 },
    scroll: { flexShrink: 1 }, list: { padding: 16, gap: 10 },
    card: { borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh, borderRadius: 10, padding: 14, gap: 11 },
    between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, line: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 6, height: 6, borderRadius: 3 },
    rowTitle: { ...Typography.default('semiBold'), fontSize: 14, lineHeight: 20, color: theme.colors.text },
    small: { ...Typography.default(), fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary },
    meta: { ...Typography.default(), fontSize: 10, lineHeight: 15, color: theme.colors.textSecondary }, link: { ...Typography.default(), fontSize: 11, color: theme.colors.textLink },
    footer: { borderTopWidth: 1, borderTopColor: theme.colors.divider, padding: 14, fontSize: 10, lineHeight: 16, color: theme.colors.textSecondary },
    empty: { padding: 35, textAlign: 'center', color: theme.colors.textSecondary, fontSize: 12 }, connection: { paddingHorizontal: 16, paddingTop: 10, fontSize: 11, color: theme.colors.status.error },
    summary: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2, marginLeft: 6 },
}));
