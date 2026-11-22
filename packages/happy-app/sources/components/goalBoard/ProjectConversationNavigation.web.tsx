import * as React from 'react';
import { ActivityIndicator, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GoalProjectConversationsSchema } from '@slopus/happy-wire';
import { storage, useLocalSettingMutable, useLocalSettingUpdater } from '@/sync/storage';
import { isSidebarGroupExpanded, setSidebarGroupExpanded } from '@/utils/sidebarGroupExpansion';
import { WorkspaceTreeRow } from '@/components/fileWorkspace/WorkspaceTreeRow';
import { WorkspaceButton } from '@/components/fileWorkspace/WorkspaceButton';
import { loadProjectConversationCandidates, type ProjectConversationHistoryProgress } from '@/sync/projectConversationCandidates.web';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { machineStartGoalAuthor } from '@/sync/ops';
import { projectGoalRequest, canCreateProjectConversation, isReadOnlyProjectPreview } from '@/sync/projectGoals';
import { isProjectSessionDeleted, subscribeProjectSessionDeletions, getProjectSessionDeletionRevision } from '@/sync/projectSessionLinks';
import { getCurrentLanguage, t } from '@/text';
import { getSessionStateLabel, formatLastSeen } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { buildProjectConversationGroups, type ConversationGroup, type ConversationStatus } from './projectConversationModel';
import type { ProjectConversationNavigationProps, ProjectConversationSelection } from './ProjectConversationNavigation.types';
const RevealContext = React.createContext<(() => void) | undefined>(undefined);
/** Actions render inside the current file workspace even though list state is project-owned. */
export function ProjectConversationNavigationPane({ children, onReveal }: { children: React.ReactNode; onReveal: () => void }) {
    return <RevealContext.Provider value={onReveal}>{children}</RevealContext.Provider>;
}
function ConversationButton({ reveal, ...props }: React.ComponentProps<typeof Button> & { reveal?: boolean }) {
    const onReveal = React.useContext(RevealContext);
    return (
        <Button
            {...props}
            onPress={() => {
                if (reveal) onReveal?.();
                props.onPress();
            }}
        />
    );
}
function ConversationTreeRow({ reveal, ...props }: React.ComponentProps<typeof WorkspaceTreeRow> & { reveal?: boolean }) {
    const onReveal = React.useContext(RevealContext);
    return <WorkspaceTreeRow {...props} onPress={() => { if (reveal) onReveal?.(); props.onPress(); }} />;
}
function ConversationAction({ reveal, ...props }: React.ComponentProps<typeof WorkspaceButton> & { reveal?: boolean }) {
    const onReveal = React.useContext(RevealContext);
    return <WorkspaceButton {...props} onPress={() => { if (reveal) onReveal?.(); props.onPress(); }} />;
}
const Context = React.createContext<React.ReactNode>(null);
export function useProjectConversationNavigation() {
    return React.useContext(Context);
}
const words = () =>
    getCurrentLanguage().startsWith('zh')
        ? {
              sessions: '会话',
              all: '全部',
              attention: '待处理',
              running: '执行中',
              global: '全局对话',
              empty: '还没有会话',
              noResults: t('projectGoals.noFilteredConversations'),
              create: '新建会话',
              features: '个子项目',
              conversations: '个会话',
              current: '当前',
              more: '加载更多历史',
              refresh: '刷新会话',
              unread: '待查看',
              history: '历史会话',
              unknown: '状态未知',
              awaiting: '待回复 / 授权',
              failed: '执行失败',
              offline: '离线：可查看已加载历史，暂不能新建',
              counts: t('projectGoals.conversationCounts'),
              retry: '重试',
              load: '加载历史…',
              loadHistory: '加载完整历史',
              synced: '当前显示已同步会话',
              unloaded: '暂无已同步会话',
              grouping: '正在整理会话…',
              cancel: '取消',
              closed: '收起',
              open: '展开',
          }
        : {
              sessions: 'Sessions',
              all: 'All',
              attention: 'Needs action',
              running: 'Running',
              global: 'Global conversations',
              empty: 'No conversations yet',
              noResults: t('projectGoals.noFilteredConversations'),
              create: 'New conversation',
              features: 'features',
              conversations: 'conversations',
              current: 'Current',
              more: 'Load more history',
              refresh: 'Refresh sessions',
              unread: 'Unviewed',
              history: 'History',
              unknown: 'Status unknown',
              awaiting: 'Reply / approval needed',
              failed: 'Execution failed',
              offline: 'Offline: loaded history remains available; creation is disabled',
              counts: t('projectGoals.conversationCounts'),
              retry: 'Retry',
              load: 'Loading history…',
              loadHistory: 'Load complete history',
              synced: 'Showing synced conversations',
              unloaded: 'No synced conversations yet',
              grouping: 'Organizing conversations…',
              cancel: 'Cancel',
              closed: 'Collapse',
              open: 'Expand',
          };
