import * as React from 'react';
import { ActivityIndicator, Modal as RNModal, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, useFocusEffect, useNavigation } from 'expo-router';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MobileProjectFileReader } from './MobileProjectFileReader';
import { mergeMobileProjectLocation, replaceMobileProjectLocation, canPopMobileProjectLocation, mobileProjectParent, findProjectForLocation, type MobileProjectLocation } from './mobileProjectNavigation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalArtifact, GoalBoardCatalogEntry, GoalProject, GoalTask, GoalTaskSession } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storage, useAllMachines, useLocalSetting, useMachine } from '@/sync/storage';
import { getRuntimeAccountSelection, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { useContinueProjectTask } from '@/hooks/useContinueProjectTask';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useIsTablet } from '@/utils/responsive';
import { ProjectSurfaces, projectSurfaces } from './ProjectSurfaces';
import { useReducedTransparency } from '@/hooks/useReducedTransparency';
import { useDesktopWorkspaceLayout } from '@/hooks/useDesktopWorkspaceLayout';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName } from '@/utils/sessionUtils';
import { sync } from '@/sync/sync';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { machineStartGoalAuthor, type DirectoryEntry } from '@/sync/ops';
import { loadProjectTaskHistory, launchProjectGoalTask, projectGoalRequest, projectTaskFiles, taskApproval, taskCanExecute, projectTaskExecutionAttempted, markProjectTaskExecutionAttempt, clearUndispatchedProjectTaskAttempt, ProjectGoalLaunchError, type ProjectHistoryCursor, isReadOnlyProjectPreview, type ProjectHistoryCandidate } from '@/sync/projectGoals';
import { SessionView } from '@/-session/SessionView';
import { SessionFileWorkspaceProvider } from '@/components/fileWorkspace/SessionFileWorkspaceProvider';
import { FileWorkspace, FileWorkspaceResizeHandle } from '@/components/fileWorkspace/FileWorkspace';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { WorkspaceDirectoryTree } from '@/components/fileWorkspace/WorkspaceDirectoryTree';
import { getProjectChatWidth, getProjectChatMaximumWidth, getProjectTaskNavigationWidth, canSplitProjectFile, projectPanelGap } from './projectWorkspaceLayout';
import { ProjectOverviewWorkspace } from './ProjectOverviewWorkspace';
import { ProjectDetailsPanel } from './ProjectDetailsPanel';
import { ProjectTaskNavigation } from './ProjectTaskNavigation';
import { ProjectConversationEmptyState } from './ProjectConversationEmptyState';
import { ProjectTaskSwitcher } from './ProjectTaskSwitcher';
import { ProjectTaskDetails } from './ProjectTaskDetails';
import { ProjectTaskStatus } from './ProjectTaskStatus';
import { PanelTabs } from '@/components/PanelTabs';
import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { GoalBoardCard } from './GoalBoardCard';
import { RunningTaskBorder } from './RunningTaskBorder';
import { ProjectGallery, ProjectGalleryLoading } from './ProjectGallery';
import { canCreateProjectConversation, canConfirmProjectDeliverable, openProjectGoalConversation } from '@/sync/projectGoals';
import { getProjectPreviewMachineId } from '@/sync/projectGoals';
import { selectProjectMachine } from './projectMachine';
import { useProjectNavigation } from './useProjectNavigation';
import { useProjectData } from './useProjectData';
import { getDirectoryCache } from '@/components/fileWorkspace/directoryCache';
import { ProjectDeliveryEditor } from './ProjectDeliveryEditor';
import { ProjectFeatureFiles } from './ProjectFeatureFiles';
import { projectCacheKey, projectHistorySchema, readProjectCache, writeProjectCache, isProjectSessionDeleted, subscribeProjectSessionDeletions, getProjectSessionDeletionRevision } from '@/sync/projectWorkspaceCache';
import { mergeProjectTaskHistory } from '@/sync/mergeProjectTaskHistory';
import { projectSessionMatchesTask } from '@/sync/projectGoals';

