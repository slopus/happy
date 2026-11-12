import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GoalScopeOverviewSchema, type GoalTaskSession } from '@slopus/happy-wire';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage } from '@/sync/storage';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { machineStartGoalAuthor, type DirectoryEntry } from '@/sync/ops';
import { canCreateProjectConversation, loadProjectScope, loadProjectScopeHistory, projectGoalRequest, projectScopeFiles } from '@/sync/projectGoals';
import { projectCacheKey, projectHistorySchema, writeProjectCache, isProjectSessionDeleted } from '@/sync/projectWorkspaceCache';
import { SessionView } from '@/-session/SessionView';
import { SessionFileWorkspaceProvider } from '@/components/fileWorkspace/SessionFileWorkspaceProvider';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { ProjectArchiveTree } from './ProjectArchiveTree';
import { FileWorkspace } from '@/components/fileWorkspace/FileWorkspace';
import { PanelTabs } from '@/components/PanelTabs';
import { useCachedProjectResource } from './useProjectData';
import { ProjectDetailsPanel } from './ProjectDetailsPanel';
import { ProjectConversationHeader } from './ProjectConversationHeader';
import { ProjectConversationEmptyState } from './ProjectConversationEmptyState';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { projectPanelGap, getProjectCatalogWidth } from './projectWorkspaceLayout';

