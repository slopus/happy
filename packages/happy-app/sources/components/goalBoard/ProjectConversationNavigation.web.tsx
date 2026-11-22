import * as React from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GoalProjectConversationsSchema } from '@slopus/happy-wire';
import { storage } from '@/sync/storage';
import { loadProjectConversationCandidates } from '@/sync/projectConversationCandidates.web';
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
              search: '搜索已加载会话或子项目',
              empty: '还没有会话',
              noResults: '已加载的会话中没有匹配结果',
              create: '新建会话',
              first: '开启第一个会话',
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
              counts: '状态与搜索覆盖已加载会话，可加载更多历史',
              retry: '重试',
              load: '加载历史…',
              unloaded: '历史尚未加载',
              closed: '收起',
              open: '展开',
          }
        : {
              sessions: 'Sessions',
              all: 'All',
              attention: 'Needs action',
              running: 'Running',
              global: 'Global conversations',
              search: 'Search loaded sessions or features',
              empty: 'No conversations yet',
              noResults: 'No matches in loaded conversations',
              create: 'New conversation',
              first: 'Start the first conversation',
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
              counts: 'Search and activity cover loaded sessions; load more history to continue',
              retry: 'Retry',
              load: 'Loading history…',
              unloaded: 'History has not loaded',
              closed: 'Collapse',
              open: 'Expand',
          };
