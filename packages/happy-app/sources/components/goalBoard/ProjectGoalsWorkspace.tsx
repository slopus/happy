import * as React from 'react';
import { ActivityIndicator, Modal as RNModal, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalArtifact, GoalBoardCatalogEntry, GoalProject, GoalTask, GoalTaskSession } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storage, useAllMachines, useLocalSetting, useMachine, useSocketStatus } from '@/sync/storage';
import { getRuntimeAccountSelection, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useReducedTransparency } from '@/hooks/useReducedTransparency';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName } from '@/utils/sessionUtils';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { machineStartGoalAuthor, type DirectoryEntry } from '@/sync/ops';
import { loadGoalProjects, loadProjectGoalBoard, loadProjectTaskHistory, launchProjectGoalTask, projectGoalRequest, projectTaskFiles, taskApproval, taskCanExecute, projectTaskExecutionAttempted, markProjectTaskExecutionAttempt, clearUndispatchedProjectTaskAttempt, ProjectGoalLaunchError, type ProjectBoardData, type ProjectHistoryCursor, isReadOnlyProjectPreview, type ProjectHistoryCandidate } from '@/sync/projectGoals';
import { SessionView } from '@/-session/SessionView';
import { SessionFileWorkspaceProvider } from '@/components/fileWorkspace/SessionFileWorkspaceProvider';
import { FileWorkspace, FileWorkspaceResizeHandle } from '@/components/fileWorkspace/FileWorkspace';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { WorkspaceDirectoryTree } from '@/components/fileWorkspace/WorkspaceDirectoryTree';
import { getProjectChatWidth, getProjectChatMaximumWidth, projectPanelGap } from './projectWorkspaceLayout';
import { ProjectTaskSwitcher } from './ProjectTaskSwitcher';
import { ProjectTaskDetails } from './ProjectTaskDetails';
import { ProjectTaskStatus } from './ProjectTaskStatus';
import { PanelTabs } from '@/components/PanelTabs';
import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { GoalBoardCard } from './GoalBoardCard';
import { RunningTaskBorder } from './RunningTaskBorder';
import { ProjectGallery } from './ProjectGallery';
import { canCreateProjectConversation, canConfirmProjectDeliverable, openProjectGoalConversation } from '@/sync/projectGoals';
import { getProjectPreviewMachineId } from '@/sync/projectGoals';
import { projectCatalogState, selectProjectMachine } from './projectMachine';
import { useProjectNavigation } from './useProjectNavigation';

