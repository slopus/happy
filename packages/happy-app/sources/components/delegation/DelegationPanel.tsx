import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DelegationRoleInputSchema, type DelegationRole, type DelegationRoleInput, type DelegatedTask, type DelegatedTaskStatus, type DelegatedTaskSummary, type DelegatedTaskVersion } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useSession, useMachine } from '@/sync/storage';
import { listDelegationRoles, saveDelegationRole, deleteDelegationRole, readDelegatedTask, cancelDelegatedTask } from '@/sync/apiDelegation';
import { useRightSwipePanel } from '../RightSwipePanelHost';
import { useDesktopReadingWidth } from '../DesktopReadingWidth';
import { CodingAgentIcon } from '../codingAgents/CodingAgentIcon';
import { useSubagentInspector, type SubagentInspectorSelection } from '../subagent/SubagentInspectorContext';

const EMPTY_ROLES: DelegationRole[] = [];
function roleInput(role: DelegationRole): DelegationRoleInput {
    return { id: role.id, name: role.name, description: role.description, agent: role.agent, model: role.model, effort: role.effort, autoDelegate: role.autoDelegate };
}
function newRole(): DelegationRoleInput {
    return { id: randomUUID(), name: '', description: '', agent: 'antigravity', model: '', autoDelegate: true };
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : t('delegation.requestFailed'); }
function agentLabel(agent: string) { return agent === 'antigravity' ? 'AGY' : 'Codex'; }
export function delegatedStatusLabel(status: DelegatedTaskStatus): string {
    switch (status) {
        case 'starting': return t('delegation.starting');
        case 'running': return t('delegation.running');
        case 'waiting-for-input': return t('delegation.waiting');
        case 'completed': return t('delegation.completed');
        case 'failed': return t('delegation.failed');
        case 'cancelled': return t('delegation.cancelled');
        case 'interrupted': return t('delegation.interrupted');
    }
}
function Button({ label, onPress, disabled, selected, destructive, testID }: {
    label: string; onPress: () => void; disabled?: boolean; selected?: boolean; destructive?: boolean; testID?: string;
}) {
    const [focused, setFocused] = React.useState(false);
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled}
        testID={testID} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} hitSlop={5}
        style={(state: { pressed: boolean; hovered?: boolean }) => [styles.button, (state.pressed || state.hovered) && styles.pressed, selected && styles.selected, focused && styles.focused, disabled && styles.disabled]}>
        <Text style={[styles.buttonText, destructive && styles.error]}>{label}</Text>
    </Pressable>;
}

/** The pill only opens management; creation and dispatch use the main agent's real tools. */
export const DelegationAssistantBar = React.memo(function DelegationAssistantBar({ sessionId }: { sessionId: string }) {
    const session = useSession(sessionId);
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const inspector = useSubagentInspector();
    const metadataRoles = session?.metadata?.delegationRoles;
    const roles = inspector?.delegationRoles ?? metadataRoles ?? EMPTY_ROLES;
    React.useEffect(() => { inspector?.setDelegationRoles?.(null); }, [metadataRoles]);
    if (!inspector || (!session?.metadata?.delegationProtocol && machine?.metadata?.delegation !== 1 && !roles.length)) return null;
    const first = roles[0];
    const open = () => inspector.open({ kind: 'agent-roles', id: 'agent-roles', title: t('delegation.rolesTitle'), status: 'completed', roleId: first?.id });
    return <View style={styles.assistantBar} testID="delegation-assistant-bar">
        <Pressable accessibilityRole="button" accessibilityLabel={t('delegation.rolesTitle')} onPress={open}
            style={({ pressed }) => [styles.pill, pressed && styles.pressed]} testID="delegation-assistant-pill">
            {first ? <CodingAgentIcon agent={first.agent} size={16} /> : null}
            <Text numberOfLines={1} style={styles.pillTitle}>{first?.name ?? t('delegation.assistants')}</Text>
            {first ? <Text numberOfLines={1} style={styles.pillRoute}>{agentLabel(first.agent)} / {first.model}</Text> : null}
        </Pressable>
        <Button label={t('delegation.manage')} onPress={open} testID="delegation-manage" />
    </View>;
});