// Only complete history results enter this cache. Project scopes can render
// before the account's detached metadata catalog finishes decrypting.
const cache = new Map<string, ConversationGroup[]>();
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
    const [groups, setGroups] = React.useState<ConversationGroup[]>(() => cache.get(props.scopeKey) ?? projectScopes(props.project));
    const [countsComplete, setCountsComplete] = React.useState(() => cache.has(props.scopeKey));
    const complete = React.useRef(countsComplete);
    // Keep creations newer than a read's immutable snapshot until that snapshot
    // explicitly accounts for their IDs. Reading and creation are independent.
    const locallyCreated = React.useRef(new Map<string, { scopePath: string; row: ConversationGroup['sessions'][number] }>());
    const [loading, setLoading] = React.useState(false),
        [error, setError] = React.useState<string>(),
        [creating, setCreating] = React.useState<string>();
    const [query, setQuery] = React.useState(''),
        [filter, setFilter] = React.useState<'all' | 'attention' | 'running'>('all'),
        [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
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
        reread = React.useRef<((fresh: boolean) => void) | undefined>(undefined);
    const catalogSnapshot = React.useRef<{ id: string; ids: ReadonlySet<string> } | undefined>(undefined);
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
        };
    }, []);
    const read = React.useCallback(
        async (scopePath?: string, cursor?: ConversationGroup['nextCursor'], fresh = !scopePath) => {
            if (!path || !props.desktop || props.offline || isReadOnlyProjectPreview()) return;
            if (reading.current || opening.current) {
                if (!scopePath) refreshRequested.current = refreshRequested.current === true || fresh;
                return;
            }
            reading.current = true;
            const request = ++epoch.current,
                account = getRuntimeAccountSelection();
            setLoading(true);
            setError(undefined);
            try {
                const catalog = await loadProjectConversationCandidates(machineId, path, { refresh: fresh });
                if (!alive.current || epoch.current !== request || getRuntimeAccountSelection() !== account) return;
                // A cursor belongs to the snapshot that produced the current
                // groups. A renewed/evicted catalog needs a complete replacement.
                const pageScope = scopePath && catalog.catalogSnapshotId === catalogSnapshot.current?.id ? scopePath : undefined;
                const input = { projectPath: path, ...catalog, ...(pageScope ? { scopePath: pageScope, cursor } : {}) };
                if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 512 * 1024)
                    throw new Error('Complete project history exceeds the request size limit');
                const result = GoalProjectConversationsSchema.parse(await projectGoalRequest(machineId, 'goalProjectConversations', input));
                if (!alive.current || epoch.current !== request || getRuntimeAccountSelection() !== account) return;
                if (result.projectPath !== path) throw new Error('Project conversation scope changed');
                const catalogIds = new Set(catalog.candidates.map(candidate => candidate.sessionId));
                catalogSnapshot.current = { id: catalog.catalogSnapshotId, ids: catalogIds };
                complete.current = true;
                setCountsComplete(true);
                setGroups((previous) => {
                    const next: ConversationGroup[] = pageScope
                        ? previous.map((g) => {
                              const page = result.groups.find((p) => p.scopePath === g.scopePath);
                              return page
                                  ? {
                                        ...page,
                                        sessions: [...new Map([...g.sessions, ...page.sessions].map((s) => [s.sessionId, s])).values()],
                                    }
                                  : g;
                          })
                        : result.groups;
                    const merged = next.map(group => {
                        const rows = new Map(group.sessions.map(row => [row.sessionId, row]));
                        const authoritativePage = result.groups.find(page => page.scopePath === group.scopePath);
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
            } catch (e) {
                if (alive.current && epoch.current === request) setError(e instanceof Error ? e.message : String(e));
            } finally {
                reading.current = false;
                if (alive.current && epoch.current === request) setLoading(false);
                if (alive.current && !opening.current && refreshRequested.current !== undefined) {
                    const fresh = refreshRequested.current;
                    refreshRequested.current = undefined;
                    reread.current?.(fresh);
                }
            }
        },
        [path, machineId, props.offline, props.scopeKey, props.desktop],
    );
    reread.current = fresh => {
        void read(undefined, undefined, fresh);
    };
    React.useEffect(() => {
        // Initial revisions often arrive while a cold catalog is decrypting.
        // Reaggregate that completed snapshot instead of scanning it twice.
        void read(undefined, undefined, !reading.current);
    }, [read, props.revision]);
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
            setQuery('');
            setCollapsed((old) => {
                const next = new Set(old);
                next.delete(scopePath);
                return next;
            });
            latest.current.onSelect({ scopePath, sessionId: result.sessionId });
        } catch (e) {
            if (current()) setError(e instanceof Error ? e.message : String(e));
        } finally {
            opening.current = false;
            if (alive.current) {
                setCreating(undefined);
                if (!reading.current && refreshRequested.current !== undefined) {
                    const fresh = refreshRequested.current;
                    refreshRequested.current = undefined;
                    reread.current?.(fresh);
                }
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
                    (filter === 'attention' && ['attention', 'failed', 'unread'].includes(r.status))) &&
                (!query || `${g.title} ${g.scopePath} ${r.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
        ),
    }));
    const matchingGroup = (group: ConversationGroup) => !!query && `${group.title} ${group.scopePath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
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
    const relative = (p: string) => (path && p.startsWith(path + '/') ? p.slice(path.length + 1) : p === path ? '.' : p);
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
                                void read();
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
                </View>
                <View style={styles.search}>
                    <Ionicons name="search-outline" size={15} color={theme.colors.textSecondary} />
                    <TextInput
                        accessibilityLabel={w.search}
                        placeholder={w.search}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={query}
                        onChangeText={setQuery}
                        style={styles.input}
                        testID="project-conversations-search"
                    />
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
                                void read();
                            }}
                        >
                            <Text style={styles.link}>{w.retry}</Text>
                        </ConversationButton>
                    </View>
                )}
                {loading && <ActivityIndicator size="small" color={theme.colors.textLink} accessibilityLabel={w.load} />}
                <ScrollView style={styles.list} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    {filtered
                        .filter(
                            (g) =>
                                (filter === 'all' && !query) ||
                                (!!query && !!g.nextCursor) ||
                                g.visible.length > 0 ||
                                matchingGroup(g),
                        )
                        .map((g) => (
                            <View key={g.scopePath} style={styles.group} testID={`project-conversations-group-${g.scopePath}`}>
                                <View style={styles.line}>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <ConversationButton
                                            variant="toolbar"
                                            label={`${collapsed.has(g.scopePath) ? w.open : w.closed} ${g.scopePath === path ? w.global : g.title}`}
                                            expanded={!collapsed.has(g.scopePath)}
                                            onPress={() =>
                                                setCollapsed((old) => {
                                                    const next = new Set(old);
                                                    next.has(g.scopePath) ? next.delete(g.scopePath) : next.add(g.scopePath);
                                                    return next;
                                                })
                                            }
                                        >
                                            <Ionicons
                                                name={collapsed.has(g.scopePath) ? 'chevron-forward' : 'chevron-down'}
                                                size={12}
                                                color={theme.colors.textSecondary}
                                            />
                                            <Ionicons
                                                name={g.scopePath === path ? 'compass-outline' : 'folder-outline'}
                                                size={15}
                                                color={theme.colors.textLink}
                                            />
                                            <Text numberOfLines={1} style={styles.groupTitle}>
                                                {g.scopePath === path ? w.global : g.title}
                                            </Text>
                                            <Text style={styles.small}>{countsComplete ? g.total : '—'}</Text>
                                        </ConversationButton>
                                    </View>
                                    <ConversationButton
                                        variant="toolbar"
                                        label={`${g.scopePath === path ? w.global : g.title} · ${w.create}`}
                                        reveal
                                        testID={`project-conversations-new-${g.scopePath}`}
                                        disabled={!!creating || props.offline || !canCreateProjectConversation()}
                                        onPress={() => {
                                            void create(g.scopePath);
                                        }}
                                    >
                                        {creating === g.scopePath ? (
                                            <ActivityIndicator size="small" color={theme.colors.textLink} />
                                        ) : (
                                            <Ionicons name="add-outline" size={17} color={theme.colors.textLink} />
                                        )}
                                    </ConversationButton>
                                </View>
                                <Text selectable style={styles.relative}>
                                    {relative(g.scopePath)}
                                </Text>
                                {!collapsed.has(g.scopePath) && (
                                    <View style={styles.rows}>
                                        {g.visible.map((row) => (
                                            <ConversationButton
                                                key={row.sessionId}
                                                reveal
                                                variant="row"
                                                label={`${row.title || w.sessions} · ${statusLabel(row.status, w)}`}
                                                selected={props.selectedId === row.sessionId}
                                                testID={`project-conversations-session-${row.sessionId}`}
                                                onPress={() =>
                                                    props.onSelect({ scopePath: g.scopePath, taskId: row.taskId, sessionId: row.sessionId })
                                                }
                                            >
                                                <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                                                    <View style={styles.line}>
                                                        <Text numberOfLines={2} style={[styles.rowTitle, { flex: 1 }]}>
                                                            {row.title || w.sessions}
                                                        </Text>
                                                        {props.selectedId === row.sessionId && (
                                                            <Text style={styles.current}>{w.current}</Text>
                                                        )}
                                                    </View>
                                                    <View style={styles.between}>
                                                        <Text style={[styles.small, { color: color(row.status) }]}>
                                                            ● {statusLabel(row.status, w)}
                                                        </Text>
                                                        <Text style={styles.time}>{formatLastSeen(row.updatedAt)}</Text>
                                                    </View>
                                                </View>
                                            </ConversationButton>
                                        ))}
                                        {!countsComplete && !g.visible.length && <Text style={styles.empty}>{error || props.offline ? w.unloaded : w.load}</Text>}
                                        {countsComplete && !g.visible.length && filter === 'all' && !query && (
                                            <View style={styles.empty}>
                                                <Text style={styles.meta}>{w.empty}</Text>
                                                <ConversationButton
                                                    variant="toolbar"
                                                    label={w.first}
                                                    reveal
                                                    disabled={!!creating || props.offline || !canCreateProjectConversation()}
                                                    onPress={() => {
                                                        void create(g.scopePath);
                                                    }}
                                                >
                                                    <Ionicons name="add-outline" size={15} color={theme.colors.textLink} />
                                                    <Text style={styles.link}>{w.first}</Text>
                                                </ConversationButton>
                                            </View>
                                        )}
                                        {g.nextCursor && (
                                            <ConversationButton
                                                variant="toolbar"
                                                label={w.more}
                                                disabled={loading || props.offline}
                                                onPress={() => {
                                                    void read(g.scopePath, g.nextCursor);
                                                }}
                                            >
                                                <Text style={styles.link}>{w.more}</Text>
                                            </ConversationButton>
                                        )}
                                    </View>
                                )}
                            </View>
                        ))}
                    {!filtered.some((g) => g.visible.length || matchingGroup(g)) && !!(query || filter !== 'all') && (
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
    between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
    title: { fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
    path: { fontSize: 10, lineHeight: 16, color: theme.colors.textSecondary, ...Typography.mono() },
    relative: { fontSize: 10, lineHeight: 16, color: theme.colors.textSecondary, marginLeft: 27, marginBottom: 5, ...Typography.mono() },
    meta: { fontSize: 11, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    small: { fontSize: 11, lineHeight: 17, color: theme.colors.textSecondary, ...Typography.default() },
    time: { fontSize: 10, color: theme.colors.textSecondary, ...Typography.default() },
    filters: { flexDirection: 'row', gap: 2, flexWrap: 'wrap' },
    search: {
        margin: 12,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    input: { flex: 1, minWidth: 0, fontSize: 12, color: theme.colors.text, ...Typography.default() },
    list: { flex: 1, minHeight: 0 },
    content: { paddingHorizontal: 8, paddingBottom: 16 },
    group: { gap: 3, marginBottom: 14 },
    groupTitle: { fontSize: 12, flexShrink: 1, color: theme.colors.text, ...Typography.default('semiBold') },
    rows: { marginLeft: 13, gap: 3 },
    rowTitle: { fontSize: 12, lineHeight: 18, color: theme.colors.text, ...Typography.default() },
    current: { fontSize: 10, color: theme.colors.textLink },
    link: { fontSize: 12, color: theme.colors.textLink, ...Typography.default() },
    notice: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        fontSize: 10,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    empty: { padding: 12, gap: 6, color: theme.colors.textSecondary, fontSize: 12 },
    errorBox: { padding: 12, gap: 6 },
    error: { fontSize: 12, color: theme.colors.textDestructive },
}));
