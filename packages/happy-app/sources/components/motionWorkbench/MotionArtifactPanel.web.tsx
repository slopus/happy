import * as React from 'react';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { MotionProject } from '@slopus/happy-wire';
import { Text } from '@/components/StyledText';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import { WorkspaceButton as Button } from '@/components/fileWorkspace/WorkspaceButton';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { Typography } from '@/constants/Typography';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { getServerUrl } from '@/sync/serverConfig';
import { storage, useSession, useSocketStatus } from '@/sync/storage';
import { resolveSessionState } from '@/utils/sessionUtils';
import { motionWorkbenchRequest } from '@/sync/motionWorkbench.web';
import { getCurrentLanguage, t } from '@/text';
import { Modal } from '@/modal';
import { linkMotionProject, loadMotionLinks, unlinkMotionProject, type MotionArtifactLink } from './motionArtifactLinks.web';

export type MotionArtifactPanelProps = { sessionId: string; mode?: 'summary' | 'library' };
const copy = (zh: string, en: string) => getCurrentLanguage().startsWith('zh') ? zh : en;
const filePath = (path: string) => path.replace(/\/$/, '') + '/mh.json';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The project library discovers candidates; only an explicit association adds a session reference. */
export function MotionArtifactPanel({ sessionId, mode = 'summary' }: MotionArtifactPanelProps) {
    const workspace = useFileWorkspace();
    const workspaceRef = React.useRef(workspace); workspaceRef.current = workspace;
    const session = useSession(sessionId);
    const { status } = useSocketStatus();
    const connected = status === 'connected' && !!session && resolveSessionState(session).isConnected;
    const connectedRef = React.useRef(connected); connectedRef.current = connected;
    const { theme } = useUnistyles();
    const root = workspace?.root ?? session?.metadata?.path ?? '';
    const links = loadMotionLinks(session?.metadata, root);
    const account = getRuntimeAccountSelection();
    const scope = JSON.stringify([getServerUrl(), account?.key, account?.generation, sessionId, session?.metadata?.machineId, root]);
    const scopeRef = React.useRef(scope); scopeRef.current = scope;
    const mounted = React.useRef(false), sequence = React.useRef(0), working = React.useRef(false);
    const [open, setOpen] = React.useState(false), [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
    const [query, setQuery] = React.useState('');
    const [projects, setProjects] = React.useState<MotionProject[]>([]);
    const [truncated, setTruncated] = React.useState(false);
    const current = (id: number, owner: string) => mounted.current && sequence.current === id
        && scopeRef.current === owner && accountRuntimeCurrent();
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
    React.useEffect(() => {
        sequence.current++; working.current = false; setOpen(false); setBusy(false); setError(''); setNotice(''); setQuery(''); setProjects([]); setTruncated(false);
    }, [scope]);
    const perform = async (operation: (id: number, owner: string) => Promise<void>) => {
        if (working.current || !connectedRef.current || !accountRuntimeCurrent()) return;
        working.current = true; setBusy(true); setError(''); setNotice('');
        const id = ++sequence.current, owner = scope;
        try { await operation(id, owner); }
        catch (failure) { if (current(id, owner)) setError(errorMessage(failure)); }
        finally { if (current(id, owner)) { working.current = false; setBusy(false); } }
    };
    const load = () => perform(async (id, owner) => {
        const result = await motionWorkbenchRequest(sessionId, 'motionWorkbenchList', {});
        if (!current(id, owner)) return;
        setProjects(result.projects); setTruncated(result.truncated);
    });
    const turn = session?.agentState?.turnStatus;
    const terminal = turn && ['completed', 'failed', 'cancelled'].includes(turn.status) ? `${turn.turnId}:${turn.updatedAt}` : null;
    const previousTurn = React.useRef({ scope, terminal });
    React.useEffect(() => {
        const previous = previousTurn.current; previousTurn.current = { scope, terminal };
        if (open && terminal && previous.scope === scope && previous.terminal !== terminal) void load();
    }, [scope, terminal, open, mode]);
    if (!workspace?.enabled || workspace.readOnly || !sessionId || !root || !workspace.openMotionProject) return null;
    const close = () => { sequence.current++; working.current = false; setOpen(false); setBusy(false); setError(''); };
    const openLibrary = () => { setOpen(true); void load(); };
    const openProject = (project: Pick<MotionProject, 'projectId' | 'projectPath' | 'title'>) => perform(async (id, owner) => {
        const verified = await motionWorkbenchRequest(sessionId, 'motionWorkbenchRegister', { projectPath: project.projectPath });
        if (!current(id, owner) || !connectedRef.current) return;
        if (verified.projectId !== project.projectId) throw new Error(copy('工程身份已变化，请刷新列表。', 'The project identity changed. Refresh the list.'));
        await workspaceRef.current?.openMotionProject?.(verified.projectPath);
        if (current(id, owner)) { setOpen(false); }
    });
    const link = (project: MotionProject) => perform(async (id, owner) => {
        const verified = await motionWorkbenchRequest(sessionId, 'motionWorkbenchRegister', { projectPath: project.projectPath });
        if (!current(id, owner) || !connectedRef.current) return;
        if (verified.projectId !== project.projectId) throw new Error(copy('工程身份已变化，请刷新列表。', 'The project identity changed. Refresh the list.'));
        await linkMotionProject(sessionId, verified);
        if (current(id, owner)) setNotice(copy('已关联到本会话；还未选择为本次修改对象。', 'Associated with this conversation; not selected as the current edit target.'));
    });
    const setTarget = (project: MotionArtifactLink) => perform(async (id, owner) => {
        const snapshot = await motionWorkbenchRequest(sessionId, 'motionWorkbenchInspect', { projectPath: project.projectPath });
        if (!current(id, owner) || !connectedRef.current) return;
        if (snapshot.projectId !== project.projectId || snapshot.projectPath !== project.projectPath) throw new Error(copy('工程身份已变化，请刷新后重选。', 'The project identity changed. Refresh and select it again.'));
        if (!loadMotionLinks(storage.getState().sessions[sessionId]?.metadata, root).some(value => value.projectId === project.projectId)) {
            throw new Error(copy('此会话已移除工程关联，请重新关联。', 'This conversation no longer references the project. Associate it again.'));
        }
        workspaceRef.current?.setReference({ path: filePath(snapshot.projectPath), hash: snapshot.snapshotHash,
            motion: { projectId: snapshot.projectId, projectPath: snapshot.projectPath, title: project.title,
                documentRevision: snapshot.documentRevision, buildId: snapshot.buildId, markerVersion: snapshot.markerVersion, snapshotHash: snapshot.snapshotHash } });
        setNotice(copy('已设为本次修改对象；输入要求后再发送。', 'Selected as the current edit target. Enter your instructions before sending.'));
    });
    const unlink = (project: MotionArtifactLink) => perform(async (id, owner) => {
        const confirmed = await Modal.confirm(copy('移除会话关联', 'Remove conversation reference'),
            copy('只移除此会话的关联，不会删除工程，也不影响其他会话。', 'This removes only this conversation reference. It does not delete the project or affect other conversations.'));
        if (!confirmed || !current(id, owner) || !connectedRef.current) return;
        await unlinkMotionProject(sessionId, project.projectId);
        if (!current(id, owner)) return;
        workspaceRef.current?.setReference(reference => reference?.motion?.projectId === project.projectId ? null : reference);
        setNotice(copy('已移除本会话关联，原工程仍保留。', 'Conversation reference removed. The original project remains.'));
    });
    const openFiles = () => perform(async (id, owner) => {
        await workspaceRef.current?.openReference(root);
        if (current(id, owner)) setOpen(false);
    });
    const statusContent = <>
        {!connected && <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: theme.colors.textSecondary }}>{t('motionWorkbench.offline')}</Text>}
        {!!error && <Text accessibilityRole="alert" selectable style={{ fontSize: 12, color: theme.colors.textDestructive }}>{error}</Text>}
        {!!notice && <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: theme.colors.textSecondary }}>{notice}</Text>}
    </>;
    const filtered = projects.filter(project => project.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const library = <View style={{ gap: 12, padding: 14, minWidth: 0, maxHeight: '100%' }}>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{copy('当前目录中的影片是可关联候选，不会自动加入会话。文档与导出视频可从项目文件查看。', 'Films in this workspace are candidates, not automatic conversation references. Documents and exported videos remain in project files.')}</Text>
        <TextInput accessibilityLabel={t('motionWorkbench.searchProjects')} placeholder={t('motionWorkbench.searchProjects')} value={query} onChangeText={setQuery}
            placeholderTextColor={theme.colors.input.placeholder} style={{ ...Typography.default(), padding: 10, borderRadius: 8, backgroundColor: theme.colors.input.background, color: theme.colors.input.text, borderWidth: 1, borderColor: theme.colors.divider }} />
        {busy && <ActivityIndicator color={theme.colors.textSecondary} />}
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 8 }}>
            {filtered.map(project => {
                const associated = links.some(value => value.projectId === project.projectId);
                return <View key={project.projectId} testID={`motion-candidate:${project.projectId}`} style={{ padding: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, gap: 7, backgroundColor: theme.colors.surface }}>
                    <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') }}>{project.title}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{copy('影片工程', 'Editable film project')}{project.modifiedAt > 0 ? ` · ${new Date(project.modifiedAt).toLocaleString()}` : ''}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        <Button label={copy('打开工程', 'Open project')} icon="film-outline" testID={`motion-candidate-open:${project.projectId}`} disabled={busy || !connected} onPress={() => { void openProject(project); }} />
                        <Button label={associated ? copy('已关联本会话', 'Associated') : copy('关联到本会话', 'Associate with conversation')} icon="link-outline" selected={associated} testID={`motion-artifact-link:${project.projectId}`} disabled={busy || !connected || associated} onPress={() => { void link(project); }} />
                    </View>
                </View>;
            })}
            {!filtered.length && !busy && !error && connected && <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{projects.length ? t('motionWorkbench.noMatchingProjects') : t('motionWorkbench.emptyProjects')}</Text>}
        </ScrollView>
        {truncated && <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>{t('motionWorkbench.limitedProjects')}</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Button label={copy('查看项目文件', 'View project files')} icon="folder-open-outline" disabled={busy || !connected} testID="motion-artifacts-files" onPress={() => { void openFiles(); }} />
            <Button label={t('fileWorkspace.refresh')} icon="refresh-outline" disabled={busy || !connected} testID="motion-artifacts-refresh" onPress={() => { void load(); }} />
        </View>
    </View>;
    return <View testID={mode === 'summary' ? 'motion-artifact-summary' : 'motion-artifact-library'} style={{ minWidth: 0, gap: 8 }}>
        {mode === 'summary' && !!links.length && <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}>{copy('本会话影片', 'Films referenced here')}</Text>}
        {mode === 'summary' && links.map(project => <View key={project.projectId} testID={`motion-artifact:${project.projectId}`} style={{ padding: 11, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, backgroundColor: theme.colors.surface, gap: 6 }}>
            <Text numberOfLines={2} style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}>{project.title}</Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{copy('影片工程 · 保存在项目中', 'Editable film project · Saved in workspace')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3 }}>
                <Button label={copy('打开工程', 'Open project')} icon="film-outline" testID={`motion-artifact-open:${project.projectId}`} disabled={busy || !connected} onPress={() => { void openProject(project); }} />
                <Button label={copy('设为本次修改对象', 'Use as current edit target')} selected={workspace.reference?.motion?.projectId === project.projectId} testID={`motion-artifact-target:${project.projectId}`} disabled={busy || !connected} onPress={() => { void setTarget(project); }} />
                <Button label={copy('移除会话关联', 'Remove conversation reference')} icon="unlink-outline" compact testID={`motion-artifact-unlink:${project.projectId}`} disabled={busy || !connected} onPress={() => { void unlink(project); }} />
            </View>
        </View>)}
        <Button label={copy('项目产物 / 关联产物', 'Project artifacts / Associate')} icon="folder-open-outline" popup="dialog" expanded={open} disabled={busy || !connected} testID="motion-artifacts-open" onPress={() => { if (open) close(); else openLibrary(); }} />
        {statusContent}
        <DesktopDialogFrame visible={open} title={copy('项目产物 · 关联到会话', 'Project artifacts · Associate with conversation')} testID="motion-artifacts-dialog" onClose={close} maxWidth={640}>
            {library}
            <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 6 }}>{statusContent}</View>
        </DesktopDialogFrame>
    </View>;
}