/** A distinct footer group: external sessions are never inserted into the native tool tree. */
export const DelegatedTaskGroup = React.memo(function DelegatedTaskGroup({ sessionId }: { sessionId: string }) {
    const session = useSession(sessionId);
    const inspector = useSubagentInspector();
    const { theme } = useUnistyles();
    const readingWidth = useDesktopReadingWidth();
    const [expanded, setExpanded] = React.useState(true);
    const [compact, setCompact] = React.useState(false);
    const tasks = (session?.metadata?.delegatedTasks ?? []).filter(task => task.parentSessionId === sessionId);
    if (!tasks.length || !inspector) return null;
    return <View style={[styles.taskGroup, { maxWidth: readingWidth }]} onLayout={event => setCompact(event.nativeEvent.layout.width < 540)} testID="delegated-task-group">
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} aria-expanded={expanded}
            onPress={() => setExpanded(value => !value)} style={({ pressed }) => [styles.groupHeading, pressed && styles.pressed]} testID="delegated-task-group-toggle">
            <View style={styles.stack}>{tasks.slice(0, 3).map((task, index) => <View key={task.id} style={[styles.avatar, index > 0 && styles.stacked]}><CodingAgentIcon agent={task.agent} size={18} /></View>)}</View>
            <Text style={styles.heading}>{t('delegation.count', { count: tasks.length })}</Text>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
        </Pressable>
        {expanded ? <View style={styles.taskList}>{tasks.map(task => {
            const selected = inspector.selection?.kind === 'delegated-task' && inspector.selection.id === task.id;
            return <Pressable key={task.id} accessibilityRole="button" accessibilityLabel={task.title} accessibilityState={{ expanded: selected }} aria-expanded={selected}
                onPress={() => inspector.open({ kind: 'delegated-task', id: task.id, title: task.title, status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'running' })}
                style={(state: { pressed: boolean; hovered?: boolean }) => [styles.taskRow, (state.pressed || state.hovered) && styles.pressed, selected && styles.selected]}
                testID={`delegated-task-${task.id}`}>
                <View style={styles.avatar}><CodingAgentIcon agent={task.agent} size={18} /></View>
                <View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>{task.title}</Text><Text numberOfLines={1} style={styles.secondary}>{task.roleName} · {agentLabel(task.agent)} / {task.model}</Text></View>
                <View style={[styles.rowMeta, compact && styles.compactMeta]}><Text style={[styles.status, ['failed', 'interrupted'].includes(task.status) && styles.error]}>{delegatedStatusLabel(task.status)}</Text><Text style={styles.caption}>v{task.version}</Text></View>
                <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
            </Pressable>;
        })}</View> : null}
    </View>;
});

export function DelegationInspectorPanel({ sessionId, selection, onBack, onCompose }: {
    sessionId: string; selection: SubagentInspectorSelection; onBack: () => void; onCompose: (text: string) => void;
}) {
    const panel = useRightSwipePanel();
    React.useEffect(() => panel?.registerBackHandler(() => { onBack(); return true; }), [panel, onBack]);
    const compose = (text: string) => {
        if (panel?.isOpen) panel.closePanel(() => onCompose(text));
        else onCompose(text);
    };
    return selection.kind === 'agent-roles'
        ? <AgentRolesPanel key={`${sessionId}:roles`} sessionId={sessionId} initialRoleId={selection.roleId} onBack={onBack} onCompose={compose} />
        : <DelegatedTaskPanel key={`${sessionId}:${selection.id}`} sessionId={sessionId} taskId={selection.id} onBack={onBack} onCompose={compose} />;
}

function Header({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack: () => void }) {
    const { theme } = useUnistyles();
    return <View style={styles.panelHeader}><Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={onBack}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]} hitSlop={8} testID="delegation-panel-back"><Ionicons name="arrow-back" size={20} color={theme.colors.text} /></Pressable>
        <View style={styles.rowCopy}><Text numberOfLines={2} style={styles.heading}>{title}</Text>{subtitle ? <Text numberOfLines={2} style={styles.caption}>{subtitle}</Text> : null}</View></View>;
}