export type ProjectOverviewProps = {
    machineId: string; scopePath: string; title: string; conversationId?: string;
    agent: 'codex' | 'claude'; offline: boolean; connecting?: boolean; revision?: string; surface: string;
    selectConversation: (id: string) => void; children: React.ReactNode;
};
export function ProjectOverviewWorkspace(props: ProjectOverviewProps) {
    const binding = React.useMemo(() => projectScopeFiles(props.machineId, props.scopePath), [props.machineId, props.scopePath]);
    return <SessionFileWorkspaceProvider sessionId={props.conversationId ?? ''} binding={binding}><OverviewContent {...props} /></SessionFileWorkspaceProvider>;
}
function OverviewContent(props: ProjectOverviewProps) {
    const { machineId, scopePath, offline, surface } = props;
    const { theme } = useUnistyles();
    const workspace = useFileWorkspace()!;
    const read = React.useCallback(() => loadProjectScope(machineId, scopePath, props.revision), [machineId, scopePath, props.revision]);
    const overview = useCachedProjectResource(projectCacheKey('overview', machineId, scopePath), GoalScopeOverviewSchema, read, !offline, props.revision);
    const readHistory = React.useCallback(async () => ({ sessions: await loadProjectScopeHistory(machineId, scopePath) }), [machineId, scopePath]);
    const historyResource = useCachedProjectResource(projectCacheKey('history', machineId, scopePath), projectHistorySchema, readHistory, !offline, props.revision);
    const [localHistory, setLocalHistory] = React.useState<GoalTaskSession[]>([]);
    const storedSessions = storage(state => state.sessions);
    const history = [...new Map([...(historyResource.value?.sessions ?? []), ...localHistory].map(session => [session.sessionId, session])).values()]
        .filter(session => {
            const metadata = storedSessions[session.sessionId]?.metadata;
            return session.directory === scopePath && !isProjectSessionDeleted(session.sessionId) && (!metadata || (metadata.machineId === machineId && (!metadata.goalBoard || (!metadata.goalBoard.taskId && metadata.goalBoard.featurePath === scopePath))));
        }).sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
    const conversationId = history.find(session => session.sessionId === props.conversationId)?.sessionId;
    const showChat = !!props.conversationId;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [tab, setTab] = React.useState('details');
    const [center, setCenter] = React.useState('tasks');
    const { width } = useWindowDimensions();
    const [rowWidth, setRowWidth] = React.useState(0);
    const wide = width >= 1100;
    const rightWidth = Math.min(340, Math.max(280, rowWidth * 0.3));
    const fileOpen = workspace.enabled && workspace.snapshot.open;
    const centerOpen = showChat || fileOpen;
    const catalogWidth = getProjectCatalogWidth(rowWidth, rightWidth);
    const alive = React.useRef(true);
    const opening = React.useRef(false);
    const focus = React.useRef(0);
    useFocusEffect(React.useCallback(() => { focus.current++; return () => { focus.current++; }; }, []));
    const latestConversation = React.useRef(props.conversationId); latestConversation.current = props.conversationId;
    const attempt = React.useRef<{ action: 'new' | 'continue'; id: string } | undefined>(undefined);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    React.useEffect(() => { if (props.conversationId) setCenter('chat'); }, [props.conversationId]);
    const start = async (forceNew = false) => {
        if (opening.current) return;
        // Always verify the scope's own history before creating anything.
        opening.current = true; setBusy(true); setError(null);
        const owner = getRuntimeAccountSelection(), requestedConversation = latestConversation.current, epoch = focus.current;
        const isCurrent = () => alive.current && focus.current === epoch && getRuntimeAccountSelection() === owner && latestConversation.current === requestedConversation;
        try {
            const fresh = offline || forceNew ? [] : await loadProjectScopeHistory(machineId, scopePath);
            const sessions = [...new Map([...history, ...fresh].map(session => [session.sessionId, session])).values()]
                .filter(session => session.directory === scopePath && !isProjectSessionDeleted(session.sessionId))
                .sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
            if (!isCurrent()) return;
            let id = forceNew ? undefined : sessions[0]?.sessionId;
            if (!id) {
                if (offline || !canCreateProjectConversation()) return;
                const action = forceNew ? 'new' : 'continue';
                if (attempt.current?.action !== action) attempt.current = { action, id: `goal-scope-${Date.now()}-${Math.random().toString(36).slice(2)}` };
                const result = await machineStartGoalAuthor(machineId, { scopePath, requestId: attempt.current.id, agent: props.agent });
                if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : t('projectGoals.overviewUnavailable'));
                id = result.sessionId;
            }
            if (!isCurrent()) return;
            const linked = sessions.find(session => session.sessionId === id) ?? { sessionId: id, title: props.title, directory: scopePath, updatedAt: Date.now(), executed: false };
            setLocalHistory(values => [...values.filter(session => session.sessionId !== id), linked]);
            writeProjectCache(projectCacheKey('history', machineId, scopePath), { sessions: [linked, ...sessions.filter(session => session.sessionId !== id)] });
            props.selectConversation(id); setCenter('chat'); attempt.current = undefined;
        } catch (error) { if (isCurrent()) setError(error instanceof Error ? error.message : String(error)); }
        finally { opening.current = false; if (alive.current) setBusy(false); }
    };
    const listDirectory = React.useCallback(async (_sessionId: string, path: string) => {
        try { return await projectGoalRequest<{ success: boolean; entries?: DirectoryEntry[]; error?: string }>(machineId, 'goalScopeListDirectory', { featurePath: scopePath, path }); }
        catch (error) { return { success: false, error: String(error) }; }
    }, [machineId, scopePath]);
    const openFile = (path: string) => {
        setCenter('file');
        const alreadyOpen = !!workspace.controller.getSnapshot().documents[path];
        void workspace.openReference(path).then(() => { if (alreadyOpen) return workspace.controller.refresh(path); });
    };
    const showFiles = () => { setTab('files'); if (!wide) setCenter('details'); else if (fileOpen) setCenter('file'); };
    const changeTab = (value: string) => { setTab(value); if (value === 'details' && showChat) setCenter('chat'); else if (value === 'files' && fileOpen) setCenter('file'); };
    const info = overview.value;
    const chatDisabled = busy || (!history.length && (offline || !canCreateProjectConversation()));
    const maximized = fileOpen && workspace.maximized;
    React.useEffect(() => { if (!fileOpen && workspace.maximized) workspace.setMaximized(false); }, [fileOpen, workspace.maximized, workspace.setMaximized]);
    const panel = <ProjectDetailsPanel testID="project-scope-panel" style={{ backgroundColor: surface, ...(wide ? { width: rightWidth, marginLeft: projectPanelGap } : { flex: 1 }) }} tab={tab} onTab={changeTab}
        header={<><Ionicons name="compass-outline" size={17} color={theme.colors.textLink} /><Text style={styles.label}>{t('projectGoals.globalOverview')}</Text></>}
        footer={<><Button variant="primary" testID="project-scope-open-chat" label={t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')} disabled={chatDisabled} onPress={() => { void start(); }}><Ionicons name="chatbubble-outline" size={16} color={theme.colors.text} /><Text style={styles.body}>{t(history.length ? 'projectGoals.continueChat' : 'projectGoals.openChat')}</Text></Button>{busy && <ActivityIndicator color={theme.colors.textLink} size="small" />}</>}>
        {tab === 'files' ? <ProjectArchiveTree machineId={machineId} scopePath={scopePath} sessionId={conversationId ?? ''} rootPath={scopePath} listDirectory={listDirectory} onOpenFile={openFile} /> : <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.brief}>
            <Text accessibilityRole="header" style={styles.title}>{info?.title || props.title}</Text>
            <View style={styles.section}><View style={styles.line}><Text style={styles.label}>{t('projectGoals.scopeGoal')}</Text><Button variant="toolbar" label={t('projectGoals.editWithAI')} disabled={chatDisabled} onPress={() => { void start(); }}><Ionicons name="sparkles-outline" size={12} color={theme.colors.textLink} /><Text style={styles.link}>{t('projectGoals.editWithAI')}</Text></Button></View>
                <Text selectable style={styles.goal}>{info ? info.goal || t('projectGoals.noScopeGoal') : t(props.connecting || overview.loading ? 'common.loading' : 'projectGoals.overviewUnavailable')}</Text></View>
            <View style={styles.section}><View style={styles.line}><Text style={styles.label}>{t('projectGoals.archiveFiles')}</Text><Text style={styles.meta} testID="project-scope-file-count">{info ? t(info.countComplete ? 'projectGoals.fileCount' : 'projectGoals.fileCountPartial', { count: info.fileCount }) : '—'}</Text></View>
                <Button variant="row" label={t('projectGoals.scopeIndex')} disabled={!info} testID="project-scope-index" onPress={() => { if (info) openFile(info.indexPath); }}><Ionicons name="document-text-outline" size={18} color={theme.colors.textLink} /><Text style={styles.body}>index.md</Text><Ionicons name="arrow-forward" size={14} color={theme.colors.textSecondary} /></Button>
                <Button variant="toolbar" label={t('projectGoals.files')} onPress={showFiles}><Ionicons name="folder-open-outline" size={16} color={theme.colors.textSecondary} /><Text style={styles.meta}>{t('projectGoals.files')}</Text></Button></View>
            <Text style={styles.meta}>{t('projectGoals.overviewChatHint')}</Text>
            {overview.error && <View style={styles.section}><Text accessibilityRole="alert" style={styles.error}>{overview.error}</Text><Button label={t('common.retry')} onPress={() => { void overview.refresh(); }}><Text style={styles.link}>{t('common.retry')}</Text></Button></View>}
        </ScrollView>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </ProjectDetailsPanel>;
    const chat = <View style={[styles.center, { backgroundColor: surface }]} testID="project-scope-chat">
        <ProjectConversationHeader testIDPrefix="project-scope" sessions={history} selectedId={conversationId} onSelect={id => { props.selectConversation(id); setCenter('chat'); }} onNew={canCreateProjectConversation() ? () => { void start(true); } : undefined} onRefresh={() => { void historyResource.refresh(); }} loading={historyResource.loading} error={historyResource.error} onRetry={() => { void historyResource.refresh(); }} busy={busy} offline={offline} />
        {conversationId ? <SessionView key={conversationId} id={conversationId} embedded fullWidth emptyState={appendDraft => <ProjectConversationEmptyState task={{ title: props.title, goal: info?.goal ?? '' }} onDraft={appendDraft} onFiles={showFiles} scrollable={false} />} /> : <View style={styles.brief}><Text style={styles.meta}>{t(historyResource.loading ? 'common.loading' : 'projectGoals.sessionUnavailable')}</Text></View>}
    </View>;
    return <View style={styles.area} testID="project-overview-workspace">
        {!wide && <View style={styles.compactTabs}><PanelTabs activeTab={center} onTabChange={setCenter} testIDPrefix="project-overview" tabs={[{ key: 'tasks', label: t('projectGoals.tasks'), icon: 'grid-outline' }, ...(showChat ? [{ key: 'chat', label: t('projectGoals.discussion'), icon: 'chatbubble-outline' as const }] : []), ...(fileOpen ? [{ key: 'file', label: t('projectGoals.files'), icon: 'document-outline' as const }] : []), { key: 'details', label: t('projectGoals.globalOverview'), icon: 'compass-outline' }]} /></View>}
        <View style={styles.row} onLayout={event => setRowWidth(Math.round(event.nativeEvent.layout.width))}>
            {wide ? <><View testID="project-scope-catalog" style={[{ minWidth: 0, minHeight: 0 }, centerOpen ? { width: catalogWidth, flexBasis: catalogWidth, flexGrow: 0, flexShrink: 0, marginRight: projectPanelGap } : { flex: 1 }, maximized && { display: 'none' }]}>{props.children}</View>
                {centerOpen && <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                    {!maximized && showChat && fileOpen && <View style={styles.compactTabs}><PanelTabs testIDPrefix="project-scope-center" activeTab={center === 'file' ? 'file' : 'chat'} onTabChange={setCenter} tabs={[{ key: 'chat', label: t('projectGoals.discussion'), icon: 'chatbubble-outline' }, { key: 'file', label: t('projectGoals.files'), icon: 'document-outline' }]} /></View>}
                    <View style={styles.row}>{!maximized && showChat && <View style={{ flex: 1, minWidth: 0, minHeight: 0, ...(fileOpen && center === 'file' ? { display: 'none' as const } : {}) }}>{chat}</View>}{fileOpen && <View style={{ flex: 1, minWidth: 0, minHeight: 0, ...(!maximized && showChat && center !== 'file' ? { display: 'none' as const } : {}) }}><FileWorkspace sessionId={conversationId ?? ''} framed readingSurface="inherited" fileTreeExpanded={tab === 'files'} onToggleFileTree={() => changeTab(tab === 'files' ? 'details' : 'files')} /></View>}</View>
                </View>}{panel}</> : center === 'details' ? panel : center === 'file' && fileOpen ? <FileWorkspace sessionId={conversationId ?? ''} framed readingSurface="inherited" /> : center === 'chat' && showChat ? chat : props.children}
        </View>
    </View>;
}
const styles = StyleSheet.create(theme => ({
    area: { flex: 1, minWidth: 0, minHeight: 0, padding: 10 }, row: { flex: 1, minWidth: 0, minHeight: 0, flexDirection: 'row' },
    center: { flex: 1, minWidth: 0, minHeight: 0, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, overflow: 'hidden' },
    brief: { padding: 20, gap: 22 }, section: { gap: 12 }, line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
    title: { fontSize: 21, lineHeight: 30, color: theme.colors.text, ...Typography.default('semiBold') },
    label: { fontSize: 12, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    body: { fontSize: 13, lineHeight: 21, color: theme.colors.text, ...Typography.default() },
    goal: { fontSize: 13, lineHeight: 24, color: theme.colors.textSecondary, ...Typography.default() },
    meta: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    link: { fontSize: 11, color: theme.colors.textLink, ...Typography.default() },
    history: { minHeight: 48, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, justifyContent: 'center' },
    compactTabs: { height: 44, flexShrink: 0, paddingBottom: 6 }, error: { padding: 12, color: theme.colors.textDestructive, fontSize: 12 },
}));