const requestId = () => `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function accountKey() { const a = getRuntimeAccountSelection(); return JSON.stringify([a?.key, a?.generation, a?.serverUrl]); }

const verifiedHistories = new Map<string, string>();
const catalogStates = new Map<string, { query: string; status: TaskStatusFilter; scroll: number }>();

function useProjectTaskHistory(machineId: string, featurePath: string, taskId: string, directory: string) {
    const machine = useMachine(machineId);
    // The account store already decrypted these real session headers. Send only
    // candidates from this machine; the reader canonicalizes and authorizes paths.
    const candidateRevision = storage(state => isReadOnlyProjectPreview() ? Object.values(state.sessions)
        .filter(session => session.metadata?.machineId === machineId && (/goal-first-ops/.test(session.metadata.path) || session.metadata.goalBoard))
        .map(session => `${session.id}:${session.updatedAt}:${session.metadata?.path}`).sort().join('|') : '');
    const key = JSON.stringify([accountKey(), machineId, featurePath, taskId]);
    const context = React.useRef(key); context.current = key;
    const epoch = React.useRef(0);
    const invalidation = (machine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    const verification = JSON.stringify([invalidation, candidateRevision]);
    const cacheKey = projectCacheKey('history', machineId, featurePath, taskId);
    const cached = React.useMemo(() => readProjectCache(cacheKey, projectHistorySchema), [cacheKey]);
    const [state, setState] = React.useState<{ key: string; sessions: GoalTaskSession[]; loaded: boolean; nextCursor?: ProjectHistoryCursor }>({ key, sessions: cached?.value.sessions ?? [], loaded: !!cached, nextCursor: cached?.value.nextCursor });
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
            const page = await loadProjectTaskHistory(machineId, featurePath, taskId, cursor, candidates, verification);
            if (context.current !== key || epoch.current !== request) return;
            verifiedHistories.set(key, verification);
            if (verifiedHistories.size > 200) verifiedHistories.delete(verifiedHistories.keys().next().value!);
            setState(previous => {
                const merged = new Map((cursor && previous.key === key ? previous.sessions : []).map(session => [session.sessionId, session]));
                for (const session of page.sessions) merged.set(session.sessionId, session);
                const value = { sessions: [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId)), nextCursor: page.nextCursor };
                writeProjectCache(cacheKey, value);
                return { key, loaded: true, ...value };
            });
        } catch (error) { if (context.current === key && epoch.current === request) setError(error instanceof Error ? error.message : String(error)); }
        finally { if (context.current === key && epoch.current === request) setLoading(false); }
    }, [machineId, featurePath, taskId, key, cacheKey, candidateRevision, verification]);
    React.useEffect(() => {
        // Reconcile once per runtime/Task/archive revision, in the background.
        // A persisted association is not proof of freshness after a new boot.
        if (!cached || verifiedHistories.get(key) !== verification) void read();
        return () => { epoch.current++; };
    }, [read, key, verification, cached]);
    return { sessions: state.key === key ? state.sessions : [], nextCursor: state.key === key ? state.nextCursor : undefined, ready: state.key === key && state.loaded, loading, error, read, verification };
}

export function ProjectGoalsWorkspace() {
    const params = useLocalSearchParams<MobileProjectLocation>();
    const router = useRouter();
    const stack = useNavigation();
    const desktopNavigation = useProjectNavigation(params, values => router.setParams(values));
    const { width } = useWindowDimensions();
    const mobile = Platform.OS !== 'web' || width < 1100;
    const navigation = mobile ? {
        navigate: (patch: MobileProjectLocation) => {
            const next = mergeMobileProjectLocation(params, patch);
            if (replaceMobileProjectLocation(params, next)) router.setParams(next);
            else router.push({ pathname: '/projects', params: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) });
        },
        back: (project?: GoalProject) => {
            const state = stack.getState();
            const previous = state?.routes[(state.index ?? 0) - 1];
            if (router.canGoBack() && canPopMobileProjectLocation(params, previous?.name)) router.back();
            else if (params.project || params.feature || params.task || params.author) router.replace({ pathname: '/projects', params: mobileProjectParent(params, project) });
            else router.replace('/');
        },
        forward: () => {}, canBack: true, canForward: false,
    } : desktopNavigation;
    const machines = useAllMachines({ includeOffline: true });
    const draftMachine = useNewSessionDraft(state => state.selectedMachineId);
    const selectedMachine = selectProjectMachine(machines, params.machine, draftMachine, getProjectPreviewMachineId());
    // Preserve an explicit owner while machine metadata reconnects, so its cached
    // archive remains readable offline and cannot fall back to another machine.
    const machineId = selectedMachine?.id ?? getProjectPreviewMachineId() ?? params.machine ?? draftMachine ?? '';
    // Account/machine switches remount the archive owner, so stale async work cannot navigate the new account.
    return <ProjectGoalsOwner key={JSON.stringify([accountKey(), machineId])} machineId={machineId} machines={machines} params={params}
        navigation={navigation} />;
}

function ProjectGoalsOwner({ machineId, machines, params, navigation }: {
    machineId: string; machines: ReturnType<typeof useAllMachines>;
    params: MobileProjectLocation;
    navigation: Omit<ReturnType<typeof useProjectNavigation>, 'navigate' | 'back'> & { navigate: (patch: MobileProjectLocation) => void; back: (project?: GoalProject) => void };
}) {
    const { theme } = useUnistyles();
    const { navigate } = navigation;
    const data = useProjectData(machineId, params.feature);
    const readOnly = isReadOnlyProjectPreview();
    const scope = JSON.stringify([accountKey(), machineId, params.project, params.feature]);
    const [catalogState, updateCatalogState] = React.useState(() => ({ scope, query: catalogStates.get(scope)?.query ?? '', status: catalogStates.get(scope)?.status ?? 'all' as TaskStatusFilter }));
    const currentCatalog = catalogState.scope === scope ? catalogState : { scope, query: catalogStates.get(scope)?.query ?? '', status: catalogStates.get(scope)?.status ?? 'all' as TaskStatusFilter };
    const query = currentCatalog.query;
    const statusFilter = currentCatalog.status;
    const setQuery = (query: string) => { const next = { ...currentCatalog, query }; updateCatalogState(next); catalogStates.set(scope, { ...next, scroll: scrollPosition.current }); };
    const setStatusFilter = (status: TaskStatusFilter) => { const next = { ...currentCatalog, status }; updateCatalogState(next); catalogStates.set(scope, { ...next, scroll: scrollPosition.current }); };
    const catalogScroll = React.useRef<ScrollView>(null);
    const scrollPosition = React.useRef(catalogStates.get(scope)?.scroll ?? 0);
    const [scopeRefresh, setScopeRefresh] = React.useState(0);
    const [taskNavigationActive, setTaskNavigationActive] = React.useState(false);
    const [taskNavigationCollapsed, setTaskNavigationCollapsed] = React.useState(false);
    const taskNavigationScroll = React.useRef(0);
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [actionError, setActionError] = React.useState<string | null>(null);
    const [deliveryTasks, setDeliveryTasks] = React.useState<GoalTask[] | null>(null);
    const [featureFilesOpen, setFeatureFilesOpen] = React.useState(false);
    React.useEffect(() => { setDeliveryTasks(null); setFeatureFilesOpen(false); }, [scope]);
    const [agent, setAgent] = React.useState<'codex' | 'claude'>(() => useNewSessionDraft.getState().agentType === 'claude' ? 'claude' : 'codex');
    const alive = React.useRef(true);
    const focused = React.useRef(true);
    useFocusEffect(React.useCallback(() => { focused.current = true; return () => { focused.current = false; }; }, []));
    const safeArea = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const mobile = Platform.OS !== 'web' || width < 1100;
    const [moreOpen, setMoreOpen] = React.useState(false);
    const scopeRef = React.useRef(scope); scopeRef.current = scope;
    React.useEffect(() => {
        scrollPosition.current = catalogStates.get(scope)?.scroll ?? 0;
        setTaskNavigationActive(false); setTaskNavigationCollapsed(false); taskNavigationScroll.current = 0;
    }, [scope]);
    if (catalogStates.size > 100) catalogStates.delete(catalogStates.keys().next().value!);
    React.useEffect(() => { if (params.conversation && Platform.OS === 'web') setTaskNavigationActive(true); }, [params.conversation]);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const project = findProjectForLocation(data.projects, params);
    const feature = data.board?.snapshot;
    const task = feature?.tasks.find(task => task.id === params.task);
    const skin = useLocalSetting('desktopSkinId');
    const reduced = useReducedTransparency();
    const desktop = useIsTablet() && Platform.OS === 'web';
    const scopeDesktop = desktop && !mobile;
    const photo = desktop && skin !== 'default';
    const readingSurface = photo ? (reduced ? theme.colors.desktopSkin.readingSolid : (mobile ? theme.colors.desktopSkin.readingWide : theme.colors.desktopSkin.readingCompact)) : theme.colors.surface;
    const surface = photo && !reduced && !mobile ? 'transparent' : readingSurface;
    const navigationEpoch = React.useRef(0);
    const location = JSON.stringify([params.project, params.feature, params.task, params.conversation, params.author, params.view, params.file]);
    const latestLocation = React.useRef(location); latestLocation.current = location;
    const go = (values: Record<string, string | undefined>) => { navigationEpoch.current++; setActionError(null); navigate({ conversation: undefined, author: undefined, view: undefined, file: undefined, ...values }); };
    const chooseProject = (project: GoalProject) => go({ project: project.projectPath, feature: project.features.length ? undefined : project.direct?.featurePath, task: undefined });
    const chooseFeature = (feature: GoalBoardCatalogEntry) => go({ feature: feature.featurePath, task: undefined });
    const organize = async () => {
        if (busy || !machineId || readOnly) return;
        const owner = accountKey();
        const requestedScope = scope;
        setBusy(true); setActionError(null);
        try {
            const result = await machineStartGoalAuthor(machineId, { scopePath: params.feature ?? params.project, requestId: requestId(), agent });
            if (!alive.current || !focused.current || accountKey() !== owner || scopeRef.current !== requestedScope) return;
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : 'Archive is unavailable');
            await ensureSessionHydratedWithRetry(result.sessionId);
            if (!alive.current || !focused.current || accountKey() !== owner || scopeRef.current !== requestedScope) return;
            storage.getState().updateSessionDraft(result.sessionId,
                `请使用 goal-first-ops 和 goal-first，帮我整理${params.feature ? '当前子项目的任务' : params.project ? '当前项目及子项目' : '一个新的项目'}。先通过对话对齐目标、最终交付与验收标准，给出只读草案让我确认，再更新档案。任务相互独立，不添加自动依赖执行。\n\n${params.feature ?? params.project ?? '从已安装的 Goal First 项目资料库开始。'}\n\n我的想法：`);
            navigate({ author: result.sessionId, conversation: undefined, task: undefined });
        } catch (error) { if (alive.current) setActionError(error instanceof Error ? error.message : String(error)); }
        finally { if (alive.current) setBusy(false); }
    };
    const cardOpening = React.useRef(false);
    const cardAttempts = React.useRef(new Map<string, string>());
    const openCardConversation = async (target: GoalTask) => {
        if (cardOpening.current || !feature || data.offline) return;
        cardOpening.current = true; setBusy(true); setActionError(null);
        const owner = accountKey(), requestedScope = scope, requestedNavigation = navigationEpoch.current, requestedLocation = latestLocation.current;
        const directory = target.indexPath.replace(/[\\/][^\\/]+$/, '');
        const key = projectCacheKey('history', machineId, feature.featurePath, target.id);
        const cached = (readProjectCache(key, projectHistorySchema)?.value.sessions ?? []).filter(session => {
            const live = storage.getState().sessions[session.sessionId]?.metadata;
            return !live || (live.machineId === machineId && (!live.goalBoard || projectSessionMatchesTask(live, machineId, feature.featurePath, target.id, directory)));
        });
        const known = [...cached];
        for (const session of Object.values(storage.getState().sessions)) {
            if (projectSessionMatchesTask(session.metadata, machineId, feature.featurePath, target.id, directory))
                known.push({ sessionId: session.id, directory, title: getSessionName(session), updatedAt: session.updatedAt, executed: (session.seq ?? 0) > 1 });
        }
        const id = cardAttempts.current.get(target.id) ?? requestId(); cardAttempts.current.set(target.id, id);
        try {
            const result = await openProjectGoalConversation(machineId, feature.featurePath, target, id, agent, known);
            if (!alive.current || !focused.current || accountKey() !== owner || scopeRef.current !== requestedScope || navigationEpoch.current !== requestedNavigation || latestLocation.current !== requestedLocation) return;
            cardAttempts.current.delete(target.id);
            writeProjectCache(key, { sessions: [result.session, ...cached.filter(session => session.sessionId !== result.session.sessionId)] });
            setTaskNavigationActive(desktop);
            navigate({ task: target.id, conversation: result.session.sessionId, author: undefined });
        } catch (error) { if (alive.current && scopeRef.current === requestedScope) setActionError(error instanceof Error ? error.message : String(error)); }
        finally { cardOpening.current = false; if (alive.current) setBusy(false); }
    };
    const cardAction = useContinueProjectTask({ machineId, featurePath: params.feature, agent, sessions: data.board?.sessions,
        onOpened: (task, conversation) => go({ task, conversation, view: 'chat' }) });
    const tasks = feature?.tasks ?? [];
    const selectedMachine = machines.find(machine => machine.id === machineId);
    return <ProjectSurfaces.Provider value={photo && !reduced ? projectSurfaces(theme.colors) : null}><View style={[styles.page, !mobile && { backgroundColor: readingSurface }, mobile && { paddingTop: safeArea.top, paddingBottom: safeArea.bottom }]} testID="project-goals-workspace">
        {mobile && <View style={[styles.mobileHeader, { backgroundColor: surface }]}>
            <Button touchTarget variant="primary" label={t('common.back')} onPress={() => navigation.back(project)} testID="project-navigation-back"><Ionicons name="chevron-back" size={22} color={theme.colors.text} /></Button>
            <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={styles.mobileTitle}>{task?.title || feature?.title || project?.title || t('projectGoals.allProjects')}</Text>
                {!!(task || feature) && <Text numberOfLines={1} style={styles.meta}>{[project?.title, task ? feature?.title : undefined].filter(Boolean).join(' / ')}</Text>}</View>
            <Button touchTarget variant="primary" label={t('sessionSearch.actions.more')} onPress={() => setMoreOpen(true)} testID="project-mobile-more"><Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.text} /></Button>
        </View>}
        <View style={[styles.header, { backgroundColor: surface }, mobile && { display: 'none' }]}>

            <View style={styles.line}>
                <Button variant="toolbar" label={t('common.back')} disabled={!navigation.canBack} onPress={() => { navigationEpoch.current++; navigation.back(); }} testID="project-navigation-back"><Ionicons name="arrow-back" size={18} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('desktopWorkspace.forward')} disabled={!navigation.canForward} onPress={() => { navigationEpoch.current++; navigation.forward(); }} testID="project-navigation-forward"><Ionicons name="arrow-forward" size={18} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('projectGoals.backProjects')} onPress={() => go({ project: undefined, feature: undefined, task: undefined })}>
                    <Ionicons name="folder-open-outline" size={17} color={theme.colors.textSecondary} /><Text style={styles.body}>{t('projectGoals.allProjects')}</Text>
                </Button>
                {project && <><Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} /><Button variant="toolbar" label={project.title} onPress={() => chooseProject(project)}><Text numberOfLines={1} style={styles.body}>{project.title}</Text></Button></>}
                {feature && <Button variant="toolbar" label={t('projectGoals.featureFiles')} selected={featureFilesOpen} onPress={() => setFeatureFilesOpen(value => !value)} testID="project-feature-files"><Ionicons name="folder-open-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.featureFiles')}</Text></Button>}
                {feature && feature.featurePath !== project?.projectPath && <><Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} /><Button variant="toolbar" label={feature.title} onPress={() => go({ task: undefined })}><Text numberOfLines={1} style={styles.body}>{feature.title}</Text></Button></>}
            </View>
            <View style={styles.line}>
                <Button variant="toolbar" label={t('projectGoals.chooseMachine')} disabled={readOnly} expanded={machineMenuOpen} onPress={() => setMachineMenuOpen(value => !value)} testID="project-machine-picker"><Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} /><Text numberOfLines={1} style={[styles.meta, { maxWidth: 200 }]}>{selectedMachine?.metadata?.displayName || selectedMachine?.metadata?.host || t('projectGoals.machine')}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('projectGoals.refresh')} disabled={data.loading || ((!machineId || data.offline) && !data.canRetryMachine)} onPress={() => { setScopeRefresh(value => value + 1); void data.refresh(); }} testID="project-goals-refresh">{data.loading ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name="refresh-outline" size={17} color={theme.colors.textSecondary} />}</Button>
                {(data.stale || data.status === 'offline' || data.status === 'connecting') && <Text testID="project-data-status" style={[styles.meta, { maxWidth: 220 }]} accessibilityLiveRegion="polite">{t(data.status === 'offline' ? 'projectGoals.offlineArchive' : data.status === 'connecting' ? 'projectGoals.connecting' : data.error ? 'projectGoals.cachedContent' : 'projectGoals.refreshing')}</Text>}
                {readOnly && <Text style={styles.meta}>{t('projectGoals.realArchive')}</Text>}

                {!readOnly && <Button variant="toolbar" label={t('projectGoals.agent')} onPress={() => setAgent(value => value === 'codex' ? 'claude' : 'codex')}><Text style={styles.meta}>{agent === 'codex' ? 'Codex' : 'Claude'}</Text></Button>}
                {!scopeDesktop && <Button variant="toolbar" label={t(params.feature ? 'projectGoals.createTask' : 'projectGoals.createProject')} disabled={readOnly || busy || !machineId || data.offline} onPress={() => { void organize(); }} testID="project-goals-organize"><Ionicons name="sparkles-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t(params.feature ? 'projectGoals.createTask' : 'projectGoals.createProject')}</Text></Button>}
            </View>
        </View>
        {!mobile && machineMenuOpen && <>
            <Pressable style={styles.machineBackdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={() => setMachineMenuOpen(false)} />
            <ScrollView style={styles.machineMenu}>
                {machines.map(machine => <Button variant="toolbar" key={machine.id} selected={machineId === machine.id} label={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                    onPress={() => { setMachineMenuOpen(false); navigate({ machine: machine.id, project: undefined, feature: undefined, task: undefined, conversation: undefined, author: undefined }); }}>
                    <Text style={styles.meta}>{machine.metadata?.displayName || machine.metadata?.host || machine.id}{!isMachineOnline(machine) ? ` · ${t('projectGoals.offline')}` : ''}</Text>
                </Button>)}
            </ScrollView>
        </>}
        {mobile && moreOpen && <RNModal transparent visible animationType={Platform.OS === 'web' ? 'none' : 'slide'} onRequestClose={() => setMoreOpen(false)}>
            <View style={styles.mobileSheetBackdrop}><Pressable style={StyleSheet.absoluteFill} accessibilityLabel={t('common.cancel')} accessibilityRole="button" onPress={() => setMoreOpen(false)} />
                <View style={[styles.mobileSheet, { paddingBottom: Math.max(12, safeArea.bottom) }]}>
                    <View style={styles.line}><Text style={[styles.mobileTitle, { flex: 1 }]}>{t('projectGoals.allProjects')}</Text><Button label={t('sidebarLists.close')} onPress={() => setMoreOpen(false)}><Ionicons name="close" size={20} color={theme.colors.text} /></Button></View>
                    <ScrollView style={{ flexGrow: 0 }}>
                        <Button variant="row" label={t('projectGoals.backProjects')} onPress={() => { setMoreOpen(false); go({ project: undefined, feature: undefined, task: undefined }); }}><Text style={styles.body}>{t('projectGoals.allProjects')}</Text></Button>
                        <Button variant="row" label={t('projectGoals.refresh')} disabled={data.loading || ((!machineId || data.offline) && !data.canRetryMachine)} onPress={() => { void data.refresh(); }}><Text style={styles.body}>{t(data.loading ? 'projectGoals.refreshing' : 'projectGoals.refresh')}</Text></Button>
                        <Button variant="row" label={t('projectGoals.agent')} onPress={() => setAgent(value => value === 'codex' ? 'claude' : 'codex')}><Text style={styles.body}>{agent === 'codex' ? 'Codex' : 'Claude'}</Text></Button>
                        <Button variant="row" label={t(params.feature ? 'projectGoals.createTask' : 'projectGoals.createProject')} disabled={readOnly || busy || data.offline} onPress={() => { setMoreOpen(false); void organize(); }}><Text style={styles.link}>{t(params.feature ? 'projectGoals.createTask' : 'projectGoals.createProject')}</Text></Button>
                        {feature && Platform.OS === 'web' && <Button variant="row" label={t('projectGoals.featureFiles')} onPress={() => { setMoreOpen(false); setFeatureFilesOpen(true); }}><Text style={styles.link}>{t('projectGoals.featureFiles')}</Text></Button>}
                        {feature && <Button variant="row" label={t('projectGoals.batchDelivery')} disabled={readOnly || data.offline || !tasks.length} onPress={() => { setMoreOpen(false); setDeliveryTasks(tasks); }}><Text style={styles.link}>{t('projectGoals.batchDelivery')}</Text></Button>}
                        <Text style={[styles.meta, { padding: 12 }]}>{t('projectGoals.chooseMachine')}</Text>
                        {machines.map(machine => <Button key={machine.id} variant="row" selected={machine.id === machineId} disabled={readOnly} label={machine.metadata?.displayName || machine.id} onPress={() => { setMoreOpen(false); navigate({ machine: machine.id, project: undefined, feature: undefined, task: undefined, conversation: undefined, author: undefined, view: undefined, file: undefined }); }}><Text style={styles.body}>{machine.metadata?.displayName || machine.metadata?.host || machine.id}</Text></Button>)}
                    </ScrollView>
                </View>
            </View>
        </RNModal>}
        {mobile && (data.stale || data.offline) && <Text accessibilityLiveRegion="polite" style={[styles.meta, { paddingHorizontal: 16 }]}>{t(data.offline ? 'projectGoals.offlineArchive' : 'projectGoals.refreshing')}</Text>}
        {(data.error || actionError || cardAction.error) && <View style={styles.errorBar} accessibilityRole="alert"><Text style={styles.error}>{data.error || actionError || cardAction.error}</Text></View>}
        {!machineId && data.status === 'offline' ? <Empty text={t('projectGoals.noMachine')} /> : !scopeDesktop && params.author ? <View style={[styles.author, { backgroundColor: photo && !reduced ? 'transparent' : surface }]}><Text style={[styles.meta, { padding: 12 }]}>{t('projectGoals.authoringHint')}</Text><SessionView key={params.author} id={params.author} embedded fullWidth /></View>
            : task && feature ? <TaskWorkspace key={JSON.stringify([machineId, feature.featurePath, task.id])} machineId={machineId} featurePath={feature.featurePath} task={task}
                editDelivery={setDeliveryTasks} openCardConversation={openCardConversation} featureTitle={feature.title} query={query} setQuery={setQuery} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
                allTasks={tasks} conversationId={params.conversation} agent={agent} offline={data.offline}
                mobileView={params.view} readerPath={params.file} changeView={view => navigate({ view })} openReader={file => navigate({ file, view: 'reader' })} closeReader={navigation.back}
                taskNavigationActive={taskNavigationActive || !!params.conversation} activateTaskNavigation={() => { if (desktop) setTaskNavigationActive(true); }} taskNavigationCollapsed={taskNavigationCollapsed} setTaskNavigationCollapsed={setTaskNavigationCollapsed} taskNavigationScroll={taskNavigationScroll}
                refresh={data.refresh} selectTask={id => go({ task: id })} selectConversation={id => navigate({ conversation: id, ...(mobile ? { view: 'chat' } : {}) })} />
            : <ScopeCatalog enabled={scopeDesktop} scopePath={params.feature ?? project?.projectPath} machineId={machineId} title={feature?.title ?? project?.title ?? ''} connecting={data.status === 'connecting'} conversationId={params.conversation ?? params.author} agent={agent} offline={data.offline} revision={JSON.stringify([feature?.revision, (selectedMachine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision, scopeRefresh])} surface={surface} selectConversation={id => navigate({ conversation: id, author: undefined })} navigationCollapsed={taskNavigationCollapsed} onToggleNavigation={feature ? () => setTaskNavigationCollapsed(value => !value) : undefined} navigation={feature && !taskNavigationCollapsed ? <ProjectTaskNavigation tasks={tasks} selectedId="" query={query} setQuery={setQuery} onSelect={id => go({ task: id })} onCollapse={() => setTaskNavigationCollapsed(true)} scrollPosition={taskNavigationScroll} width={244} surface={surface} /> : undefined}><ScrollView ref={catalogScroll} onContentSizeChange={() => catalogScroll.current?.scrollTo({ y: scrollPosition.current, animated: false })} onScroll={event => { scrollPosition.current = event.nativeEvent.contentOffset.y; catalogStates.set(scope, { query, status: statusFilter, scroll: scrollPosition.current }); }} scrollEventThrottle={100} style={[styles.catalog, { backgroundColor: surface }]} contentContainerStyle={[styles.catalogContent, mobile && styles.mobileCatalog]}>
                <CatalogHeading title={feature ? feature.title : params.feature ? t('projectGoals.loadingTasks') : project ? project.title : t('projectGoals.allProjects')} subtitle={feature ? `${tasks.length} ${t('projectGoals.tasks')}` : project ? project.summary || t('projectGoals.subprojects') : t('projectGoals.galleryDescription')} query={query} setQuery={setQuery} />
                {feature && <Button variant="toolbar" label={t('projectGoals.batchDelivery')} disabled={readOnly || data.offline || !tasks.length} onPress={() => setDeliveryTasks(tasks)} testID="project-batch-delivery"><Text style={styles.link}>{t('projectGoals.batchDelivery')}</Text></Button>}
                {params.task && feature && !task && <Text style={styles.error}>{t('projectGoals.taskMissing')}</Text>}
                {!data.contentLoaded && (data.status === 'loading' || data.status === 'connecting') ? <ProjectLoading kind={scopeDesktop ? params.feature ? 'tasks' : params.project ? 'features' : 'projects' : 'projects'} /> : feature ? <TaskCards onDelivery={target => setDeliveryTasks([target])} tasks={tasks} query={query} status={statusFilter} setStatus={setStatusFilter} onSelect={id => go({ task: id })} mobile={mobile} actionLabel={target => { const cached = readProjectCache(projectCacheKey('history', machineId, feature!.featurePath, target.id), projectHistorySchema); const known = data.board?.sessions[target.id] ?? cached?.value.sessions; return t(known ? known.length ? 'projectGoals.continueChat' : 'projectGoals.openChat' : 'projectGoals.chooseChat'); }} onAction={target => { if (mobile) void cardAction.continueTask(target); else void openCardConversation(target); }} offline={data.offline} busy={busy || cardAction.busy} hideExecution />
                    : project ? <View style={styles.grid}>{[...(project.direct ? [project.direct] : []), ...project.features].filter(entry => entry.title.toLowerCase().includes(query.toLowerCase())).map(entry => <CatalogCard key={entry.featurePath} title={entry.featurePath === project.projectPath ? t('projectGoals.tasks') : entry.title} subtitle={entry.summary || t('projectGoals.showTasks')} onPress={() => chooseFeature(entry)} />)}</View>
                        : <><View style={styles.libraryHeading}><Text style={styles.sectionTitle}>{t('projectGoals.projectLibrary')}</Text><Text style={styles.meta}>{data.loaded ? data.projects.length : '—'}</Text></View><ProjectGallery projects={data.projects.filter(project => (project.title + (project.summary || '')).toLowerCase().includes(query.toLowerCase()))} onSelect={chooseProject} /></>}
                {data.status === 'offline' && <Empty text={t('projectGoals.offlineArchive')} />}
                {data.status === 'ready' && !data.projects.length && <Empty text={t('projectGoals.emptyProjects')} />}
                {feature && !tasks.length && <Empty text={t('projectGoals.emptyTasks')} />}
            </ScrollView></ScopeCatalog>}
        {feature && !!deliveryTasks?.length && <ProjectDeliveryEditor key={JSON.stringify([accountKey(), machineId, feature.featurePath])} machineId={machineId} featurePath={feature.featurePath} tasks={deliveryTasks} onClose={() => setDeliveryTasks(null)} onSaved={data.refresh} onDiscuss={target => { setDeliveryTasks(null); if (mobile) void cardAction.continueTask(target); else void openCardConversation(target); }} />}
        {feature && featureFilesOpen && <ProjectFeatureFiles key={JSON.stringify([accountKey(), machineId, feature.featurePath])} machineId={machineId} featurePath={feature.featurePath} title={feature.title} onClose={() => setFeatureFilesOpen(false)} />}
    </View></ProjectSurfaces.Provider>;
}

function ScopeCatalog({ scopePath, children, enabled, ...props }: Omit<React.ComponentProps<typeof ProjectOverviewWorkspace>, 'scopePath'> & { scopePath?: string; enabled: boolean }) {
    return enabled && scopePath ? <ProjectOverviewWorkspace key={scopePath} scopePath={scopePath} {...props}>{children}</ProjectOverviewWorkspace> : <>{children}</>;
}
function ProjectLoading({ kind }: { kind: 'projects' | 'features' | 'tasks' }) {
    return <View testID="project-loading" accessibilityLabel={t('projectGoals.loadingArchive')} accessibilityState={{ busy: true }} style={{ gap: 20 }}>
        <Text style={styles.meta}>{t('projectGoals.loadingArchive')}</Text>
        {kind === 'projects' ? <ProjectGalleryLoading /> : <View style={styles.grid} testID={`project-${kind}-loading`}>{Array.from({ length: 6 }, (_, i) => <View key={i} style={kind === 'tasks' ? styles.taskCard : styles.catalogCard}><View style={[styles.taskCardContent, styles.loadingCard, kind === 'tasks' ? { minHeight: 230 } : { minHeight: 100 }]}><View style={[styles.skeletonLine, { width: '30%' }]} /><View style={[styles.skeletonLine, { width: '75%' }]} /><View style={[styles.skeletonLine, { width: '90%' }]} /><View style={[styles.skeletonLine, { width: '65%' }]} /></View></View>)}</View>}
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
    const label = state === 'accepted' ? 'accepted' : state === 'changed' ? 'changed' : state !== 'noDeliverables' ? 'notReviewed'
        : task.artifacts.some(artifact => artifact.relation === 'output') ? 'finalsMissing' : task.expectedDeliverables.length ? 'awaitingDelivery' : 'agreeDelivery';
    return <View style={[styles.tag, state === 'accepted' ? styles.acceptedTag : styles.pendingTag]}><Text numberOfLines={2} style={[styles.tagText, { maxWidth: 110 }, state === 'accepted' ? styles.acceptedText : styles.pendingText]}>{t(`projectGoals.${label}`)}</Text></View>;
}
export function TaskCards({ onDelivery, tasks, query, status, setStatus, selectedId, onSelect, onAction, offline, busy, hideExecution, mobile = false, actionLabel }: {
    query: string; status: TaskStatusFilter; setStatus: (status: TaskStatusFilter) => void; mobile?: boolean; actionLabel?: (task: GoalTask) => string;
    onDelivery?: (task: GoalTask) => void;
    tasks: GoalTask[]; selectedId?: string; onSelect: (id: string) => void; onAction?: (task: GoalTask, action: 'chat' | 'execute') => void; offline?: boolean; busy?: boolean; hideExecution?: boolean;
}) {
    const { theme } = useUnistyles();
    const statuses: GoalTask['status'][] = ['pending', 'running', 'review', 'done', 'blocked', ...(tasks.some(task => task.status === 'unknown') ? ['unknown' as const] : [])];
    const visible = tasks.filter(task => (status === 'all' || task.status === status) && (task.title + task.goal).toLowerCase().includes(query.toLowerCase()));
    return <View style={styles.taskBoard} testID="project-task-board">
        <View style={styles.taskFilters} testID="project-task-filters">
            {(['all', ...statuses] as const).map(value => <Button key={value} variant="chip" selected={status === value} label={value === 'all' ? t('goalBoard.allTasks') : t(`goalBoard.status.${value}`)} onPress={() => setStatus(value)} testID={`project-task-filter-${value}`}><Text style={status === value ? styles.link : styles.meta}>{value === 'all' ? t('goalBoard.allTasks') : t(`goalBoard.status.${value}`)}</Text><Text style={styles.taskNumber}>{value === 'all' ? tasks.length : tasks.filter(task => task.status === value).length}</Text></Button>)}
        </View>
        <View style={styles.grid}>{visible.map(task => <GoalBoardCard key={task.id} selected={selectedId === task.id} style={[styles.taskCard, mobile && styles.mobileTaskCard, task.status === 'running' && styles.runningCard]} testID={`project-task-card-${task.id}`}>
        <View style={[styles.line, { justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 8 }]}><View style={styles.line}><Text style={styles.taskNumber}>{task.code || `TASK ${String(tasks.indexOf(task) + 1).padStart(2, '0')}`}</Text><ProjectTaskStatus status={task.status} /></View><Button variant="toolbar" label={t('projectGoals.editDelivery')} disabled={!onDelivery || offline || busy || isReadOnlyProjectPreview()} onPress={() => onDelivery?.(task)} testID={`project-task-delivery-${task.id}`}><ApprovalTag task={task} /></Button></View>
        <Button variant="card" selected={selectedId === task.id} label={task.title} onPress={() => onSelect(task.id)}>
            <View style={styles.taskCardContent}>
                <Text numberOfLines={2} style={styles.cardTitle}>{task.title}</Text><Text numberOfLines={2} style={styles.taskGoal}>{task.goal || task.title}</Text><View style={styles.taskDelivery}><Ionicons name="document-text-outline" size={13} color={theme.colors.textLink} /><Text numberOfLines={2} style={[styles.meta, { flex: 1 }]}>{task.expectedDeliverables.join(' · ') || t('projectGoals.noExpected')}</Text></View></View>
        </Button>
        {onAction && mobile ? <View style={styles.mobileCardActions}><Button variant="primary" label={actionLabel?.(task) ?? t('projectGoals.chooseChat')} disabled={offline || busy} busy={busy} testID={`project-task-continue-${task.id}`} onPress={() => onAction(task, 'chat')}><Ionicons name="chatbubble-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{actionLabel?.(task) ?? t('projectGoals.chooseChat')}</Text></Button></View> : onAction && <View style={styles.cardActions}><Button variant="toolbar" label={t('projectGoals.openChat')} disabled={offline || busy} onPress={() => onAction(task, 'chat')} testID={`project-task-chat-${task.id}`}><Ionicons name="chatbubble-outline" size={17} color={theme.colors.textSecondary} /></Button>
            {!isReadOnlyProjectPreview() && !hideExecution && taskCanExecute(task) && <Button variant="toolbar" label={t('projectGoals.execute')} disabled={offline || busy} onPress={() => onAction(task, 'execute')}><Ionicons name="play" size={17} color={theme.colors.textLink} /></Button>}</View>}
        <RunningTaskBorder active={task.status === 'running'} />
    </GoalBoardCard>)}</View>{!visible.length && <View style={styles.noFilteredTasks}><Text style={styles.meta}>{t('goalBoard.noMatches')}</Text></View>}
    </View>;
}

type TaskWorkspaceProps = { editDelivery: (tasks: GoalTask[]) => void; openCardConversation: (task: GoalTask) => Promise<void>; mobileView?: string; readerPath?: string; changeView: (view: string) => void; openReader: (file: string) => void; closeReader: () => void; featureTitle: string; query: string; setQuery: (value: string) => void; statusFilter: TaskStatusFilter; setStatusFilter: (value: TaskStatusFilter) => void; machineId: string; featurePath: string; task: GoalTask; allTasks: GoalTask[]; conversationId?: string; agent: 'codex' | 'claude'; offline: boolean; refresh: () => Promise<void>; selectTask: (id: string) => void; selectConversation: (id: string) => void; taskNavigationActive: boolean; activateTaskNavigation: () => void; taskNavigationCollapsed: boolean; setTaskNavigationCollapsed: (value: boolean) => void; taskNavigationScroll: React.MutableRefObject<number>; };
function TaskWorkspace(props: TaskWorkspaceProps) {
    const { machineId, featurePath, task } = props;
    const binding = React.useMemo(() => projectTaskFiles(machineId, featurePath, task), [machineId, featurePath, task.id, task.indexPath]);
    return <SessionFileWorkspaceProvider sessionId={props.conversationId ?? ''} binding={binding}><TaskWorkspaceContent {...props} /></SessionFileWorkspaceProvider>;
}
function TaskWorkspaceContent(props: TaskWorkspaceProps) {
    const { task, machineId, featurePath, allTasks, selectTask, selectConversation, refresh, agent, offline } = props;
    const { theme } = useUnistyles();
    const workspace = useFileWorkspace()!;
    const safeArea = useSafeAreaInsets();
    const readOnly = isReadOnlyProjectPreview();
    const taskHistory = useProjectTaskHistory(machineId, featurePath, task.id, workspace.root);
    const skin = useLocalSetting('desktopSkinId');
    const reduced = useReducedTransparency();
    const desktop = useIsTablet() && Platform.OS === 'web';
    const photo = desktop && skin !== 'default';
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const mobile = Platform.OS !== 'web' || windowWidth < 1100;
    const surface = photo ? reduced ? theme.colors.desktopSkin.readingSolid : mobile ? theme.colors.desktopSkin.readingCompact : 'transparent' : theme.colors.surface;
    const mobileView = props.mobileView === 'files' ? 'files' : props.mobileView === 'chat' || (!props.mobileView && props.conversationId) ? 'chat' : 'details';
    const { rightExpandedWidth } = useDesktopWorkspaceLayout();
    const fileRequest = React.useRef(workspace.openRequestId);
    React.useEffect(() => {
        if (fileRequest.current === workspace.openRequestId) return;
        fileRequest.current = workspace.openRequestId;
        if (mobile && focused.current && props.mobileView !== 'reader' && workspace.snapshot.active) props.openReader(workspace.snapshot.active);
    }, [workspace.openRequestId, workspace.snapshot.active, mobile, props.mobileView]);
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
    const focused = React.useRef(true);
    useFocusEffect(React.useCallback(() => { focused.current = true; return () => { focused.current = false; }; }, []));
    const action = React.useRef<{ key: string; id: string; uncertain: boolean } | null>(null);
    const opening = React.useRef(false);
    React.useEffect(() => { lifetime.current.alive = true; return () => { lifetime.current.alive = false; }; }, []);
    const historyFromStore = storage(state => Object.values(state.sessions)
        .map(session => `${session.id}:${session.updatedAt}:${session.metadata?.machineId}:${session.metadata?.path}:${session.metadata?.goalBoard?.featurePath}:${session.metadata?.goalBoard?.taskId}`).sort().join('|'));
    const deletionRevision = React.useSyncExternalStore(subscribeProjectSessionDeletions, getProjectSessionDeletionRevision, getProjectSessionDeletionRevision);
    const history = React.useMemo(() => {
        return mergeProjectTaskHistory([...taskHistory.sessions, ...localHistory], Object.values(storage.getState().sessions), { machineId, featurePath, taskId: task.id, directory: workspace.root });
    }, [taskHistory.sessions, localHistory, historyFromStore, deletionRevision, machineId, featurePath, task.id, workspace.root]);
    const [conversationRetry, retryConversation] = React.useReducer(value => value + 1, 0);
    const conversationId = props.conversationId && !isProjectSessionDeleted(props.conversationId) ? props.conversationId : undefined;
    const conversation = storage(state => props.conversationId ? state.sessions[props.conversationId] : undefined);
    const conversationVerified = !!conversation?.metadata && conversation.metadata.machineId === machineId
        && (projectSessionMatchesTask(conversation.metadata, machineId, featurePath, task.id, workspace.root) || (!conversation.metadata.goalBoard && history.some(value => value.sessionId === props.conversationId)));
    const conversationRejected = !!props.conversationId && (isProjectSessionDeleted(props.conversationId) || (!!conversation?.metadata && !conversationVerified));
    React.useEffect(() => {
        let active = true;
        if (conversationId && !offline) void sync.ensureSessionHydrated(conversationId).then(ready => {
            if (active && !ready) setError(t('projectGoals.sessionUnavailable'));
        }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
        return () => { active = false; };
    }, [conversationId, conversationRetry, offline]);
    const start = async (target: GoalTask, mode: 'chat' | 'execute', keepFileVisible = false, forceNew = false) => {
        if (opening.current) return;
        if (target.id !== task.id) { if (mode === 'chat' && desktop) void props.openCardConversation(target); else selectTask(target.id); return; }
        if (mode === 'chat' && !forceNew && history.length) {
            setError(null);
            props.activateTaskNavigation();
            setCompactTab('chat');
            selectConversation(history[0].sessionId);
            return history[0].sessionId;
        }
        if (offline || (readOnly && mode !== 'chat')) return;
        opening.current = true;
        setBusy(true); setError(null);
        if (mode === 'execute') { markProjectTaskExecutionAttempt(machineId, task); setExecutionAttempted(true); }
        const key = `${target.id}:${mode}`;
        if (!action.current || action.current.key !== key || !action.current.uncertain) action.current = { key, id: requestId(), uncertain: true };
        try {
            const result = mode === 'chat' ? await openProjectGoalConversation(machineId, featurePath, target, action.current.id, agent, history, forceNew, taskHistory.verification) : null;
            const id = result?.session.sessionId ?? await launchProjectGoalTask(machineId, featurePath, target, mode, action.current.id, agent);
            if (!lifetime.current.alive || !focused.current) return;
            action.current.uncertain = false;
            props.activateTaskNavigation();
            setLocalHistory(values => [...values.filter(session => session.sessionId !== id), result?.session ?? { sessionId: id, title: task.title, directory: workspace.root, updatedAt: Date.now(), executed: mode === 'execute' }]);
            if (!keepFileVisible) setCompactTab('chat'); selectConversation(id);
            const linked = result?.session ?? { sessionId: id, title: task.title, directory: workspace.root, updatedAt: Date.now(), executed: mode === 'execute' };
            writeProjectCache(projectCacheKey('history', machineId, featurePath, task.id), { sessions: [linked, ...history.filter(session => session.sessionId !== id)].slice(0, 1000) });
            if (mode === 'execute') void refresh();
            return id;
        } catch (error) { if (lifetime.current.alive) {
            if (mode === 'execute' && error instanceof ProjectGoalLaunchError && error.notDispatched) { clearUndispatchedProjectTaskAttempt(machineId, task); setExecutionAttempted(false); }
            setError(error instanceof Error ? error.message : String(error)); if (mode === 'execute') void refresh();
        } }
        finally { opening.current = false; if (lifetime.current.alive) setBusy(false); }
    };
    const openFile = async (path: string) => {
        props.activateTaskNavigation();
        if (mobile) { props.openReader(path); return; }
        setCompactTab('file');
        const alreadyOpen = !!workspace.controller.getSnapshot().documents[path];
        void workspace.openReference(path).then(() => { if (alreadyOpen) return workspace.controller.refresh(path); });
        // Reading a file does not create a conversation or reserve an empty chat column.
    };
    const listDirectory = React.useCallback(async (_sessionId: string, path: string) => {
        try { return await projectGoalRequest<{ success: boolean; entries?: DirectoryEntry[]; error?: string }>(machineId, 'goalTaskListDirectory', { featurePath, taskId: task.id, path }); }
        catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    }, [machineId, featurePath, task.id]);
    const directoryCacheKey = JSON.stringify([accountKey(), machineId, workspace.root]);
    const directoryMachine = useMachine(machineId);
    const directoryRevision = (directoryMachine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    const runtimeAccount = accountKey();
    React.useEffect(() => {
        if (!offline) void getDirectoryCache(directoryCacheKey).load(workspace.root, () => listDirectory('', workspace.root), () => accountRuntimeCurrent() && accountKey() === runtimeAccount);
    }, [directoryCacheKey, workspace.root, listDirectory, directoryRevision, offline]);
    const wide = !mobile;
    const rightWidth = wide ? Math.min(rightExpandedWidth || 340, Math.max(280, rowWidth * 0.3)) : undefined;
    const fileOpen = workspace.enabled && workspace.snapshot.open;
    const showChat = !!conversationId;
    const taskNavigation = props.taskNavigationActive || showChat || fileOpen;
    const navigationWidth = desktop && wide && taskNavigation && !props.taskNavigationCollapsed && !workspace.maximized ? getProjectTaskNavigationWidth(rowWidth) : 0;
    const contentWidth = rowWidth - (navigationWidth ? navigationWidth + projectPanelGap : 0);
    const splitFile = wide && canSplitProjectFile(rowWidth, rightWidth ?? 0, navigationWidth);
    const chatWidth = getProjectChatWidth(workspace.chatWidthCustomized ? workspace.chatWidth : undefined, contentWidth, rightWidth ?? 0);
    const showTaskFiles = () => { if (mobile) props.changeView('files'); else { setTab('files'); if (!wide) setCompactTab('details'); } };
    const emptyConversation = <ProjectConversationEmptyState task={task} onStart={() => { void start(task, 'chat'); }} startLabel={t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')} disabled={busy || (!history.length && (offline || !canCreateProjectConversation()))} onFiles={showTaskFiles} />;
    const canExecute = !readOnly && taskCanExecute(task) && !executionAttempted && !history.some(session => session.executed);
    const details = <ProjectDetailsPanel style={[{ backgroundColor: surface }, wide ? { width: rightWidth, marginLeft: projectPanelGap } : { flex: 1 }]} testID="project-task-panel" tab={tab} onTab={setTab} showTabs={!mobile}
        header={mobile ? <><ProjectTaskStatus status={task.status} /><ApprovalTag task={task} /></> : <><ProjectTaskSwitcher tasks={allTasks} selectedId={task.id} onSelect={selectTask} /><View style={{ flex: 1 }} /><ProjectTaskStatus status={task.status} /></>} footer={<>{readOnly && <Text style={styles.meta}>{t(canCreateProjectConversation() ? 'projectGoals.previewChatHint' : 'projectGoals.readOnlyArchive')}</Text>}<Button variant="primary" label={t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')} disabled={busy || (!history.length && (offline || !canCreateProjectConversation()))} onPress={() => { void start(task, 'chat'); }} testID="project-task-open-chat"><Ionicons name="chatbubble-outline" size={16} color={theme.colors.text} /><Text style={styles.body}>{t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')}</Text></Button>
            {!mobile && canExecute && <Button variant="primary" label={t('projectGoals.execute')} disabled={busy || offline} onPress={() => { void start(task, 'execute'); }} testID="project-task-execute"><Ionicons name="play" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.execute')}</Text></Button>}{busy && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}</>}>
        {!mobile && tab === 'files' ? <WorkspaceDirectoryTree sessionId={conversationId ?? ''} rootPath={workspace.root} listDirectory={listDirectory} cacheKey={directoryCacheKey} revision={directoryRevision} onOpenFile={path => { void openFile(path); }} />
            : <ScrollView style={styles.detailScroll}><ProjectTaskDetails task={task} number={allTasks.indexOf(task) + 1} approval={<ApprovalTag task={task} />} editDisabled={busy || (!history.length && (!canCreateProjectConversation() || offline))} onEdit={() => { void start(task, 'chat'); }} onDelivery={() => props.editDelivery([task])} deliveryDisabled={readOnly || offline || busy}>
                {task.artifacts.filter(artifact => artifact.relation === 'output').map(artifact => <Deliverable key={artifact.id} {...{ artifact, task, machineId, featurePath, refresh }} openFile={openFile} offline={offline} />)}
            </ProjectTaskDetails></ScrollView>}
        {(error || conversationRejected) && <Text accessibilityRole="alert" style={[styles.error, { padding: 12 }]}>{error || t('projectGoals.sessionUnavailable')}</Text>}
        {!readOnly && task.execution?.state === 'uncertain' && <Text style={[styles.meta, { paddingHorizontal: 14, paddingVertical: 6 }]}>{t('projectGoals.executionUncertain')}</Text>}
    </ProjectDetailsPanel>;
    const chat = <View testID="project-task-chat" style={[styles.chat, { backgroundColor: surface }, wide && fileOpen && !workspace.maximized && splitFile ? { flexGrow: 0, flexShrink: 0, flexBasis: chatWidth, width: chatWidth, minWidth: 310 } : {}, wide && fileOpen && !splitFile && compactTab === 'file' && { display: 'none' }]}>
        <View style={styles.historyHeader}>{!mobile && <Button variant="toolbar" label={t(desktop && wide ? props.taskNavigationCollapsed ? 'projectGoals.showTasks' : 'projectGoals.collapseTasks' : 'projectGoals.backTasks')} onPress={() => { if (desktop && wide) props.setTaskNavigationCollapsed(!props.taskNavigationCollapsed); else { setCompactTab('tasks'); if (wide) selectConversation(''); } }} testID="project-task-navigation-toggle"><Ionicons name="list-outline" size={16} color={theme.colors.textSecondary} /></Button>}
            <Button ref={historyAnchor} variant="toolbar" label={t('projectGoals.history')} expanded={historyOpen} onPress={() => {
                historyAnchor.current?.measureInWindow((x, y, _width, height) => { setHistoryPosition({ x, y: y + height + 6 }); setHistoryOpen(true); void taskHistory.read(); });
            }} testID="project-task-history"><Ionicons name="time-outline" size={15} color={theme.colors.textSecondary} /><Text style={styles.meta}>{t('projectGoals.history')} · {history.length}</Text><Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} /></Button></View>
        {historyOpen && <RNModal transparent visible animationType="none" onRequestClose={() => setHistoryOpen(false)}>
            <Pressable style={styles.historyBackdrop} accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={() => setHistoryOpen(false)} />
            <View testID="project-task-history-menu" style={[styles.historyPopover, { ...(mobile ? { bottom: 12 } : {}), left: Math.max(12, Math.min(historyPosition.x, windowWidth - Math.min(350, windowWidth - 24) - 12)), top: mobile ? undefined : Math.max(12, Math.min(historyPosition.y, windowHeight - 180)), width: Math.min(350, windowWidth - 24), maxHeight: mobile ? windowHeight * 0.7 : Math.max(100, Math.min(360, windowHeight - historyPosition.y - 16)) }]}>
            <ScrollView style={styles.historyList}>{canCreateProjectConversation() && <Button variant="toolbar" label={t('projectGoals.newChat')} disabled={busy || offline} onPress={() => { setHistoryOpen(false); void start(task, 'chat', false, true); }} testID="project-task-new-chat"><Ionicons name="add-outline" size={16} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.newChat')}</Text></Button>}{history.map(session => <Button key={session.sessionId} variant="row" label={session.title} selected={conversationId === session.sessionId} onPress={() => { selectConversation(session.sessionId); setHistoryOpen(false); }} testID={`project-task-history-${session.sessionId}`}><View style={styles.cardBody}><Text numberOfLines={2} style={styles.body}>{session.title}</Text><Text style={styles.meta}>{new Date(session.updatedAt).toLocaleString()}</Text></View></Button>)}
            {taskHistory.loading && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
            {taskHistory.error && <><Text style={styles.error}>{taskHistory.error}</Text><Button label={t('common.retry')} onPress={() => { void taskHistory.read(); }}><Text style={styles.link}>{t('common.retry')}</Text></Button></>}
            {taskHistory.nextCursor && <Button label={t('projectGoals.moreHistory')} disabled={taskHistory.loading} onPress={() => { void taskHistory.read(taskHistory.nextCursor); }}><Text style={styles.link}>{t('projectGoals.moreHistory')}</Text></Button>}
            {!history.length && !taskHistory.loading && <Text style={styles.meta}>{t(!canCreateProjectConversation() ? 'projectGoals.noMatchingHistory' : 'projectGoals.noHistory')}</Text>}</ScrollView></View></RNModal>}
        {conversationId && !conversationVerified ? <View style={styles.empty} testID="project-conversation-loading">{!error && !conversationRejected && !offline && <ActivityIndicator color={theme.colors.textSecondary} />}<Text style={styles.meta}>{error || t(conversationRejected ? 'projectGoals.sessionUnavailable' : offline ? 'projectGoals.offlineArchive' : 'common.loading')}</Text>{error && !offline && <Button label={t('common.retry')} onPress={() => { setError(null); retryConversation(); }}><Text style={styles.link}>{t('common.retry')}</Text></Button>}</View> : conversationId ? <SafeAreaInsetsContext.Provider value={mobile ? { ...safeArea, top: 0, bottom: 0 } : safeArea}><SessionView key={conversationId} id={conversationId} embedded fullWidth projectTaskContext={mobile} emptyState={desktop || mobile ? appendDraft => <ProjectConversationEmptyState task={task} scrollable={false} onDraft={appendDraft} onFiles={showTaskFiles} /> : undefined} /></SafeAreaInsetsContext.Provider> : desktop || mobile ? emptyConversation : <View style={styles.empty}><Text style={styles.cardTitle}>{t('projectGoals.emptyChat')}</Text><Text style={styles.meta}>{t('projectGoals.emptyChatHint')}</Text><Button label={t('projectGoals.openChat')} disabled={busy || offline || !canCreateProjectConversation()} onPress={() => { void start(task, 'chat'); }}><Text style={styles.link}>{t('projectGoals.openChat')}</Text></Button></View>}
    </View>;
    const catalog = <ScrollView style={[styles.catalog, { backgroundColor: surface, borderRadius: 13 }]} contentContainerStyle={styles.taskCatalogContent}>
        <CatalogHeading title={props.featureTitle} subtitle={`${allTasks.length} ${t('projectGoals.tasks')}`} query={props.query} setQuery={props.setQuery} />
        <Button variant="toolbar" label={t('projectGoals.batchDelivery')} disabled={readOnly || offline} onPress={() => props.editDelivery(allTasks)}><Text style={styles.link}>{t('projectGoals.batchDelivery')}</Text></Button>
        <TaskCards onDelivery={target => props.editDelivery([target])} tasks={allTasks} query={props.query} status={props.statusFilter} setStatus={props.setStatusFilter} selectedId={task.id} onSelect={selectTask} onAction={(task, mode) => { void start(task, mode); }} busy={busy} offline={offline} hideExecution={executionAttempted} />
    </ScrollView>;
    if (mobile && props.mobileView === 'reader' && props.readerPath) {
        const artifact = task.artifacts.find(value => value.path === props.readerPath && value.relation === 'output');
        return <MobileProjectFileReader scope={JSON.stringify([machineId, featurePath, task.id])} path={props.readerPath} footer={artifact ? readable => <Deliverable {...{ artifact, task, machineId, featurePath, refresh }} openFile={openFile} offline={offline} readable={readable} /> : undefined} />;
    }
    if (mobile) return <View style={styles.mobileTaskArea}>
        <View style={styles.compactTabs}><PanelTabs touchTarget activeTab={mobileView} onTabChange={props.changeView} testIDPrefix="project-workspace" tabs={[
            { key: 'chat', label: t('projectGoals.mobileChat'), icon: 'chatbubble-outline' },
            { key: 'details', label: t('projectGoals.details'), icon: 'reader-outline' },
            { key: 'files', label: t('projectGoals.files'), icon: 'folder-outline' },
        ]} /></View>
        <View style={[styles.mobileView, mobileView !== 'chat' && styles.hidden]}>{chat}</View>
        <View style={[styles.mobileView, mobileView !== 'details' && styles.hidden]}>{details}</View>
        <View style={[styles.mobileView, mobileView !== 'files' && styles.hidden]}><WorkspaceDirectoryTree sessionId="" rootPath={workspace.root} listDirectory={listDirectory} cacheKey={directoryCacheKey} revision={directoryRevision} onOpenFile={path => { void openFile(path); }} /></View>
    </View>;
    return <View style={styles.taskArea}>
        {!wide && <View style={styles.compactTabs}><PanelTabs activeTab={compactTab} onTabChange={setCompactTab} testIDPrefix="project-workspace" tabs={[{ key: 'tasks', label: t('projectGoals.tasks'), icon: 'grid-outline' }, ...(showChat ? [{ key: 'chat', label: t('projectGoals.discussion'), icon: 'chatbubble-outline' as const }] : []), ...(fileOpen ? [{ key: 'file', label: t('projectGoals.files'), icon: 'document-outline' as const }] : []), { key: 'details', label: t('projectGoals.details'), icon: 'reader-outline' }]} /></View>}
        <View style={[styles.workspaceRow, !wide && { flexDirection: 'column' }]} onLayout={event => setRowWidth(Math.round(event.nativeEvent.layout.width))}>
            {wide ? <>
                {!!navigationWidth && <ProjectTaskNavigation tasks={allTasks} selectedId={task.id} query={props.query} setQuery={props.setQuery} onSelect={selectTask} onCollapse={() => props.setTaskNavigationCollapsed(true)} scrollPosition={props.taskNavigationScroll} width={navigationWidth} surface={surface} />}
                <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                    {fileOpen && taskNavigation && !splitFile && !workspace.maximized && <View style={{ height: 44, flexShrink: 0, paddingBottom: 6 }}><PanelTabs activeTab={compactTab === 'file' ? 'file' : 'chat'} onTabChange={setCompactTab} testIDPrefix="project-center" tabs={[{ key: 'chat', label: t('projectGoals.discussion'), icon: 'chatbubble-outline' }, { key: 'file', label: t('projectGoals.files'), icon: 'document-outline' }]} /></View>}
                    <View style={styles.workspaceRow}>
                        {!workspace.maximized && taskNavigation && chat}
                        {!workspace.maximized && !taskNavigation && catalog}
                        {fileOpen && <>{!workspace.maximized && taskNavigation && splitFile && <FileWorkspaceResizeHandle width={chatWidth} maximumWidth={getProjectChatMaximumWidth(contentWidth, rightWidth ?? 0)} />}<View style={{ flex: 1, minWidth: 0, minHeight: 0, ...(!splitFile && !workspace.maximized && compactTab !== 'file' ? { display: 'none' as const } : {}) }}><FileWorkspace framed readingSurface="inherited" sessionId={conversationId ?? ''} fileTreeExpanded={tab === 'files'} onToggleFileTree={() => setTab(value => value === 'files' ? 'details' : 'files')} /></View></>}
                    </View>
                </View>
                {details}
            </> : compactTab === 'details' ? details : compactTab === 'chat' ? chat : compactTab === 'file' ? <FileWorkspace framed readingSurface="inherited" sessionId={conversationId ?? ''} /> : catalog}
        </View>
    </View>;
}

function Deliverable({ artifact, task, machineId, featurePath, refresh, openFile, offline = false, readable = true }: { offline?: boolean; readable?: boolean; artifact: GoalArtifact; task: GoalTask; machineId: string; featurePath: string; refresh: () => Promise<void>; openFile: (path: string) => Promise<void> }) {
    const workspace = useFileWorkspace()!;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [openedLink, setOpenedLink] = React.useState<string | null>(null);
    const { theme } = useUnistyles();
    const document = artifact.path ? workspace.snapshot.documents[artifact.path] : undefined;
    const supportedDocument = Platform.OS === 'web' || !document?.media || document.media.mime.startsWith('image/');
    const hasReadVersion = artifact.path ? supportedDocument && !!document?.hash && document?.fileRevision === artifact.revision && document?.phase === 'ready' && document.draft === document.content : !!artifact.url && openedLink === artifact.revision;
    const accepted = artifact.available && artifact.approval?.status === 'accepted';
    const approve = async () => {
        if (!readable || offline || !artifact.available || !canConfirmProjectDeliverable() || !hasReadVersion || !artifact.revision || busy) return;
        if (!await Modal.confirm(t('projectGoals.approveTitle'), t(artifact.path ? 'projectGoals.approveMessage' : 'projectGoals.approveLinkMessage'))) return;
        setBusy(true); setError(null);
        try { await projectGoalRequest(machineId, 'goalTaskApprove', { featurePath, taskId: task.id, artifactId: artifact.id, expectedRevision: artifact.revision, expectedHash: document?.hash }); await refresh(); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <View style={styles.deliverable}>
        <Button variant="row" label={artifact.name} disabled={!artifact.available} onPress={() => { if (artifact.path) void openFile(artifact.path); else if (artifact.url) void openExternalUrl(artifact.url).then(() => setOpenedLink(artifact.revision ?? null)).catch(error => setError(String(error))); }} testID={`project-deliverable-${artifact.id}`}><Ionicons name={artifact.path ? 'document-outline' : 'open-outline'} size={16} color={theme.colors.textLink} /><View style={styles.cardBody}><Text style={styles.body}>{artifact.name}</Text>{artifact.description && <Text style={styles.meta}>{artifact.description}</Text>}</View></Button>
        <Text style={accepted ? styles.acceptedText : styles.pendingText}>{t(!artifact.available ? 'projectGoals.deliverableUnavailable' : accepted ? 'projectGoals.accepted' : artifact.approval?.status === 'changed' ? 'projectGoals.changed' : 'projectGoals.notReviewed')}</Text>
        {artifact.available && canConfirmProjectDeliverable() && !accepted && <Button label={t(artifact.path ? 'projectGoals.approve' : 'projectGoals.approveLink')} disabled={!readable || offline || !hasReadVersion || busy} onPress={() => { void approve(); }} testID={`project-deliverable-approve-${artifact.id}`}><Text style={styles.link}>{t(artifact.path ? 'projectGoals.approve' : 'projectGoals.approveLink')}</Text></Button>}
        {artifact.available && canConfirmProjectDeliverable() && !accepted && !hasReadVersion && <Text style={styles.meta}>{t(artifact.path ? 'projectGoals.readFileFirst' : 'projectGoals.openLinkFirst')}</Text>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>;
}
function Empty({ text }: { text: string }) { return <View style={styles.empty}><Text style={styles.meta}>{text}</Text></View>; }

const styles = StyleSheet.create(theme => ({
    mobileHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    mobileTitle: { fontSize: 16, lineHeight: 23, color: theme.colors.text, ...Typography.default('semiBold') },
    mobileSheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.modal.backdrop },
    mobileSheet: { maxHeight: '80%', padding: 16, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: theme.colors.surface },
    mobileCatalog: { paddingHorizontal: 16, paddingTop: 16, gap: 18 },
    mobileTaskCard: { width: '100%', minHeight: 0 },
    mobileCardActions: { alignItems: 'flex-end', paddingHorizontal: 12, paddingBottom: 10 },
    mobileTaskArea: { flex: 1, minHeight: 0 }, mobileView: { flex: 1, minHeight: 0 }, hidden: { display: 'none' },
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
    loadingCard: { borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, gap: 18 },
    skeletonLine: { height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceSelected },
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