function AgentRolesPanel({ sessionId, initialRoleId, onBack, onCompose }: { sessionId: string; initialRoleId?: string; onBack: () => void; onCompose: (text: string) => void }) {
    const session = useSession(sessionId);
    const inspector = useSubagentInspector();
    const { theme } = useUnistyles();
    const initialRoles = inspector?.delegationRoles ?? session?.metadata?.delegationRoles ?? EMPTY_ROLES;
    const canUseTools = session?.metadata?.capabilities?.delegation === 1;
    const [roles, setRoles] = React.useState(initialRoles);
    const [selectedId, setSelectedId] = React.useState(initialRoleId ?? 'new');
    const cache = inspector?.roleDrafts;
    const [draft, setDraft] = React.useState<DelegationRoleInput>(() => cache?.current.get(initialRoleId ?? 'new')
        ?? (initialRoles.find(role => role.id === initialRoleId) ? roleInput(initialRoles.find(role => role.id === initialRoleId)!) : newRole()));
    const [busy, setBusy] = React.useState(false);
    const [loading, setLoading] = React.useState(canUseTools);
    const [error, setError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const alive = React.useRef(true);
    const updateDraft = (patch: Partial<DelegationRoleInput>) => setDraft(current => {
        const next = { ...current, ...patch }; cache?.current.set(selectedId, next); return next;
    });
    const applyRoles = (next: DelegationRole[]) => { setRoles(next); inspector?.setDelegationRoles?.(next); };
    const load = React.useCallback(async () => {
        if (!canUseTools) { setLoading(false); return; }
        setLoading(true); setError(null);
        try { const next = await listDelegationRoles(sessionId); if (alive.current) { setRoles(next); inspector?.setDelegationRoles?.(next); } }
        catch (failure) { if (alive.current) setError(errorMessage(failure)); }
        finally { if (alive.current) setLoading(false); }
    }, [sessionId, canUseTools]);
    React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
    const choose = (id: string) => {
        cache?.current.set(selectedId, draft);
        setSelectedId(id); setError(null); setNotice(null);
        setDraft(cache?.current.get(id) ?? (roles.find(role => role.id === id) ? roleInput(roles.find(role => role.id === id)!) : newRole()));
    };
    const models = session?.metadata?.flavor === draft.agent ? session.metadata.models ?? [] : [];
    const model = models.find(item => item.code === draft.model);
    const saved = roles.find(role => role.id === draft.id);
    const parsed = DelegationRoleInputSchema.safeParse({ ...draft, effort: draft.effort?.trim() || undefined });
    const dirty = !saved || JSON.stringify(roleInput(saved)) !== JSON.stringify(parsed.success ? parsed.data : draft);
    const save = async () => {
        if (!canUseTools) return;
        if (!parsed.success) { setError(t('delegation.invalidRole')); return; }
        setBusy(true); setError(null); setNotice(null);
        try {
            const result = await saveDelegationRole(sessionId, parsed.data);
            if (!alive.current) return;
            const next = roles.some(role => role.id === result.id) ? roles.map(role => role.id === result.id ? result : role) : [...roles, result];
            applyRoles(next); if (selectedId === 'new') cache?.current.delete('new'); cache?.current.set(result.id, roleInput(result));
            setSelectedId(result.id); setDraft(roleInput(result)); setNotice(t('delegation.saved'));
        } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
        finally { if (alive.current) setBusy(false); }
    };
    const remove = async () => {
        if (!canUseTools) return;
        if (!saved || !await Modal.confirm(t('delegation.deleteTitle'), t('delegation.deleteHint'))) return;
        if (!alive.current) return;
        setBusy(true); setError(null);
        try {
            const result = await deleteDelegationRole(sessionId, saved.id);
            if (!alive.current) return;
            const next = result ?? roles.filter(role => role.id !== saved.id); applyRoles(next); cache?.current.delete(saved.id);
            setSelectedId('new'); const fresh = cache?.current.get('new') ?? newRole(); setDraft(fresh);
        } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
        finally { if (alive.current) setBusy(false); }
    };
    return <View style={styles.panel} testID="delegation-role-manager"><Header title={t('delegation.rolesTitle')} onBack={onBack} />
        <ScrollView contentContainerStyle={styles.panelBody} keyboardShouldPersistTaps="handled">
            <View style={styles.actions}>{roles.map(role => <Button key={role.id} label={role.name} onPress={() => choose(role.id)} selected={selectedId === role.id} disabled={busy} />)}<Button label={t('delegation.newRole')} onPress={() => choose('new')} selected={selectedId === 'new'} disabled={busy} /></View>
            <View style={styles.actions}>{loading ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : null}<Button label={t('delegation.refresh')} onPress={() => { void load(); }} disabled={loading || busy || !canUseTools} testID="delegation-roles-refresh" /></View>
            {error ? <Text style={styles.error} accessibilityRole="alert" testID="delegation-role-error">{error}</Text> : null}
            {notice ? <Text style={styles.secondary} testID="delegation-role-saved">{notice}</Text> : null}
            <Field label={t('delegation.name')}><TextInput value={draft.name} onChangeText={name => updateDraft({ name })} editable={!busy} maxLength={100} style={styles.input} accessibilityLabel={t('delegation.name')} testID="delegation-role-name" /></Field>
            <Field label={t('delegation.description')}><TextInput value={draft.description} onChangeText={description => updateDraft({ description })} editable={!busy} maxLength={10000} multiline style={[styles.input, styles.multiline]} accessibilityLabel={t('delegation.description')} testID="delegation-role-description" /></Field>
            <Field label={t('delegation.agent')}><View style={styles.actions}>{(['antigravity', 'codex'] as const).map(agent => <Button key={agent} label={agentLabel(agent)} selected={draft.agent === agent} disabled={busy}
                onPress={() => { if (draft.agent !== agent) updateDraft({ agent, model: '', effort: undefined }); }} testID={`delegation-agent-${agent}`} />)}</View></Field>
            <Field label={t('delegation.model')}><TextInput value={draft.model} onChangeText={modelCode => updateDraft({ model: modelCode })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={256} style={styles.input} accessibilityLabel={t('delegation.model')} testID="delegation-role-model" />
                <View style={styles.actions}>{models.slice(0, 8).map(item => <Button key={item.code} label={item.value} selected={draft.model === item.code} disabled={busy} onPress={() => updateDraft({ model: item.code, effort: undefined })} />)}</View>
                <Text style={styles.caption}>{model ? t('delegation.modelHint') : t('delegation.unknownModel')}</Text>
            </Field>
            <Field label={`${t('delegation.effort')} (${t('common.optional')})`}><TextInput value={draft.effort ?? ''} onChangeText={effort => updateDraft({ effort: effort || undefined })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={100} style={styles.input} accessibilityLabel={t('delegation.effort')} testID="delegation-role-effort" />
                <View style={styles.actions}>{model?.supportedEffortLevels?.map(effort => <Button key={effort} label={effort} selected={draft.effort === effort} disabled={busy} onPress={() => updateDraft({ effort })} />)}</View>
            </Field>
            <View style={styles.switchRow}><Text style={[styles.body, { flex: 1 }]}>{t('delegation.autoDelegate')}</Text><Switch value={draft.autoDelegate} onValueChange={autoDelegate => updateDraft({ autoDelegate })} disabled={busy} accessibilityLabel={t('delegation.autoDelegate')} /></View>
            <Text style={styles.caption}>{t('delegation.snapshotHint')}</Text><Text style={styles.caption}>{t('delegation.autoHint')}</Text>
            {!canUseTools ? <Text style={styles.caption}>{t('delegation.protocolHint')}</Text> : null}
            <View style={styles.actions}><Button label={busy ? t('common.loading') : t('delegation.saveRole')} onPress={() => { void save(); }} disabled={busy || loading || !canUseTools} testID="delegation-role-save" />
                {saved ? <Button label={t('common.delete')} destructive onPress={() => { void remove(); }} disabled={busy || loading || !canUseTools} testID="delegation-role-delete" /> : null}</View>
            {saved ? <Button label={t('delegation.useRole')} onPress={() => onCompose(t('delegation.useRolePrompt', { id: saved.id, name: saved.name }))} disabled={busy || dirty || !canUseTools} testID="delegation-role-use" /> : null}
        </ScrollView>
    </View>;
}

function Field({ label, children }: React.PropsWithChildren<{ label: string }>) {
    return <View style={styles.field}><Text style={styles.caption}>{label}</Text>{children}</View>;
}

function DelegatedTaskPanel({ sessionId, taskId, onBack, onCompose }: { sessionId: string; taskId: string; onBack: () => void; onCompose: (text: string) => void }) {
    const session = useSession(sessionId);
    const inspector = useSubagentInspector();
    const { theme } = useUnistyles();
    const live = session?.metadata?.delegatedTasks?.find(item => item.id === taskId && item.parentSessionId === sessionId);
    const preferences = inspector?.taskViews?.current.get(taskId);
    const [tab, setTab] = React.useState<'task' | 'context' | 'result'>(preferences?.tab ?? 'task');
    const [version, setVersion] = React.useState<number | undefined>(preferences?.version);
    const [task, setTask] = React.useState<DelegatedTask | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [cancelling, setCancelling] = React.useState(false);
    const [cancelRequested, setCancelRequested] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const alive = React.useRef(true);
    const generation = React.useRef(0);
    const load = React.useCallback(async () => {
        const current = ++generation.current; setLoading(true); setError(null);
        try { const record = await readDelegatedTask(sessionId, taskId); if (alive.current && generation.current === current) { setTask(record); setCancelRequested(record.cancelRequested === true); } }
        catch (failure) { if (alive.current && generation.current === current) setError(errorMessage(failure)); }
        finally { if (alive.current && generation.current === current) setLoading(false); }
    }, [sessionId, taskId]);
    React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current += 1; }; }, [load]);
    const summary = task ?? live;
    const currentSummary = live && (!task || live.version > task.version || (live.version === task.version && live.updatedAt >= task.updatedAt)) ? live : task;
    const isActive = currentSummary ? ['starting', 'running', 'waiting-for-input'].includes(currentSummary.status) : false;
    const versions = new Map<number, DelegatedTaskVersion>((task?.history ?? []).map(item => [item.version, item]));
    if (task) versions.set(task.version, { version: task.version, prompt: task.prompt, context: task.context, status: task.status, startedAt: task.startedAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt, error: task.error, result: task.result ?? versions.get(task.version)?.result });
    const selected = versions.get(version ?? task?.version ?? 0) ?? (task ? versions.get(task.version) : undefined);
    const remember = (nextTab = tab, nextVersion = version) => inspector?.taskViews?.current.set(taskId, { tab: nextTab, version: nextVersion });
    const cancel = async () => {
        setCancelling(true); setError(null);
        try { const result = await cancelDelegatedTask(sessionId, taskId); if (alive.current) { if (result) setTask(result); setCancelRequested(true); } }
        catch (failure) { if (alive.current) setError(errorMessage(failure)); }
        finally { if (alive.current) setCancelling(false); }
    };
    const tabs = ['task', 'context', 'result'] as const;
    return <View style={styles.panel} testID="delegation-task-inspector"><Header title={summary?.title ?? taskId} subtitle={summary ? `${summary.roleName} · ${agentLabel(summary.agent)} / ${summary.model} · v${summary.version}` : taskId} onBack={onBack} />
        <View style={styles.tabs}>{tabs.map(value => <Button key={value} label={t(`delegation.${value}`)} selected={tab === value} onPress={() => { setTab(value); remember(value); }} testID={`delegation-tab-${value}`} />)}</View>
        <ScrollView contentContainerStyle={styles.panelBody}>
            <View style={styles.actions}>{loading ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : null}<Button label={t('delegation.refresh')} onPress={() => { void load(); }} disabled={loading} testID="delegation-task-refresh" /></View>
            {error ? <Text style={styles.error} accessibilityRole="alert" testID="delegation-task-error">{error}</Text> : null}
            {live && task && (live.updatedAt > task.updatedAt || live.version !== task.version) ? <Text style={styles.caption}>{t('delegation.updateAvailable')}</Text> : null}
            {currentSummary ? <Text style={styles.body} testID="delegation-task-status">{delegatedStatusLabel(currentSummary.status)}</Text> : null}
            {tab === 'task' ? <>
                <Field label={t('delegation.parent')}><Text selectable style={styles.body}>{sessionId}</Text></Field>
                <Field label={t('delegation.task')}><Text selectable style={styles.body}>{taskId}</Text></Field>
                {summary ? <><Field label={t('delegation.role')}><Text style={styles.body}>{summary.roleName}</Text></Field><Field label={t('delegation.route')}><Text selectable style={styles.body}>{agentLabel(summary.agent)} / {summary.model}{summary.effort ? ` · ${summary.effort}` : ''}</Text></Field></> : null}
                <Text style={styles.caption}>{t('delegation.accountBoundary')}</Text>
                {task ? <Field label={t('delegation.originalPrompt')}><Text selectable style={styles.body}>{task.prompt}</Text></Field> : null}
                {live?.error || task?.error ? <Text selectable style={styles.error}>{live?.error ?? task?.error}</Text> : null}
                <Text style={styles.caption}>{t('delegation.snapshotHint')}</Text>
            </> : null}
            {tab === 'context' ? <><Field label={t('delegation.originalPrompt')}><Text selectable style={styles.body}>{selected?.prompt ?? task?.prompt ?? ''}</Text></Field><Field label={t('delegation.context')}><Text selectable style={styles.body}>{(selected ? selected.context : task?.context) ?? t('delegation.noContext')}</Text></Field></> : null}
            {tab === 'result' ? <>
                <Field label={t('delegation.history')}><View style={styles.actions}>{[...versions.keys()].sort((a, b) => a - b).map(number => <Button key={number} label={`v${number}`} selected={selected?.version === number} onPress={() => { setVersion(number); remember(tab, number); }} testID={`delegation-version-${number}`} />)}</View></Field>
                {selected?.result ? <><Text selectable style={styles.result} testID="delegation-result-text">{selected.result.text}</Text>{selected.result.truncated ? <Text style={styles.error}>{t('delegation.truncated')}</Text> : null}</> : <Text style={styles.secondary}>{t('delegation.noResult')}</Text>}
                <Text style={styles.caption}>{t('delegation.resultBoundary')}</Text>
            </> : null}
            {isActive && (cancelRequested || currentSummary?.cancelRequested) ? <Text style={styles.secondary}>{t('delegation.cancelRequested')}</Text> : null}
            {session?.metadata?.capabilities?.delegation !== 1 ? <Text style={styles.caption}>{t('delegation.protocolHint')}</Text> : null}
            <View style={styles.actions}><Button label={t('delegation.append')} onPress={() => onCompose(t('delegation.appendPrompt', { id: taskId }))} disabled={session?.metadata?.capabilities?.delegation !== 1} testID="delegation-task-append" />
                {isActive ? <Button label={t('delegation.cancelTask')} onPress={() => { void cancel(); }} disabled={cancelling || cancelRequested || currentSummary?.cancelRequested} destructive testID="delegation-task-cancel" /> : null}</View>
        </ScrollView>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    assistantBar: { minHeight: 35, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 4, marginBottom: 5 },
    pill: { minWidth: 0, maxWidth: '85%', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 18, backgroundColor: theme.colors.surface },
    pillTitle: { flexShrink: 1, color: theme.colors.text, fontSize: 12, ...Typography.default() },
    pillRoute: { flexShrink: 1, color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    panelHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.divider, padding: 14 },
    back: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
    panelBody: { padding: 16, gap: 14, paddingBottom: 28 },
    heading: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 21, color: theme.colors.text, ...Typography.default('semiBold') },
    body: { fontSize: 13, lineHeight: 21, color: theme.colors.text, ...Typography.default() },
    secondary: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    caption: { fontSize: 11, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    result: { fontSize: 13, lineHeight: 22, color: theme.colors.text, ...Typography.default() },
    error: { fontSize: 12, lineHeight: 19, color: theme.colors.textDestructive, ...Typography.default() },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
    tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, padding: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
    field: { gap: 6 },
    input: { minHeight: 39, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 7, backgroundColor: theme.colors.surfacePressed, color: theme.colors.text, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, ...Typography.default() },
    multiline: { minHeight: 80, textAlignVertical: 'top' },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    button: { minHeight: 34, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 7, backgroundColor: theme.colors.surface, paddingHorizontal: 10, paddingVertical: 7, justifyContent: 'center' },
    buttonText: { color: theme.colors.text, fontSize: 12, lineHeight: 18, ...Typography.default() },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    focused: { borderColor: theme.colors.textLink },
    disabled: { opacity: 0.45 },
    taskGroup: { width: '100%', alignSelf: 'center', paddingHorizontal: 16, marginVertical: 10 },
    groupHeading: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 8, borderRadius: 8 },
    stack: { flexDirection: 'row', flexShrink: 0 },
    stacked: { marginLeft: -9 },
    avatar: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfacePressed, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    taskList: { padding: 4, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, borderRadius: 11 },
    taskRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 9, paddingVertical: 9, borderRadius: 7 },
    rowCopy: { flex: 1, minWidth: 0, gap: 4 },
    rowTitle: { color: theme.colors.text, fontSize: 14, lineHeight: 20, ...Typography.default('semiBold') },
    rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
    compactMeta: { flexDirection: 'column', alignItems: 'flex-end', gap: 3 },
    status: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 18, ...Typography.default() },
}));