// Only complete history results enter this cache. Project scopes can render
// before the account's detached metadata catalog finishes decrypting.
const cache = new Map<string, ConversationGroup[]>();
const READ_TIMEOUT_MS = 180_000;
function projectScopes(project: ProjectConversationNavigationProps['project']): ConversationGroup[] {
    if (!project) return [];
    return [...new Map([
        { scopePath: project.projectPath, title: project.title, total: 0, sessions: [] },
        ...project.features.map(feature => ({ scopePath: feature.featurePath, title: feature.title, total: 0, sessions: [] })),
    ].map(group => [group.scopePath, group])).values()];
}
function statusLabel(status: ConversationStatus, w: ReturnType<typeof words>) {
    return status === 'attention'
        ? w.awaiting
        : status === 'unread'
          ? w.unread
          : status === 'history'
            ? w.history
            : status === 'unknown'
              ? w.unknown
              : getSessionStateLabel(status);
}
export function ProjectConversationNavigationProvider(props: ProjectConversationNavigationProps) {
    const path = props.project?.projectPath;
    const desktop = useWindowDimensions().width >= 1100;
    const owner = getRuntimeAccountSelection();
    const key = JSON.stringify([owner?.key, owner?.generation, owner?.serverUrl, props.machineId, path]);
    return <NavigationOwner key={key} {...props} scopeKey={key} desktop={desktop} />;
}
function NavigationOwner(props: ProjectConversationNavigationProps & { scopeKey: string; desktop: boolean }) {
    const { theme } = useUnistyles(),
        w = words();
    const path = props.project?.projectPath,
        machineId = props.machineId;
    const knownScopes = React.useMemo(() => projectScopes(props.project), [props.project]);
    const scopeIdentity = JSON.stringify(knownScopes.map(group => [group.scopePath, group.title]));
    const [groups, setGroups] = React.useState<ConversationGroup[]>(() => cache.get(props.scopeKey) ?? projectScopes(props.project));
    const [countsComplete, setCountsComplete] = React.useState(() => cache.has(props.scopeKey));
    const complete = React.useRef(countsComplete);
    // Keep creations newer than a read's immutable snapshot until that snapshot
    // explicitly accounts for their IDs. Reading and creation are independent.
    const locallyCreated = React.useRef(new Map<string, { scopePath: string; row: ConversationGroup['sessions'][number] }>());
    const [loading, setLoading] = React.useState(false),
        [progress, setProgress] = React.useState<ProjectConversationHistoryProgress>(),
        [error, setError] = React.useState<string>(),
        [creating, setCreating] = React.useState<string>();
    const [filter, setFilter] = React.useState<'all' | 'attention' | 'running'>('all');
    const [expansion] = useLocalSettingMutable('sidebarGroupExpansion');
    const updateExpansion = useLocalSettingUpdater('sidebarGroupExpansion');
    const expansionId = (scopePath: string) => `conversation-navigation:${JSON.stringify([machineId, path, scopePath])}`;
    const expanded = (scopePath: string) => isSidebarGroupExpanded(expansion, 'projects', expansionId(scopePath), false);
    const setExpanded = (scopePath: string, open: boolean) => updateExpansion(value => setSidebarGroupExpanded(value, 'projects', expansionId(scopePath), open, false));
    const hasExpandedScope = knownScopes.some(group => expanded(group.scopePath));
    const headers = storage((s) => s.sessions),
        unread = storage((s) => s.unreadSessionIds),
        connected = storage((s) => s.socketStatus === 'connected');
    const deletionRevision = React.useSyncExternalStore(
        subscribeProjectSessionDeletions,
        getProjectSessionDeletionRevision,
        getProjectSessionDeletionRevision,
    );
    const epoch = React.useRef(0),
        alive = React.useRef(true),
        reading = React.useRef(false),
        opening = React.useRef(false),
        focus = React.useRef(0);
    const refreshRequested = React.useRef<boolean | undefined>(undefined),
        refreshExplicit = React.useRef(false),
        reread = React.useRef<((fresh: boolean, explicit: boolean) => void) | undefined>(undefined);
    const historyVisibility = React.useRef(false);
    const flushQueuedRead = () => {
        const fresh = refreshRequested.current;
        if (fresh === undefined) return;
        const explicit = refreshExplicit.current;
        refreshRequested.current = undefined;
        refreshExplicit.current = false;
        if (explicit) reread.current?.(fresh, explicit);
    };
    const catalogSnapshot = React.useRef<{ id: string; ids: ReadonlySet<string> } | undefined>(undefined);
    const activeRead = React.useRef<AbortController | undefined>(undefined);
    const selection = React.useRef(props.selectedId);
    const location = React.useRef(props.locationKey);
    location.current = props.locationKey;
    selection.current = props.selectedId;
    const latest = React.useRef(props);
    latest.current = props;
    const attempt = React.useRef<{ scopePath: string; requestId: string } | undefined>(undefined);
    useFocusEffect(
        React.useCallback(() => {
            focus.current++;
            return () => {
                focus.current++;
            };
        }, []),
    );
    React.useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            epoch.current++;
            reading.current = false;
            refreshRequested.current = undefined;
            refreshExplicit.current = false;
            activeRead.current?.abort();
        };
    }, []);
    React.useEffect(() => {
        // Known folder definitions are already available from the project. Keep
        // them current even when lazy history is folded and does no network I/O.
        if (activeRead.current) {
            const old = activeRead.current;
            activeRead.current = undefined;
            epoch.current++;
            reading.current = false;
            setLoading(false);
            refreshRequested.current = undefined;
            refreshExplicit.current = false;
            old.abort();
        }
        const pathsChanged = groups.length !== knownScopes.length || knownScopes.some(scope => !groups.some(group => group.scopePath === scope.scopePath));
        if (pathsChanged) {
            complete.current = false;
            setCountsComplete(false);
            cache.delete(props.scopeKey);
        }
        setGroups(previous => {
            const next = knownScopes.map(scope => {
                const old = previous.find(group => group.scopePath === scope.scopePath);
                return !old ? scope : old.title === scope.title ? old : { ...old, title: scope.title };
            });
            if (next.length === previous.length && next.every((group, index) => group === previous[index])) return previous;
            if (complete.current) cache.set(props.scopeKey, next);
            return next;
        });
    }, [scopeIdentity, props.scopeKey]);
    const read = React.useCallback(
        async (scopePath?: string, cursor?: ConversationGroup['nextCursor'], fresh = !scopePath, explicit = false) => {
            if (!path || !props.desktop || props.offline || isReadOnlyProjectPreview()) return;
            if (!explicit) return;
            if (reading.current || opening.current) {
                if (!scopePath) {
                    refreshRequested.current = refreshRequested.current === true || fresh;
                    refreshExplicit.current ||= explicit;
                }
                return;
            }
            reading.current = true;
            const request = ++epoch.current,
                account = getRuntimeAccountSelection();
            const controller = new AbortController();
            activeRead.current = controller;
            const current = () => alive.current && epoch.current === request && !controller.signal.aborted && getRuntimeAccountSelection() === account;
            let rejectRead!: () => void;
            const interrupted = new Promise<never>((_resolve, reject) => {
                rejectRead = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', rejectRead, { once: true });
            });
            // One deadline covers catalog retrieval, local decryption and group
            // resolution, including healthy large catalogs. Retry is user-driven.
            const timer = setTimeout(() => controller.abort(new Error(t('errors.connectionTimeout'))), READ_TIMEOUT_MS);
            setLoading(true);
            setProgress(undefined);
            setError(undefined);
            try {
                await Promise.race([(async () => {
                    const catalog = await loadProjectConversationCandidates(machineId, path, {
                        refresh: fresh, signal: controller.signal,
                        onProgress: value => { if (current()) setProgress(value); },
                    });
                    if (!current()) return;
                    setProgress({ phase: 'grouping', processed: 0, total: 0 });
                    // A cursor belongs to the snapshot that produced the current
                    // groups. A renewed/evicted catalog needs a complete replacement.
                    const pageScope = scopePath && catalog.catalogSnapshotId === catalogSnapshot.current?.id ? scopePath : undefined;
                    const input = { projectPath: path, ...catalog, ...(pageScope ? { scopePath: pageScope, cursor } : {}) };
                    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 512 * 1024)
                        throw new Error('Complete project history exceeds the request size limit');
                    const result = GoalProjectConversationsSchema.parse(await projectGoalRequest(machineId, 'goalProjectConversations', input, `${props.scopeKey}:${request}`));
                    if (!current()) return;
                    if (result.projectPath !== path) throw new Error('Project conversation scope changed');
                    const definitions = projectScopes(latest.current.project);
                    const defined = new Map(definitions.map(scope => [scope.scopePath, scope]));
                    const pages = result.groups.filter(group => defined.has(group.scopePath))
                        .map(group => ({ ...group, title: defined.get(group.scopePath)!.title }));
                    const catalogIds = new Set(catalog.candidates.map(candidate => candidate.sessionId));
                    catalogSnapshot.current = { id: catalog.catalogSnapshotId, ids: catalogIds };
                    complete.current = true;
                    setCountsComplete(true);
                    setGroups((previous) => {
                        const next: ConversationGroup[] = pageScope
                            ? previous.map((g) => {
                                  const page = pages.find((p) => p.scopePath === g.scopePath);
                                  return page
                                      ? {
                                            ...page,
                                            sessions: [...new Map([...g.sessions, ...page.sessions].map((s) => [s.sessionId, s])).values()],
                                        }
                                      : g;
                              })
                            : definitions.map(scope => pages.find(page => page.scopePath === scope.scopePath) ?? scope);
                        const merged = next.map(group => {
                            const rows = new Map(group.sessions.map(row => [row.sessionId, row]));
                            const authoritativePage = pages.find(page => page.scopePath === group.scopePath);
                            const suppliedIds = new Set(authoritativePage?.sessions.map(row => row.sessionId));
                            const replacedTotal = !pageScope || group.scopePath === pageScope && !!authoritativePage;
                            let additional = 0;
                            for (const [id, created] of locallyCreated.current) {
                                if (created.scopePath !== group.scopePath) continue;
                                if (suppliedIds.has(id)) {
                                    locallyCreated.current.delete(id);
                                    continue;
                                }
                                if (!rows.has(id)) rows.set(id, created.row);
                                // The complete catalog may already count an ID not
                                // present on this group's currently loaded page.
                                if (replacedTotal && !catalogIds.has(id)) additional++;
                            }
                            return { ...group, total: group.total + additional, sessions: [...rows.values()] };
                        });
                        cache.set(props.scopeKey, merged);
                        if (cache.size > 30) cache.delete(cache.keys().next().value!);
                        return merged;
                    });
                })(), interrupted]);
            } catch (e) {
                if (alive.current && epoch.current === request && !(controller.signal.aborted && controller.signal.reason?.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e));
            } finally {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', rejectRead);
                if (activeRead.current === controller) activeRead.current = undefined;
                if (epoch.current === request) {
                    reading.current = false;
                    if (alive.current) setLoading(false);
                    if (controller.signal.aborted && !refreshExplicit.current) refreshRequested.current = undefined;
                    else if (alive.current && !opening.current) flushQueuedRead();
                }
            }
        },
        [path, machineId, props.offline, props.scopeKey, props.desktop],
    );
    reread.current = (fresh, explicit) => {
        void read(undefined, undefined, fresh, explicit);
    };
    React.useEffect(() => {
        const wasVisible = historyVisibility.current;
        historyVisibility.current = hasExpandedScope;
        if (wasVisible && !hasExpandedScope) {
            if (!refreshExplicit.current) refreshRequested.current = undefined;
            activeRead.current?.abort();
        }
        // Expansion and ordinary project file changes never start an account
        // traversal. Only an explicit history/refresh action may do that work.
    }, [hasExpandedScope]);
    const cancelHistory = () => {
        const controller = activeRead.current;
        activeRead.current = undefined;
        epoch.current++;
        reading.current = false;
        refreshRequested.current = undefined;
        refreshExplicit.current = false;
        setLoading(false);
        setProgress(undefined);
        controller?.abort();
    };
    const loadingLabel = progress?.phase === 'grouping' ? w.grouping
        : progress && progress.total > 0
            ? `${w.load} ${Math.min(99, Math.floor(progress.processed / progress.total * 100))}%`
            : w.load;
    const create = async (scopePath: string) => {
        if (!props.desktop || opening.current || props.offline || !canCreateProjectConversation()) return;
        opening.current = true;
        setCreating(scopePath);
        setError(undefined);
        const account = getRuntimeAccountSelection(),
            selected = selection.current,
            requestedLocation = location.current,
            focused = focus.current;
        const current = () =>
            alive.current &&
            account === getRuntimeAccountSelection() &&
            focus.current === focused &&
            selection.current === selected &&
            location.current === requestedLocation;
        if (attempt.current?.scopePath !== scopePath)
            attempt.current = { scopePath, requestId: `goal-navigation-${Date.now()}-${Math.random().toString(36).slice(2)}` };
        try {
            const result = await machineStartGoalAuthor(machineId, { scopePath, requestId: attempt.current.requestId, agent: props.agent });
            if (result.type !== 'success')
                throw new Error(result.type === 'error' ? result.errorMessage : t('projectGoals.sessionUnavailable'));
            if (!current()) return;
            attempt.current = undefined;
            const row: ConversationGroup['sessions'][number] = {
                sessionId: result.sessionId, title: w.create, directory: scopePath, updatedAt: Date.now(), executed: false,
            };
            locallyCreated.current.set(result.sessionId, { scopePath, row });
            setGroups((previous) => {
                const next = previous.map((g) =>
                    g.scopePath === scopePath
                        ? {
                              ...g,
                              total: g.total + (g.sessions.some((s) => s.sessionId === result.sessionId) || catalogSnapshot.current?.ids.has(result.sessionId) ? 0 : 1),
                              sessions: [
                                  g.sessions.find(session => session.sessionId === result.sessionId) ?? row,
                                  ...g.sessions.filter((s) => s.sessionId !== result.sessionId),
                              ],
                          }
                        : g,
                );
                if (complete.current) cache.set(props.scopeKey, next);
                return next;
            });
            setFilter('all');
            setExpanded(scopePath, true);
            latest.current.onSelect({ scopePath, sessionId: result.sessionId });
        } catch (e) {
            if (current()) setError(e instanceof Error ? e.message : String(e));
        } finally {
            opening.current = false;
            if (alive.current) {
                setCreating(undefined);
                if (!reading.current) flushQueuedRead();
            }
        }
    };
    const modeled = React.useMemo(() => {
        const ids = new Set(
            [...groups.flatMap((g) => g.sessions.map((s) => s.sessionId)), ...Object.keys(headers)].filter(isProjectSessionDeleted),
        );
        return buildProjectConversationGroups(groups, headers, unread, connected, machineId, ids);
    }, [groups, headers, unread, connected, machineId, deletionRevision]);
    const allRows = modeled.flatMap((g) => g.rows),
        total = modeled.reduce((n, g) => n + g.total, 0);
    const attention = allRows.filter((r) => ['attention', 'failed', 'unread'].includes(r.status)).length,
        running = allRows.filter((r) => r.status === 'running').length;
    const filtered = modeled.map((g) => ({
        ...g,
        visible: g.rows.filter(
            (r) =>
                (filter === 'all' ||
                    (filter === 'running' && r.status === 'running') ||
                    (filter === 'attention' && ['attention', 'failed', 'unread'].includes(r.status))),
        ),
    }));
    const filterCount = (value: typeof filter) => !countsComplete ? '—' : value === 'all' ? total : value === 'attention' ? attention : running;
    const color = (status: ConversationStatus) =>
        status === 'attention'
            ? theme.colors.permission.bypass
            : status === 'failed'
              ? theme.colors.textDestructive
              : status === 'completed'
                ? theme.colors.success
                : status === 'running' || status === 'unread'
                  ? theme.colors.textLink
                  : theme.colors.textSecondary;
    const sidebar =
        props.desktop && path && !isReadOnlyProjectPreview() ? (
            <View style={styles.area} testID="project-conversation-navigation">
                <View style={styles.summary}>
                    <View style={styles.line}>
                        <Ionicons name="folder-outline" size={17} color={theme.colors.textLink} />
                        <Text style={styles.title}>{props.project?.title}</Text>
                        <View style={{ flex: 1 }} />
                        <ConversationButton
                            variant="toolbar"
                            label={w.refresh}
                            testID="project-conversations-refresh"
                            disabled={loading || props.offline}
                            onPress={() => {
                                void read(undefined, undefined, true, true);
                            }}
                        >
                            <Ionicons name="refresh-outline" size={15} color={theme.colors.textSecondary} />
                        </ConversationButton>
                    </View>
                    <Text selectable accessibilityLabel={path} style={styles.path}>
                        {path.includes('/projects/') ? path.slice(path.lastIndexOf('/projects/') + 1) : path}
                    </Text>
                    <Text style={styles.meta}>
                        {groups.length
                            ? `${countsComplete ? total : '—'} ${w.conversations} · ${Math.max(0, groups.length - 1)} ${w.features}`
                            : loading
                              ? w.load
                              : '—'}
                    </Text>
                    <View style={styles.filters}>
                        {(['all', 'attention', 'running'] as const).map((f) => (
                            <ConversationButton
                                key={f}
                                variant="toolbar"
                                label={`${w[f]} ${filterCount(f)}`}
                                selected={filter === f}
                                testID={`project-conversations-filter-${f}`}
                                onPress={() => setFilter(f)}
                            >
                                <Text
                                    style={[
                                        styles.small,
                                        {
                                            color:
                                                f === 'attention'
                                                    ? theme.colors.permission.bypass
                                                    : f === 'running'
                                                      ? theme.colors.textLink
                                                      : theme.colors.text,
                                        },
                                    ]}
                                >
                                    {w[f]} {filterCount(f)}
                                </Text>
                            </ConversationButton>
                        ))}
                    </View>
                    {!countsComplete && !loading && <View style={styles.line}>
                        <Text style={[styles.meta, { flex: 1 }]}>{w.synced}</Text>
                        <ConversationAction label={w.loadHistory} icon="download-outline"
                            testID="project-conversations-load-history" disabled={props.offline}
                            onPress={() => { void read(undefined, undefined, false, true); }} />
                    </View>}
                </View>
                {props.offline && <Text style={styles.notice}>{w.offline}</Text>}
                {error && (
                    <View style={styles.errorBox}>
                        <Text accessibilityRole="alert" style={styles.error}>
                            {error}
                        </Text>
                        <ConversationButton
                            label={w.retry}
                            disabled={loading || props.offline}
                            onPress={() => {
                                void read(undefined, undefined, true, true);
                            }}
                        >
                            <Text style={styles.link}>{w.retry}</Text>
                        </ConversationButton>
                    </View>
                )}
                {loading && <View style={styles.loading}>
                    <ActivityIndicator size="small" color={theme.colors.textLink} accessibilityLabel={loadingLabel} />
                    <Text style={[styles.meta, { flex: 1 }]}>{loadingLabel}</Text>
                    <ConversationAction label={w.cancel} testID="project-conversations-cancel-history" onPress={cancelHistory} />
                </View>}
                <ScrollView style={styles.list} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    {filtered
                        .filter(g => filter === 'all' || g.visible.length > 0 || !!g.nextCursor)
                        .map(g => (
                            <View key={g.scopePath} style={styles.group} testID={`project-conversations-group-${g.scopePath}`}>
                                <ConversationTreeRow
                                    title={g.scopePath === path ? w.global : g.title}
                                    label={`${expanded(g.scopePath) ? w.closed : w.open} ${g.scopePath === path ? w.global : g.title} · ${g.scopePath}`}
                                    expanded={expanded(g.scopePath)}
                                    icon={g.scopePath === path ? 'compass-outline' : 'folder-outline'}
                                    badge={countsComplete ? <Text style={styles.small}>{g.total}</Text> : undefined}
                                    testID={`project-conversations-toggle-${g.scopePath}`}
                                    onPress={() => setExpanded(g.scopePath, !expanded(g.scopePath))}
                                    trailing={creating === g.scopePath ? <View style={styles.creating}><ActivityIndicator size="small" color={theme.colors.textLink} accessibilityLabel={w.create} /></View> : <ConversationAction
                                        label={`${g.scopePath === path ? w.global : g.title} · ${w.create}`}
                                        icon="add-outline" compact reveal
                                        testID={`project-conversations-new-${g.scopePath}`}
                                        disabled={!!creating || props.offline || !canCreateProjectConversation()}
                                        onPress={() => { void create(g.scopePath); }}
                                    />}
                                />
                                {expanded(g.scopePath) && <View>
                                    {g.visible.map(row => <ConversationTreeRow
                                        key={row.sessionId} title={row.title || w.sessions}
                                        label={`${row.title || w.sessions} · ${statusLabel(row.status, w)}`}
                                        icon="chatbubble-outline" depth={1} reserveDisclosure reveal
                                        selected={props.selectedId === row.sessionId}
                                        testID={`project-conversations-session-${row.sessionId}`}
                                        badge={<View style={styles.line}><Text style={{ color: color(row.status), fontSize: 10 }}>●</Text><Text style={styles.time}>{formatLastSeen(row.updatedAt)}</Text></View>}
                                        onPress={() => props.onSelect({ scopePath: g.scopePath, taskId: row.taskId, sessionId: row.sessionId })}
                                    />)}
                                    {!g.visible.length && <Text style={styles.empty}>
                                        {countsComplete ? (filter === 'all' ? w.empty : w.noResults) : w.unloaded}
                                    </Text>}
                                    {g.nextCursor && <View style={styles.historyAction}>
                                        <ConversationAction label={w.more} icon="chevron-down-outline" disabled={loading || props.offline}
                                            onPress={() => { void read(g.scopePath, g.nextCursor, false, true); }} />
                                    </View>}
                                </View>}
                            </View>
                        ))}
                    {countsComplete && !loading && !error && !filtered.some((g) => g.visible.length) && filter !== 'all' && (
                        <Text style={styles.empty}>{w.noResults}</Text>
                    )}
                </ScrollView>
                <Text style={styles.notice}>{w.counts}</Text>
            </View>
        ) : null;
    return <Context.Provider value={sidebar}>{props.children}</Context.Provider>;
}
const styles = StyleSheet.create((theme) => ({
    area: { flex: 1, minHeight: 0 },
    summary: {
        paddingHorizontal: 14,
        paddingTop: 6,
        paddingBottom: 10,
        gap: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    line: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
    title: { fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
    path: { fontSize: 10, lineHeight: 16, color: theme.colors.textSecondary, ...Typography.mono() },
    meta: { fontSize: 11, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    small: { fontSize: 11, lineHeight: 17, color: theme.colors.textSecondary, ...Typography.default() },
    time: { fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() },
    filters: { flexDirection: 'row', gap: 2, flexWrap: 'wrap' },
    loading: { padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
    list: { flex: 1, minHeight: 0 },
    content: { paddingVertical: 6, paddingBottom: 12 },
    group: { minWidth: 0 },
    historyAction: { paddingLeft: 42, alignItems: 'flex-start' },
    creating: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
    link: { fontSize: 12, color: theme.colors.textLink, ...Typography.default() },
    notice: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        fontSize: 10,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    empty: { paddingVertical: 6, paddingLeft: 70, paddingRight: 12, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    errorBox: { padding: 12, gap: 6 },
    error: { fontSize: 12, color: theme.colors.textDestructive },
}));