const requestId = () => `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function accountKey() { const a = getRuntimeAccountSelection(); return JSON.stringify([a?.key, a?.generation, a?.serverUrl]); }

function useProjectTaskHistory(machineId: string, featurePath: string, taskId: string) {
    const machine = useMachine(machineId);
    // The account store already decrypted these real session headers. Send only
    // candidates from this machine; the reader canonicalizes and authorizes paths.
    const candidateRevision = storage(state => isReadOnlyProjectPreview() ? Object.values(state.sessions)
        .filter(session => session.metadata?.machineId === machineId && (/goal-first-ops/.test(session.metadata.path) || session.metadata.goalBoard))
        .map(session => `${session.id}:${session.updatedAt}:${session.metadata?.path}`).sort().join('|') : '');
    const key = JSON.stringify([accountKey(), machineId, featurePath, taskId]);
    const context = React.useRef(key); context.current = key;
    const epoch = React.useRef(0);
    const [state, setState] = React.useState<{ key: string; sessions: GoalTaskSession[]; loaded: boolean; nextCursor?: ProjectHistoryCursor }>({ key, sessions: [], loaded: false });
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const read = React.useCallback(async (cursor?: ProjectHistoryCursor) => {
        const request = ++epoch.current;
        setLoading(true); setError(null);
        try {
            const candidates: ProjectHistoryCandidate[] | undefined = isReadOnlyProjectPreview() ? Object.values(storage.getState().sessions)
                .filter(session => session.metadata?.machineId === machineId && (/goal-first-ops/.test(session.metadata.path) || session.metadata.goalBoard))
                .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 250)
                .map(session => ({ sessionId: session.id, title: getSessionName(session).slice(0, 4000), directory: session.metadata!.path,
                    updatedAt: session.updatedAt, executed: (session.seq ?? 0) > 1, active: session.active,
                    featurePath: session.metadata?.goalBoard?.featurePath, taskId: session.metadata?.goalBoard?.taskId })) : undefined;
            const page = await loadProjectTaskHistory(machineId, featurePath, taskId, cursor, candidates);
            if (context.current !== key || epoch.current !== request) return;
            setState(previous => {
                const merged = new Map((previous.key === key ? previous.sessions : []).map(session => [session.sessionId, session]));
                for (const session of page.sessions) merged.set(session.sessionId, session);
                return { key, loaded: true, sessions: [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId)),
                    nextCursor: !cursor && previous.key === key && previous.sessions.length > 25 ? previous.nextCursor : page.nextCursor };
            });
        } catch (error) { if (context.current === key && epoch.current === request) setError(error instanceof Error ? error.message : String(error)); }
        finally { if (context.current === key && epoch.current === request) setLoading(false); }
    }, [machineId, featurePath, taskId, key, candidateRevision]);
    const invalidation = (machine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    React.useEffect(() => { void read(); return () => { epoch.current++; }; }, [read, invalidation]);
    return { sessions: state.key === key ? state.sessions : [], nextCursor: state.key === key ? state.nextCursor : undefined, ready: state.key === key && state.loaded, loading, error, read };
}

function useProjectData(machineId: string, featurePath?: string) {
    const machine = useMachine(machineId);
    const socket = useSocketStatus();
    const owner = JSON.stringify([accountKey(), machineId]);
    const [projects, setProjects] = React.useState<{ owner: string; values: GoalProject[] } | null>(null);
    const [board, setBoard] = React.useState<{ owner: string; data: ProjectBoardData } | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const context = React.useRef({ owner, featurePath, machineId });
    context.current = { owner, featurePath, machineId };
    const generation = React.useRef(0);
    const refresh = React.useCallback(async () => {
        const captured = context.current;
        const epoch = ++generation.current;
        if (!captured.machineId) return;
        setLoading(true); setError(null);
        try {
            const [projects, board] = await Promise.all([
                loadGoalProjects(captured.machineId),
                captured.featurePath ? loadProjectGoalBoard(captured.machineId, captured.featurePath) : Promise.resolve(null),
            ]);
            if (context.current.owner !== captured.owner || epoch !== generation.current || !accountRuntimeCurrent()) return;
            setProjects({ owner: captured.owner, values: projects });
            setBoard(board ? { owner: JSON.stringify([captured.owner, captured.featurePath]), data: board } : null);
        } catch (error) {
            if (context.current.owner === captured.owner && epoch === generation.current) setError(error instanceof Error ? error.message : String(error));
        } finally { if (epoch === generation.current) setLoading(false); }
    }, []);
    const invalidation = (machine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    const terminal = storage(state => Object.values(state.sessions)
        .filter(session => session.metadata?.machineId === machineId && session.metadata.path.startsWith(featurePath ?? '\0'))
        .map(session => `${session.id}:${session.agentState?.turnStatus?.status}:${session.agentState?.turnStatus?.updatedAt}`).sort().join('|'));
    React.useEffect(() => {
        if (machineId && socket.status === 'connected' && machine && isMachineOnline(machine)) void refresh();
        return () => { generation.current++; };
    }, [owner, featurePath, socket.status, machine?.active, invalidation, terminal, refresh]);
    return {
        projects: projects?.owner === owner ? projects.values : [],
        board: board?.owner === JSON.stringify([owner, featurePath]) ? board.data : null,
        loading, error, refresh, offline: !machine || !isMachineOnline(machine), loaded: projects?.owner === owner,
        status: projectCatalogState({ connected: socket.status === 'connected', online: !!machine && isMachineOnline(machine),
            loading, loaded: projects?.owner === owner, error }),
    };
}

export function ProjectGoalsWorkspace() {
    const params = useLocalSearchParams<{ machine?: string; project?: string; feature?: string; task?: string; conversation?: string; author?: string }>();
    const router = useRouter();
    const navigation = useProjectNavigation(params, values => router.setParams(values));
    const machines = useAllMachines({ includeOffline: true });
    const draftMachine = useNewSessionDraft(state => state.selectedMachineId);
    const selectedMachine = selectProjectMachine(machines, params.machine, draftMachine, getProjectPreviewMachineId());
    const machineId = selectedMachine?.id ?? '';
    // Account/machine switches remount the archive owner, so stale async work cannot navigate the new account.
    return <ProjectGoalsOwner key={JSON.stringify([accountKey(), machineId])} machineId={machineId} machines={machines} params={params}
        navigation={navigation} />;
}

function ProjectGoalsOwner({ machineId, machines, params, navigation }: {
    machineId: string; machines: ReturnType<typeof useAllMachines>;
    params: { project?: string; feature?: string; task?: string; conversation?: string; author?: string };
    navigation: ReturnType<typeof useProjectNavigation>;
}) {
    const { theme } = useUnistyles();
    const { navigate } = navigation;
    const data = useProjectData(machineId, params.feature);
    const readOnly = isReadOnlyProjectPreview();
    const [query, setQuery] = React.useState('');
    const [statusFilter, setStatusFilter] = React.useState<TaskStatusFilter>('all');
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [actionError, setActionError] = React.useState<string | null>(null);
    const [agent, setAgent] = React.useState<'codex' | 'claude'>(() => useNewSessionDraft.getState().agentType === 'claude' ? 'claude' : 'codex');
    const alive = React.useRef(true);
    const scope = JSON.stringify([machineId, params.project, params.feature]);
    const scopeRef = React.useRef(scope); scopeRef.current = scope;
    React.useEffect(() => { setQuery(''); setStatusFilter('all'); }, [scope]);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const project = data.projects.find(project => project.projectPath === params.project);
    const feature = data.board?.snapshot;
    const task = feature?.tasks.find(task => task.id === params.task);
    const skin = useLocalSetting('desktopSkinId');
    const reduced = useReducedTransparency();
    const surface = skin !== 'default' ? (reduced ? theme.colors.desktopSkin.readingSolid : theme.colors.desktopSkin.readingWide) : theme.colors.surface;
    const go = (values: Record<string, string | undefined>) => { setActionError(null); navigate({ conversation: undefined, author: undefined, ...values }); };
    const chooseProject = (project: GoalProject) => go({ project: project.projectPath, feature: project.features.length ? undefined : project.direct?.featurePath, task: undefined });
    const chooseFeature = (feature: GoalBoardCatalogEntry) => go({ feature: feature.featurePath, task: undefined });
    const organize = async () => {
        if (busy || !machineId || readOnly) return;
        const owner = accountKey();
        const requestedScope = scope;
        setBusy(true); setActionError(null);
        try {
            const result = await machineStartGoalAuthor(machineId, { scopePath: params.feature ?? params.project, requestId: requestId(), agent });
            if (!alive.current || accountKey() !== owner || scopeRef.current !== requestedScope) return;
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : 'Archive is unavailable');
            await ensureSessionHydratedWithRetry(result.sessionId);
            if (!alive.current || accountKey() !== owner || scopeRef.current !== requestedScope) return;
            storage.getState().updateSessionDraft(result.sessionId,
                `请使用 goal-first-ops 和 goal-first，帮我整理${params.feature ? '当前子项目的任务' : params.project ? '当前项目及子项目' : '一个新的项目'}。先通过对话对齐目标、最终交付与验收标准，给出只读草案让我确认，再更新档案。任务相互独立，不添加自动依赖执行。\n\n${params.feature ?? params.project ?? '从已安装的 Goal First 项目资料库开始。'}\n\n我的想法：`);
            navigate({ author: result.sessionId, conversation: undefined, task: undefined });
        } catch (error) { if (alive.current) setActionError(error instanceof Error ? error.message : String(error)); }
        finally { if (alive.current) setBusy(false); }
    };
    const tasks = feature?.tasks ?? [];
    const selectedMachine = machines.find(machine => machine.id === machineId);
    return <View style={[styles.page, { backgroundColor: surface }]} testID="project-goals-workspace">
        <View style={[styles.header, { backgroundColor: surface }]}>
            <View style={styles.line}>
                <Button variant="toolbar" label={t('common.back')} disabled={!navigation.canBack} onPress={navigation.back} testID="project-navigation-back"><Ionicons name="arrow-back" size={18} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('desktopWorkspace.forward')} disabled={!navigation.canForward} onPress={navigation.forward} testID="project-navigation-forward"><Ionicons name="arrow-forward" size={18} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('projectGoals.backProjects')} onPress={() => go({ project: undefined, feature: undefined, task: undefined })}>
                    <Ionicons name="folder-open-outline" size={17} color={theme.colors.textSecondary} /><Text style={styles.body}>{t('projectGoals.allProjects')}</Text>
                </Button>
                {project && <><Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} /><Button variant="toolbar" label={project.title} onPress={() => chooseProject(project)}><Text numberOfLines={1} style={styles.body}>{project.title}</Text></Button></>}
                {feature && feature.featurePath !== project?.projectPath && <><Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} /><Button variant="toolbar" label={feature.title} onPress={() => go({ task: undefined })}><Text numberOfLines={1} style={styles.body}>{feature.title}</Text></Button></>}
            </View>
            <View style={styles.line}>
                <Button variant="toolbar" label={t('projectGoals.chooseMachine')} disabled={readOnly} expanded={machineMenuOpen} onPress={() => setMachineMenuOpen(value => !value)} testID="project-machine-picker"><Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} /><Text numberOfLines={1} style={[styles.meta, { maxWidth: 200 }]}>{selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || t('projectGoals.machine')}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('projectGoals.refresh')} disabled={data.loading || !machineId || data.offline} onPress={() => { void data.refresh(); }} testID="project-goals-refresh"><Ionicons name="refresh-outline" size={17} color={theme.colors.textSecondary} /></Button>
                {readOnly && <Text style={styles.meta}>{t('projectGoals.realArchive')}</Text>}
                {!readOnly && <Button variant="toolbar" label={t('projectGoals.agent')} onPress={() => setAgent(value => value === 'codex' ? 'claude' : 'codex')}><Text style={styles.meta}>{agent === 'codex' ? 'Codex' : 'Claude'}</Text></Button>}
                <Button variant="toolbar" label={t(params.feature ? 'projectGoals.createTask' : 'projectGoals.createProject')} disabled={readOnly || busy || !machineId || data.offline} onPress={() => { void organize(); }} testID="project-goals-organize"><Ionicons name="sparkles-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t(params.feature ? 'projectGoals.createTask' : 'projectGoals.createProject')}</Text></Button>
            </View>
        </View>
        {machineMenuOpen && <>
            <Pressable style={styles.machineBackdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={() => setMachineMenuOpen(false)} />
            <ScrollView style={styles.machineMenu}>
                {machines.map(machine => <Button variant="toolbar" key={machine.id} selected={machineId === machine.id} label={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                    onPress={() => { setMachineMenuOpen(false); navigate({ machine: machine.id, project: undefined, feature: undefined, task: undefined, conversation: undefined, author: undefined }); }}>
                    <Text style={styles.meta}>{machine.metadata?.displayName || machine.metadata?.host || machine.id}{!isMachineOnline(machine) ? ` · ${t('projectGoals.offline')}` : ''}</Text>
                </Button>)}
            </ScrollView>
        </>}
        {(data.error || actionError) && <View style={styles.errorBar} accessibilityRole="alert"><Text style={styles.error}>{data.error || actionError}</Text></View>}
        {data.status === 'loading' && machineId && !data.loaded && <ActivityIndicator style={{ padding: 24 }} color={theme.colors.textSecondary} />}
        {!machineId ? <Empty text={t('projectGoals.noMachine')} /> : params.author ? <View style={[styles.author, { backgroundColor: surface }]}><Text style={[styles.meta, { padding: 12 }]}>{t('projectGoals.authoringHint')}</Text><SessionView key={params.author} id={params.author} embedded fullWidth /></View>
            : task && feature ? <TaskWorkspace key={JSON.stringify([machineId, feature.featurePath, task.id])} machineId={machineId} featurePath={feature.featurePath} task={task}
                featureTitle={feature.title} query={query} setQuery={setQuery} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
                allTasks={tasks} conversationId={params.conversation} agent={agent} offline={data.offline}
                refresh={data.refresh} selectTask={id => go({ task: id })} selectConversation={id => navigate({ conversation: id })} />
            : <ScrollView style={styles.catalog} contentContainerStyle={styles.catalogContent}>
                <CatalogHeading title={feature ? feature.title : project ? project.title : t('projectGoals.allProjects')} subtitle={feature ? `${tasks.length} ${t('projectGoals.tasks')}` : project ? project.summary || t('projectGoals.subprojects') : t('projectGoals.galleryDescription')} query={query} setQuery={setQuery} />
                {params.task && feature && !task && <Text style={styles.error}>{t('projectGoals.taskMissing')}</Text>}
                {feature ? <TaskCards tasks={tasks} query={query} status={statusFilter} setStatus={setStatusFilter} onSelect={id => go({ task: id })} />
                    : project ? <View style={styles.grid}>{[...(project.direct ? [project.direct] : []), ...project.features].filter(entry => entry.title.toLowerCase().includes(query.toLowerCase())).map(entry => <CatalogCard key={entry.featurePath} title={entry.featurePath === project.projectPath ? t('projectGoals.tasks') : entry.title} subtitle={entry.summary || t('projectGoals.showTasks')} onPress={() => chooseFeature(entry)} />)}</View>
                        : <><View style={styles.libraryHeading}><Text style={styles.sectionTitle}>{t('projectGoals.projectLibrary')}</Text><Text style={styles.meta}>{data.loaded ? data.projects.length : '—'}</Text></View><ProjectGallery projects={data.projects.filter(project => (project.title + (project.summary || '')).toLowerCase().includes(query.toLowerCase()))} onSelect={chooseProject} /></>}
                {data.status === 'connecting' && <Empty text={t('projectGoals.connecting')} />}
                {data.status === 'offline' && <Empty text={t('projectGoals.offlineArchive')} />}
                {data.status === 'ready' && !data.projects.length && <Empty text={t('projectGoals.emptyProjects')} />}
                {feature && !tasks.length && <Empty text={t('projectGoals.emptyTasks')} />}
            </ScrollView>}
    </View>;
}

function CatalogHeading({ title, subtitle, query, setQuery }: { title: string; subtitle: string; query: string; setQuery: (value: string) => void }) {
    const { theme } = useUnistyles();
    return <View style={styles.catalogHeading} testID="project-catalog-heading"><View style={{ gap: 8, flexShrink: 1 }}><Text accessibilityRole="header" style={styles.heading}>{title}</Text><Text style={styles.meta}>{subtitle}</Text></View>
        <TextInput style={styles.search} placeholder={t('projectGoals.search')} placeholderTextColor={theme.colors.input.placeholder} value={query} onChangeText={setQuery} accessibilityLabel={t('projectGoals.search')} /></View>;
}

type TaskStatusFilter = 'all' | GoalTask['status'];
function CatalogCard({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) {
    const { theme } = useUnistyles();
    return <GoalBoardCard style={styles.catalogCard}><Button variant="card" label={title} onPress={onPress}><View style={styles.catalogCardContent}><View style={styles.cardBody}><Ionicons name="folder-outline" size={24} color={theme.colors.textLink} /><Text numberOfLines={2} style={styles.cardTitle}>{title}</Text><Text numberOfLines={2} style={styles.meta}>{subtitle}</Text></View><Ionicons name="chevron-forward" size={15} color={theme.colors.textSecondary} /></View></Button></GoalBoardCard>;
}
function ApprovalTag({ task }: { task: GoalTask }) {
    const state = taskApproval(task);
    return <View style={[styles.tag, state === 'accepted' ? styles.acceptedTag : styles.pendingTag]}><Text style={[styles.tagText, state === 'accepted' ? styles.acceptedText : styles.pendingText]}>{t(state === 'accepted' ? 'projectGoals.accepted' : state === 'changed' ? 'projectGoals.changed' : state === 'noDeliverables' ? 'projectGoals.noDeliverables' : 'projectGoals.notReviewed')}</Text></View>;
}
function TaskCards({ tasks, query, status, setStatus, selectedId, onSelect, onAction, offline, busy, hideExecution }: {
    query: string; status: TaskStatusFilter; setStatus: (status: TaskStatusFilter) => void;
    tasks: GoalTask[]; selectedId?: string; onSelect: (id: string) => void; onAction?: (task: GoalTask, action: 'chat' | 'execute') => void; offline?: boolean; busy?: boolean; hideExecution?: boolean;
}) {
    const { theme } = useUnistyles();
    const statuses: GoalTask['status'][] = ['pending', 'running', 'review', 'done', 'blocked', ...(tasks.some(task => task.status === 'unknown') ? ['unknown' as const] : [])];
    const visible = tasks.filter(task => (status === 'all' || task.status === status) && (task.title + task.goal).toLowerCase().includes(query.toLowerCase()));
    return <View style={styles.taskBoard} testID="project-task-board">
        <View style={styles.taskFilters} testID="project-task-filters">
            {(['all', ...statuses] as const).map(value => <Button key={value} variant="chip" selected={status === value} label={value === 'all' ? t('goalBoard.allTasks') : t(`goalBoard.status.${value}`)} onPress={() => setStatus(value)} testID={`project-task-filter-${value}`}><Text style={status === value ? styles.link : styles.meta}>{value === 'all' ? t('goalBoard.allTasks') : t(`goalBoard.status.${value}`)}</Text><Text style={styles.taskNumber}>{value === 'all' ? tasks.length : tasks.filter(task => task.status === value).length}</Text></Button>)}
        </View>
        <View style={styles.grid}>{visible.map(task => <GoalBoardCard key={task.id} selected={selectedId === task.id} style={[styles.taskCard, task.status === 'running' && styles.runningCard]} testID={`project-task-card-${task.id}`}>
        <Button variant="card" selected={selectedId === task.id} label={task.title} onPress={() => onSelect(task.id)}>
            <View style={styles.taskCardContent}><View style={[styles.line, { justifyContent: 'space-between' }]}><View style={styles.line}><Text style={styles.taskNumber}>{task.code || `TASK ${String(tasks.indexOf(task) + 1).padStart(2, '0')}`}</Text><ProjectTaskStatus status={task.status} /></View><ApprovalTag task={task} /></View>
                <Text numberOfLines={2} style={styles.cardTitle}>{task.title}</Text><Text numberOfLines={2} style={styles.taskGoal}>{task.goal || task.title}</Text><View style={styles.taskDelivery}><Ionicons name="document-text-outline" size={13} color={theme.colors.textLink} /><Text numberOfLines={2} style={[styles.meta, { flex: 1 }]}>{task.expectedDeliverables.join(' · ') || t('projectGoals.noExpected')}</Text></View></View>
        </Button>
        {onAction && <View style={styles.cardActions}><Button variant="toolbar" label={t('projectGoals.openChat')} disabled={offline || busy || (isReadOnlyProjectPreview() && selectedId !== task.id)} onPress={() => onAction(task, 'chat')}><Ionicons name="chatbubble-outline" size={17} color={theme.colors.textSecondary} /></Button>
            {!isReadOnlyProjectPreview() && !hideExecution && taskCanExecute(task) && <Button variant="toolbar" label={t('projectGoals.execute')} disabled={offline || busy} onPress={() => onAction(task, 'execute')}><Ionicons name="play" size={17} color={theme.colors.textLink} /></Button>}</View>}
        <RunningTaskBorder active={task.status === 'running'} />
    </GoalBoardCard>)}</View>{!visible.length && <View style={styles.noFilteredTasks}><Text style={styles.meta}>{t('goalBoard.noMatches')}</Text></View>}
    </View>;
}

type TaskWorkspaceProps = { featureTitle: string; query: string; setQuery: (value: string) => void; statusFilter: TaskStatusFilter; setStatusFilter: (value: TaskStatusFilter) => void; machineId: string; featurePath: string; task: GoalTask; allTasks: GoalTask[]; conversationId?: string; agent: 'codex' | 'claude'; offline: boolean; refresh: () => Promise<void>; selectTask: (id: string) => void; selectConversation: (id: string) => void; };
function TaskWorkspace(props: TaskWorkspaceProps) {
    const { machineId, featurePath, task } = props;
    const binding = React.useMemo(() => projectTaskFiles(machineId, featurePath, task), [machineId, featurePath, task.id, task.indexPath]);
    return <SessionFileWorkspaceProvider sessionId={props.conversationId ?? ''} binding={binding}><TaskWorkspaceContent {...props} /></SessionFileWorkspaceProvider>;
}
function TaskWorkspaceContent(props: TaskWorkspaceProps) {
    const { task, machineId, featurePath, allTasks, selectTask, selectConversation, refresh, agent, offline } = props;
    const { theme } = useUnistyles();
    const workspace = useFileWorkspace()!;
    const readOnly = isReadOnlyProjectPreview();
    const taskHistory = useProjectTaskHistory(machineId, featurePath, task.id);
    const skin = useLocalSetting('desktopSkinId');
    const reduced = useReducedTransparency();
    const surface = skin !== 'default' ? (reduced ? theme.colors.desktopSkin.readingSolid : theme.colors.desktopSkin.readingWide) : theme.colors.surface;
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const { rightExpandedWidth } = useDesktopWorkspaceLayout();
    const [rowWidth, setRowWidth] = React.useState(0);
    const [tab, setTab] = React.useState('details');
    const [historyOpen, setHistoryOpen] = React.useState(false);
    const historyAnchor = React.useRef<View>(null);
    const [historyPosition, setHistoryPosition] = React.useState({ x: 12, y: 60 });
    React.useEffect(() => {
        if (!historyOpen || Platform.OS !== 'web') return;
        // This popover owns Escape before the app's global route-back handler.
        const close = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation();
            setHistoryOpen(false); historyAnchor.current?.focus();
        };
        window.addEventListener('keydown', close, true);
        return () => window.removeEventListener('keydown', close, true);
    }, [historyOpen]);
    const [busy, setBusy] = React.useState(false);
    const [executionAttempted, setExecutionAttempted] = React.useState(() => projectTaskExecutionAttempted(machineId, task));
    const [error, setError] = React.useState<string | null>(null);
    const [compactTab, setCompactTab] = React.useState(props.conversationId ? 'chat' : 'details');
    React.useEffect(() => { setCompactTab(current => props.conversationId ? 'chat' : current === 'chat' ? 'tasks' : current); }, [props.conversationId]);
    const [localHistory, setLocalHistory] = React.useState<GoalTaskSession[]>([]);
    const lifetime = React.useRef({ alive: true });
    const action = React.useRef<{ key: string; id: string; uncertain: boolean } | null>(null);
    const opening = React.useRef(false);
    React.useEffect(() => { lifetime.current.alive = true; return () => { lifetime.current.alive = false; }; }, []);
    const historyFromStore = storage(state => Object.values(state.sessions).filter(session => session.metadata?.machineId === machineId
        && (session.metadata.path === workspace.root || (session.metadata.goalBoard?.featurePath === featurePath && session.metadata.goalBoard.taskId === task.id)))
        .map(session => `${session.id}:${session.updatedAt}`).sort().join('|'));
    const history = React.useMemo(() => {
        const values = new Map([...taskHistory.sessions, ...localHistory].map(session => [session.sessionId, session]));
        for (const session of Object.values(storage.getState().sessions)) {
            if (session.metadata?.machineId !== machineId || !(session.metadata.path === workspace.root || (session.metadata.goalBoard?.featurePath === featurePath && session.metadata.goalBoard.taskId === task.id))) continue;
            values.set(session.id, { sessionId: session.id, title: session.metadata.summary?.text || values.get(session.id)?.title || session.metadata.name || getSessionName(session), directory: workspace.root, updatedAt: session.updatedAt, executed: (session.seq ?? 0) > 1, active: session.active });
        }
        return [...values.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }, [taskHistory.sessions, localHistory, historyFromStore, machineId, featurePath, task.id, workspace.root]);
    React.useEffect(() => { if (props.conversationId) void ensureSessionHydratedWithRetry(props.conversationId); }, [props.conversationId]);
    const conversationId = history.some(session => session.sessionId === props.conversationId) ? props.conversationId : undefined;
    const start = async (target: GoalTask, mode: 'chat' | 'execute', keepFileVisible = false, forceNew = false) => {
        if (opening.current || offline) return;
        if (target.id !== task.id) { selectTask(target.id); return; }
        if (readOnly && (mode !== 'chat' || !taskHistory.ready || taskHistory.loading || taskHistory.error)) return;
        opening.current = true;
        setBusy(true); setError(null);
        if (mode === 'execute') { markProjectTaskExecutionAttempt(machineId, task); setExecutionAttempted(true); }
        const key = `${target.id}:${mode}`;
        if (!action.current || action.current.key !== key || !action.current.uncertain) action.current = { key, id: requestId(), uncertain: true };
        try {
            const result = mode === 'chat' ? await openProjectGoalConversation(machineId, featurePath, target, action.current.id, agent, history, forceNew) : null;
            const id = result?.session.sessionId ?? await launchProjectGoalTask(machineId, featurePath, target, mode, action.current.id, agent);
            if (!lifetime.current.alive) return;
            action.current.uncertain = false;
            setLocalHistory(values => [...values.filter(session => session.sessionId !== id), result?.session ?? { sessionId: id, title: task.title, directory: workspace.root, updatedAt: Date.now(), executed: mode === 'execute' }]);
            if (!keepFileVisible) setCompactTab('chat'); selectConversation(id);
            await ensureSessionHydratedWithRetry(id);
            if (lifetime.current.alive) await refresh();
        } catch (error) { if (lifetime.current.alive) {
            if (mode === 'execute' && error instanceof ProjectGoalLaunchError && error.notDispatched) { clearUndispatchedProjectTaskAttempt(machineId, task); setExecutionAttempted(false); }
            setError(error instanceof Error ? error.message : String(error)); await refresh();
        } }
        finally { opening.current = false; if (lifetime.current.alive) setBusy(false); }
    };
    const openFile = async (path: string) => {
        setCompactTab('file');
        const alreadyOpen = !!workspace.controller.getSnapshot().documents[path];
        void workspace.openReference(path).then(() => { if (alreadyOpen) return workspace.controller.refresh(path); });
        // Reading a file does not create a conversation or reserve an empty chat column.
    };
    const listDirectory = React.useCallback(async (_sessionId: string, path: string) => {
        try { return await projectGoalRequest<{ success: boolean; entries?: DirectoryEntry[]; error?: string }>(machineId, 'goalTaskListDirectory', { featurePath, taskId: task.id, path }); }
        catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    }, [machineId, featurePath, task.id]);
    const wide = windowWidth >= 1100;
    const rightWidth = wide ? Math.min(rightExpandedWidth || 340, Math.max(280, rowWidth * 0.3)) : undefined;
    const fileOpen = workspace.enabled && workspace.snapshot.open;
    const showChat = !!conversationId;
    const chatWidth = getProjectChatWidth(workspace.chatWidthCustomized ? workspace.chatWidth : undefined, rowWidth, rightWidth ?? 0);
    const canExecute = !readOnly && taskCanExecute(task) && !executionAttempted && !history.some(session => session.executed);
    const details = <View style={[styles.taskPanel, { backgroundColor: surface }, wide ? { width: rightWidth, marginLeft: projectPanelGap } : { flex: 1 }]} testID="project-task-panel">
        <View style={styles.panelHeader}><ProjectTaskSwitcher tasks={allTasks} selectedId={task.id} onSelect={selectTask} /><View style={{ flex: 1 }} /><ProjectTaskStatus status={task.status} /></View>
        <View style={styles.tabs}><PanelTabs activeTab={tab} onTabChange={setTab} testIDPrefix="project-task" tabs={[{ key: 'details', label: t('projectGoals.details'), icon: 'document-text-outline' }, { key: 'files', label: t('projectGoals.files'), icon: 'folder-outline' }]} /></View>
        {tab === 'files' ? <WorkspaceDirectoryTree sessionId={conversationId ?? ''} rootPath={workspace.root} listDirectory={listDirectory} onOpenFile={path => { void openFile(path); }} />
            : <ScrollView style={styles.detailScroll}><ProjectTaskDetails task={task} number={allTasks.indexOf(task) + 1} approval={<ApprovalTag task={task} />} editDisabled={!canCreateProjectConversation() || busy || offline} onEdit={() => { void start(task, 'chat'); }}>
                {task.artifacts.filter(artifact => artifact.relation === 'output').map(artifact => <Deliverable key={artifact.id} {...{ artifact, task, machineId, featurePath, refresh }} openFile={openFile} />)}
            </ProjectTaskDetails></ScrollView>}
        {error && <Text accessibilityRole="alert" style={[styles.error, { padding: 12 }]}>{error}</Text>}
        {!readOnly && task.execution?.state === 'uncertain' && <Text style={[styles.meta, { paddingHorizontal: 14, paddingVertical: 6 }]}>{t('projectGoals.executionUncertain')}</Text>}
        <View style={styles.footer}>{readOnly && <Text style={styles.meta}>{t(canCreateProjectConversation() ? 'projectGoals.previewChatHint' : 'projectGoals.readOnlyArchive')}</Text>}<Button variant="primary" label={t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')} disabled={busy || offline || (readOnly && (!taskHistory.ready || taskHistory.loading || !!taskHistory.error || (!history.length && !canCreateProjectConversation())))} onPress={() => { void start(task, 'chat'); }} testID="project-task-open-chat"><Ionicons name="chatbubble-outline" size={16} color={theme.colors.text} /><Text style={styles.body}>{t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')}</Text></Button>
            {canExecute && <Button variant="primary" label={t('projectGoals.execute')} disabled={busy || offline} onPress={() => { void start(task, 'execute'); }} testID="project-task-execute"><Ionicons name="play" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.execute')}</Text></Button>}{busy && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}</View>
    </View>;
    const chat = <View testID="project-task-chat" style={[styles.chat, { backgroundColor: surface }, wide && fileOpen && !workspace.maximized ? { flexGrow: 0, flexShrink: 0, flexBasis: chatWidth, width: chatWidth, minWidth: 310 } : {}]}>
        <View style={styles.historyHeader}><Button variant="toolbar" label={t('projectGoals.backTasks')} onPress={() => { selectConversation(''); }}><Ionicons name="grid-outline" size={16} color={theme.colors.textSecondary} /></Button>
            <Button ref={historyAnchor} variant="toolbar" label={t('projectGoals.history')} expanded={historyOpen} onPress={() => {
                historyAnchor.current?.measureInWindow((x, y, _width, height) => { setHistoryPosition({ x, y: y + height + 6 }); setHistoryOpen(true); });
            }} testID="project-task-history"><Ionicons name="time-outline" size={15} color={theme.colors.textSecondary} /><Text style={styles.meta}>{t('projectGoals.history')} · {history.length}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button></View>
        {historyOpen && <RNModal transparent visible animationType="none" onRequestClose={() => setHistoryOpen(false)}>
            <Pressable style={styles.historyBackdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={() => setHistoryOpen(false)} />
            <View testID="project-task-history-menu" style={[styles.historyPopover, { left: Math.max(12, Math.min(historyPosition.x, windowWidth - Math.min(350, windowWidth - 24) - 12)), top: Math.max(12, Math.min(historyPosition.y, windowHeight - 180)), width: Math.min(350, windowWidth - 24), maxHeight: Math.max(100, Math.min(360, windowHeight - historyPosition.y - 16)) }]}>
            <ScrollView style={styles.historyList}>{canCreateProjectConversation() && <Button variant="toolbar" label={t('projectGoals.newChat')} disabled={busy || offline} onPress={() => { setHistoryOpen(false); void start(task, 'chat', false, true); }} testID="project-task-new-chat"><Ionicons name="add-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.newChat')}</Text></Button>}{history.map(session => <Button key={session.sessionId} variant="row" label={session.title} selected={conversationId === session.sessionId} onPress={() => { selectConversation(session.sessionId); setHistoryOpen(false); }} testID={`project-task-history-${session.sessionId}`}><View style={styles.cardBody}><Text numberOfLines={2} style={styles.body}>{session.title}</Text><Text style={styles.meta}>{new Date(session.updatedAt).toLocaleString()}</Text></View></Button>)}
            {taskHistory.loading && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
            {taskHistory.error && <><Text style={styles.error}>{taskHistory.error}</Text><Button label={t('common.retry')} onPress={() => { void taskHistory.read(); }}><Text style={styles.link}>{t('common.retry')}</Text></Button></>}
            {taskHistory.nextCursor && <Button label={t('projectGoals.moreHistory')} disabled={taskHistory.loading} onPress={() => { void taskHistory.read(taskHistory.nextCursor); }}><Text style={styles.link}>{t('projectGoals.moreHistory')}</Text></Button>}
            {!history.length && !taskHistory.loading && <Text style={styles.meta}>{t(!canCreateProjectConversation() ? 'projectGoals.noMatchingHistory' : 'projectGoals.noHistory')}</Text>}</ScrollView></View></RNModal>}
        {conversationId ? <SessionView key={conversationId} id={conversationId} embedded fullWidth /> : <View style={styles.empty}><Text style={styles.cardTitle}>{t('projectGoals.emptyChat')}</Text><Text style={styles.meta}>{t(!canCreateProjectConversation() ? 'projectGoals.noMatchingHistory' : 'projectGoals.emptyChatHint')}</Text>{canCreateProjectConversation() && <Button label={t('projectGoals.openChat')} onPress={() => { void start(task, 'chat'); }} disabled={busy || offline}><Text style={styles.link}>{t('projectGoals.openChat')}</Text></Button>}</View>}
    </View>;
    const catalog = <ScrollView style={styles.catalog} contentContainerStyle={styles.taskCatalogContent}>
        <CatalogHeading title={props.featureTitle} subtitle={`${allTasks.length} ${t('projectGoals.tasks')}`} query={props.query} setQuery={props.setQuery} />
        <TaskCards tasks={allTasks} query={props.query} status={props.statusFilter} setStatus={props.setStatusFilter} selectedId={task.id} onSelect={selectTask} onAction={(task, mode) => { void start(task, mode); }} busy={busy} offline={offline} hideExecution={executionAttempted} />
    </ScrollView>;
    return <View style={styles.taskArea}>
        {!wide && <View style={styles.compactTabs}><PanelTabs activeTab={compactTab} onTabChange={setCompactTab} testIDPrefix="project-workspace" tabs={[{ key: 'tasks', label: t('projectGoals.tasks'), icon: 'grid-outline' }, ...(showChat ? [{ key: 'chat', label: t('projectGoals.discussion'), icon: 'chatbubble-outline' as const }] : []), ...(fileOpen ? [{ key: 'file', label: t('projectGoals.files'), icon: 'document-outline' as const }] : []), { key: 'details', label: t('projectGoals.details'), icon: 'reader-outline' }]} /></View>}
        <View style={[styles.workspaceRow, !wide && { flexDirection: 'column' }]} onLayout={event => setRowWidth(Math.round(event.nativeEvent.layout.width))}>
            {wide ? <>
                {!workspace.maximized && showChat && chat}
                {!workspace.maximized && !showChat && !fileOpen && catalog}
                {fileOpen && <>{!workspace.maximized && showChat && <FileWorkspaceResizeHandle width={chatWidth} maximumWidth={getProjectChatMaximumWidth(rowWidth, rightWidth ?? 0)} />}<FileWorkspace framed sessionId={conversationId ?? ''} fileTreeExpanded={tab === 'files'} onToggleFileTree={() => setTab(value => value === 'files' ? 'details' : 'files')} /></>}
                {details}
            </> : compactTab === 'details' ? details : compactTab === 'chat' ? chat : compactTab === 'file' ? <FileWorkspace framed sessionId={conversationId ?? ''} /> : catalog}
        </View>
    </View>;
}

function Deliverable({ artifact, task, machineId, featurePath, refresh, openFile }: { artifact: GoalArtifact; task: GoalTask; machineId: string; featurePath: string; refresh: () => Promise<void>; openFile: (path: string) => Promise<void> }) {
    const workspace = useFileWorkspace()!;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [openedLink, setOpenedLink] = React.useState<string | null>(null);
    const { theme } = useUnistyles();
    const document = artifact.path ? workspace.snapshot.documents[artifact.path] : undefined;
    const hasReadVersion = artifact.path ? !!document?.hash && document?.fileRevision === artifact.revision && document?.phase === 'ready' && document.draft === document.content : !!artifact.url && openedLink === artifact.revision;
    const accepted = artifact.available && artifact.approval?.status === 'accepted';
    const approve = async () => {
        if (!artifact.available || !canConfirmProjectDeliverable() || !hasReadVersion || !artifact.revision || busy) return;
        if (!await Modal.confirm(t('projectGoals.approveTitle'), t(artifact.path ? 'projectGoals.approveMessage' : 'projectGoals.approveLinkMessage'))) return;
        setBusy(true); setError(null);
        try { await projectGoalRequest(machineId, 'goalTaskApprove', { featurePath, taskId: task.id, artifactId: artifact.id, expectedRevision: artifact.revision, expectedHash: document?.hash }); await refresh(); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <View style={styles.deliverable}>
        <Button variant="row" label={artifact.name} disabled={!artifact.available} onPress={() => { if (artifact.path) void openFile(artifact.path); else if (artifact.url) void openExternalUrl(artifact.url).then(() => setOpenedLink(artifact.revision ?? null)).catch(error => setError(String(error))); }} testID={`project-deliverable-${artifact.id}`}><Ionicons name={artifact.path ? 'document-outline' : 'open-outline'} size={16} color={theme.colors.textLink} /><View style={styles.cardBody}><Text style={styles.body}>{artifact.name}</Text>{artifact.description && <Text style={styles.meta}>{artifact.description}</Text>}</View></Button>
        <Text style={accepted ? styles.acceptedText : styles.pendingText}>{t(!artifact.available ? 'projectGoals.deliverableUnavailable' : accepted ? 'projectGoals.accepted' : artifact.approval?.status === 'changed' ? 'projectGoals.changed' : 'projectGoals.notReviewed')}</Text>
        {artifact.available && canConfirmProjectDeliverable() && !accepted && <Button label={t(artifact.path ? 'projectGoals.approve' : 'projectGoals.approveLink')} disabled={!hasReadVersion || busy} onPress={() => { void approve(); }} testID={`project-deliverable-approve-${artifact.id}`}><Text style={styles.link}>{t(artifact.path ? 'projectGoals.approve' : 'projectGoals.approveLink')}</Text></Button>}
        {artifact.available && canConfirmProjectDeliverable() && !accepted && !hasReadVersion && <Text style={styles.meta}>{t(artifact.path ? 'projectGoals.readFileFirst' : 'projectGoals.openLinkFirst')}</Text>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>;
}
function Empty({ text }: { text: string }) { return <View style={styles.empty}><Text style={styles.meta}>{text}</Text></View>; }

const styles = StyleSheet.create(theme => ({
    page: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: 'transparent' },
    header: { minHeight: 58, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    line: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
    machineBackdrop: { position: 'absolute', inset: 0, zIndex: 20 },
    machineMenu: { position: 'absolute', top: 56, right: 16, width: 310, maxHeight: 320, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, zIndex: 21 },
    catalog: { flex: 1, minWidth: 0 }, catalogContent: { paddingHorizontal: 32, paddingTop: 28, paddingBottom: 36, gap: 24 },
    catalogHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 },
    heading: { fontSize: 28, lineHeight: 38, color: theme.colors.text, ...Typography.default('semiBold') },
    libraryHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12 },
    search: { minWidth: 180, maxWidth: 320, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, color: theme.colors.text, fontSize: 13 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', gap: 14 },
    catalogCard: { flexGrow: 1, flexBasis: 280, maxWidth: 440 },
    catalogCardContent: { padding: 18, flexDirection: 'row', alignItems: 'center', gap: 16 },
    taskBoard: { gap: 20 }, taskFilters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
    taskCatalogContent: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 26, gap: 24 }, noFilteredTasks: { paddingVertical: 28 },
    taskCard: { width: 248, maxWidth: '100%', flexGrow: 0, flexShrink: 0, minHeight: 230 },
    taskCardContent: { paddingHorizontal: 16, paddingTop: 15, paddingBottom: 12, gap: 10, width: '100%' },
    taskNumber: { fontSize: 9, letterSpacing: 0.8, color: theme.colors.textSecondary, ...Typography.default() },
    taskGoal: { fontSize: 12, lineHeight: 21, minHeight: 42, color: theme.colors.textSecondary, ...Typography.default() },
    taskDelivery: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, paddingTop: 10, minHeight: 42 },
    runningCard: { borderColor: theme.colors.status.connecting },
    cardBody: { flex: 1, minWidth: 0, gap: 10 }, cardTitle: { fontSize: 14, lineHeight: 20, color: theme.colors.text, ...Typography.default('semiBold') },
    body: { fontSize: 13, lineHeight: 21, color: theme.colors.text, ...Typography.default() }, meta: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    link: { color: theme.colors.textLink, fontSize: 12, lineHeight: 18, ...Typography.default('semiBold') },
    cardActions: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 7, paddingBottom: 4 },
    tag: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start' },
    tagText: { fontSize: 11, lineHeight: 16, ...Typography.default('semiBold') },
    pendingTag: { backgroundColor: theme.colors.box.warning.background }, pendingText: { color: theme.colors.box.warning.text, fontSize: 11 },
    acceptedTag: { backgroundColor: theme.colors.surfaceSelected }, acceptedText: { color: theme.colors.success, fontSize: 11 },
    taskArea: { flex: 1, minHeight: 0, minWidth: 0, padding: 10 }, workspaceRow: { flex: 1, minHeight: 0, flexDirection: 'row' },
    taskPanel: { minHeight: 0, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' }, panelHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, padding: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    tabs: { flexDirection: 'row', minHeight: 48, paddingHorizontal: 12, paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    detailScroll: { flex: 1, minHeight: 0 }, sectionTitle: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    deliverable: { gap: 9, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, padding: 10 },
    footer: { padding: 12, gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    chat: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' }, historyHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    historyBackdrop: { position: 'absolute', inset: 0 },
    historyPopover: { position: 'absolute', borderRadius: 12, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, overflow: 'hidden', shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    historyList: { flexGrow: 0, padding: 8 },
    compactTabs: { flexDirection: 'row', padding: 8, minHeight: 48 }, empty: { flex: 1, padding: 28, justifyContent: 'center', alignItems: 'center', gap: 14 },
    errorBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: theme.colors.box.error.background }, error: { fontSize: 12, lineHeight: 19, color: theme.colors.textDestructive },
    author: { flex: 1, minHeight: 0, borderRadius: 16, overflow: 'hidden' },
}));
