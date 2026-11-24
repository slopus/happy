import * as React from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, useWindowDimensions, BackHandler, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { v4 as uuid } from 'uuid';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { isScheduledRunTerminal, type ScheduledRun, type ScheduledRunStatus } from '@slopus/happy-wire';
import type { DecryptedScheduledTask } from '@/sync/scheduledTasks';
import { TaskEditor } from './TaskEditor';

function runStatus(status: ScheduledRunStatus): string {
    const keys = { pending: 'pending', claimed: 'claimed', running: 'running', 'waiting-for-input': 'waitingForInput', uncertain: 'uncertain', completed: 'completed', failed: 'failed', cancelled: 'cancelled', skipped: 'skipped' } as const;
    return t(`scheduledTasks.${keys[status]}`);
}
function instant(at: number | null, timezone?: string): string {
    return at === null ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(at);
}
function reason(run: ScheduledRun): string | undefined {
    if (!run.reason) return undefined;
    if (run.reason === 'configuration-invalid') return t('scheduledTasks.invalid');
    if (run.reason === 'task-paused') return t('scheduledTasks.paused');
    if (run.reason === 'previous-run-active') return t('scheduledTasks.skipped') + ' · ' + t('scheduledTasks.running');
    if (run.reason === 'tracking-ended') return t('scheduledTasks.abandon');
    if (run.reason === 'processor-startup-failed') return t('scheduledTasks.startupFailed');
    if (run.reason === 'startup-deadline-exceeded') return t('scheduledTasks.startupTimeout');
    return t(run.status === 'failed' ? 'scheduledTasks.runFailed' : 'scheduledTasks.uncertain');
}
function Button({ label, onPress, disabled, testID, icon, primary = false, expanded, selected }: {
    label: string; onPress: () => void; disabled?: boolean; testID?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name']; primary?: boolean; expanded?: boolean; selected?: boolean;
}) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled, expanded, selected }} disabled={disabled} onPress={onPress} testID={testID}
        {...(Platform.OS === 'web' && selected !== undefined ? { 'aria-pressed': selected } : {})}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.button, primary && styles.selected, !disabled && (hovered || pressed) && styles.pressed,
            selected && styles.selected, (focused || selected) && styles.focused, disabled && styles.disabled]}>
        {icon && <Ionicons name={icon} size={17} color={theme.colors.text} />}<Text style={styles.text}>{label}</Text>
    </Pressable>;
}
function TaskRow({ task, selected, onPress }: { task: DecryptedScheduledTask; selected: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const plan = task.enabled ? t('scheduledTasks.enabled') : task.rule.type === 'once' && task.rule.at <= Date.now() ? t('scheduledTasks.noNext') : t('scheduledTasks.paused');
    return <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} testID={`scheduled-task-row-${task.id}`}
        {...(Platform.OS === 'web' ? { 'aria-current': selected ? 'true' as const : undefined } : {})}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.taskRow, (hovered || pressed) && styles.pressed, selected && styles.taskSelected, focused && styles.focused]}>
        <Text numberOfLines={2} style={styles.runTitle}>{task.config?.title ?? t('scheduledTasks.title')}</Text>
        <View style={styles.titleRow}><View style={styles.badge}><Ionicons name={task.enabled ? 'time-outline' : 'pause-outline'} size={13} color={theme.colors.textSecondary} /><Text style={styles.badgeText}>{plan}</Text></View><Text style={styles.meta}>{t(`scheduledTasks.${task.rule.type}`)}</Text></View>
        <Text numberOfLines={2} style={styles.meta}>{task.nextAt ? instant(task.nextAt, task.rule.timezone) : t('scheduledTasks.noNext')}</Text>
    </Pressable>;
}

export const ScheduledTasksWorkspace = React.memo(function ScheduledTasksWorkspace() {
    const snapshot = React.useSyncExternalStore(sync.scheduledTasks.subscribe, sync.scheduledTasks.getSnapshot);
    const machines = useAllMachines({ includeOffline: true });
    const machineKey = machines.map(machine => machine.id).sort().join(':');
    const previousMachineKey = React.useRef(machineKey);
    const { width } = useWindowDimensions();
    const wide = width >= 1000;
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ taskId?: string }>();
    const [selectedId, setSelectedId] = React.useState<string | null>(params.taskId ?? null);
    const [filter, setFilter] = React.useState<'all' | 'enabled' | 'paused'>('all');
    const [query, setQuery] = React.useState('');
    const [editor, setEditor] = React.useState<{ taskId?: string; template?: { title: string; prompt: string } } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const busyRef = React.useRef(false);
    const focused = React.useRef(false);
    const attempt = React.useRef(0);
    const generation = React.useRef(snapshot.accountGeneration);
    const requestIds = React.useRef(new Map<string, string>());
    const [launch, setLaunch] = React.useState<{ taskId: string; runId: string; generation: number } | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const selectTask = (id: string | null) => { attempt.current++; setLaunch(null); setNotice(null); setError(null); setSelectedId(id); router.setParams({ taskId: id ?? undefined }); };
    useFocusEffect(React.useCallback(() => {
        focused.current = true; sync.scheduledTasks.setVisible(true);
        return () => { focused.current = false; attempt.current++; setLaunch(null); sync.scheduledTasks.setVisible(false); };
    }, []));
    React.useEffect(() => {
        if (previousMachineKey.current === machineKey) return;
        previousMachineKey.current = machineKey;
        if (focused.current) void sync.scheduledTasks.refresh();
    }, [machineKey]);
    React.useEffect(() => {
        if (generation.current === snapshot.accountGeneration) return;
        generation.current = snapshot.accountGeneration;
        attempt.current++; requestIds.current.clear(); setLaunch(null); setEditor(null); setSelectedId(null); setError(null); setNotice(null);
        router.setParams({ taskId: undefined });
    }, [snapshot.accountGeneration, router]);
    React.useEffect(() => { if (params.taskId) setSelectedId(params.taskId); }, [params.taskId]);
    React.useEffect(() => {
        if (!selectedId) return;
        let current = true;
        void sync.scheduledTasks.history(selectedId).catch(() => { if (current && focused.current) setError(t('scheduledTasks.operationError')); });
        return () => { current = false; };
    }, [selectedId, snapshot.revision]);
    React.useEffect(() => {
        if (wide || !selectedId) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { selectTask(null); return true; });
        return () => subscription.remove();
    }, [wide, selectedId]);
    React.useEffect(() => { setDetailsOpen(false); }, [selectedId]);
    const selected = snapshot.tasks.find(task => task.id === selectedId);
    const runs = selectedId ? snapshot.histories[selectedId] ?? [] : [];
    const activeRun = runs.find(run => run.id === selected?.activeRunId) ?? runs.find(run => !isScheduledRunTerminal(run.status));
    const currentRun = activeRun ?? runs[0];
    const pendingRun = activeRun?.status === 'pending' ? activeRun : undefined;
    const canResume = selected?.rule.type !== 'once' || selected.rule.at > Date.now();
    const machine = machines.find(m => m.id === selected?.machineId);
    const filtered = snapshot.tasks.filter(task => (filter === 'all' || task.enabled === (filter === 'enabled'))
        && (task.config?.title ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const launchedRun = launch ? snapshot.histories[launch.taskId]?.find(run => run.id === launch.runId) : undefined;
    React.useEffect(() => {
        if (!launch || !focused.current || launch.generation !== snapshot.accountGeneration || launch.taskId !== selectedId) return;
        if (launchedRun?.sessionId) {
            setLaunch(null);
            router.push(`/session/${launchedRun.sessionId}`);
        } else if (launchedRun && isScheduledRunTerminal(launchedRun.status)) {
            setLaunch(null); setError(reason(launchedRun) ?? t('scheduledTasks.runFailed'));
        } else if (launchedRun?.status === 'pending' && machine && !isMachineOnline(machine)) {
            setLaunch(null); setNotice(t('scheduledTasks.offlineHint'));
        }
    }, [launch, launchedRun, snapshot.accountGeneration, selectedId, machine, router]);
    React.useEffect(() => {
        if (!launch) return;
        // A single UI wait limit, with no status request or retry loop. Events keep the run card current.
        const timeout = setTimeout(() => { setLaunch(null); if (focused.current) setNotice(t('scheduledTasks.launchQueued')); }, 30000);
        return () => clearTimeout(timeout);
    }, [launch]);
    const perform = async (action: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setError(null); setNotice(null);
        const capturedGeneration = snapshot.accountGeneration;
        try { await action(); }
        catch (caught) { if (focused.current && generation.current === capturedGeneration) setError(caught instanceof Error && caught.message === 'version-conflict' ? t('scheduledTasks.conflict') : t('scheduledTasks.operationError')); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const launchNow = () => {
        if (!selected || busyRef.current || launch || activeRun || selected.activeRunId) return;
        const taskId = selected.id, capturedGeneration = snapshot.accountGeneration, currentAttempt = ++attempt.current;
        let requestId = requestIds.current.get(taskId);
        if (!requestId) { requestId = uuid(); requestIds.current.set(taskId, requestId); }
        const id = requestId;
        void perform(async () => {
            const run = await sync.scheduledTasks.runNow(taskId, id);
            requestIds.current.delete(taskId);
            if (focused.current && currentAttempt === attempt.current && generation.current === capturedGeneration) setLaunch({ taskId, runId: run.id, generation: capturedGeneration });
        });
    };
    const templates = [
        { title: t('scheduledTasks.dailyBrief'), prompt: t('scheduledTasks.dailyBriefPrompt'), icon: 'newspaper-outline' as const },
        { title: t('scheduledTasks.accountUpdates'), prompt: t('scheduledTasks.accountUpdatesPrompt'), icon: 'at-outline' as const },
        { title: t('scheduledTasks.weeklyReview'), prompt: t('scheduledTasks.weeklyReviewPrompt'), icon: 'folder-open-outline' as const },
    ];
    const renderRun = (run: ScheduledRun) => <View key={run.id} style={styles.run} testID={`scheduled-run-${run.id}`}>
        <View style={styles.titleRow}><Ionicons name={run.status === 'completed' ? 'checkmark-circle-outline' : run.status === 'failed' || run.status === 'uncertain' ? 'alert-circle-outline' : 'time-outline'} size={20} color={run.status === 'failed' ? theme.colors.textDestructive : theme.colors.textSecondary} /><Text style={styles.runTitle}>{runStatus(run.status)}</Text><Text style={styles.meta}>{instant(run.scheduledAt, selected?.rule.timezone)}</Text></View>
        {run.startedAt !== null && <Text style={styles.meta}>{t('scheduledTasks.startedAt')} · {instant(run.startedAt)}</Text>}
        {run.finishedAt !== null && <Text style={styles.meta}>{t('scheduledTasks.finishedAt')} · {instant(run.finishedAt)}</Text>}
        {run.status === 'pending' && machine && !isMachineOnline(machine) && <Text style={styles.meta}>{t('scheduledTasks.offlineHint')}</Text>}
        {run.missedUntil && <Text style={styles.meta}>{t('scheduledTasks.missed')}</Text>}
        {reason(run) && <Text style={run.status === 'failed' ? styles.failureText : styles.meta}>{reason(run)}</Text>}
        <View style={styles.actions}>{run.sessionId && <Button label={t('scheduledTasks.openResult')} icon="chatbubble-outline" primary onPress={() => router.push(`/session/${run.sessionId}`)} testID="scheduled-run-open-result" />}
            {(run.status === 'uncertain' || run.status === 'waiting-for-input') && <Button label={t('scheduledTasks.abandon')} disabled={busy} onPress={() => void (async () => { if (await Modal.confirm(t('scheduledTasks.abandon'), t('scheduledTasks.abandonConfirm'), { destructive: true })) await perform(() => sync.scheduledTasks.abandon(run.taskId, run.id)); })()} />}</View>
    </View>;
    return <View style={styles.root} testID="scheduled-tasks-workspace">
        {(wide || !selected) && <View style={[styles.list, wide && styles.wideList]}>
            <View style={styles.listHeader}><View style={styles.titleRow}><Ionicons name="time-outline" size={22} color={theme.colors.text} /><Text style={styles.title}>{t('scheduledTasks.title')}</Text></View>
                <Button label={t('scheduledTasks.create')} primary icon="add" onPress={() => setEditor({})} testID="scheduled-task-create" />
                <TextInput accessibilityLabel={t('scheduledTasks.search')} placeholder={t('scheduledTasks.search')} value={query} onChangeText={setQuery} style={styles.search} placeholderTextColor={theme.colors.textSecondary} />
                <View style={styles.filters}>{(['all', 'enabled', 'paused'] as const).map(key => <Button key={key} label={t(`scheduledTasks.${key}`)} primary={key === filter} selected={key === filter} onPress={() => setFilter(key)} />)}</View>
            </View>
            <ItemList style={styles.listScroll} containerStyle={styles.taskRows}>
                {snapshot.loading && !snapshot.tasks.length && <ActivityIndicator style={styles.loading} color={theme.colors.textSecondary} />}
                {filtered.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId} onPress={() => selectTask(task.id)} />)}
            </ItemList>
            <View style={styles.listFooter}><Button label={t('scheduledTasks.refresh')} icon="refresh-outline" onPress={() => void sync.scheduledTasks.refresh(true)} disabled={busy || snapshot.loading} /></View>
        </View>}
        {(wide || selected) && <ItemList style={styles.detail} containerStyle={styles.detailContent}>
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
            {snapshot.error && <ItemGroup><Item title={snapshot.error === 'server-unavailable' ? t('scheduledTasks.serverUnavailable') : t('scheduledTasks.operationError')} onPress={() => void sync.scheduledTasks.refresh(true)} /></ItemGroup>}
            {selected ? <>
                {!wide && <Button label={t('common.back')} icon="arrow-back" onPress={() => selectTask(null)} />}
                <View style={styles.detailHeader}><Text style={styles.heading}>{selected.config?.title ?? t('scheduledTasks.title')}</Text><Text style={styles.meta}>{t('scheduledTasks.nextRun')} · {selected.nextAt ? instant(selected.nextAt, selected.rule.timezone) : t('scheduledTasks.noNext')}</Text>
                    <View style={styles.actions}><Button label={t(launch ? 'scheduledTasks.openingSession' : 'scheduledTasks.runNow')} icon="play-outline" primary onPress={launchNow} disabled={busy || !!launch || !!activeRun || !!selected.activeRunId || !selected.config} testID="scheduled-task-run-now" />
                        {(selected.enabled || pendingRun || canResume) && <Button label={t(selected.enabled || pendingRun ? 'scheduledTasks.pause' : 'scheduledTasks.resume')} icon={selected.enabled || pendingRun ? 'pause-outline' : 'play-circle-outline'} onPress={() => void perform(() => sync.scheduledTasks.toggle(selected, pendingRun ? false : !selected.enabled))} disabled={busy} testID="scheduled-task-toggle" />}
                        <Button label={t('scheduledTasks.edit')} icon="create-outline" onPress={() => { setLaunch(null); attempt.current++; setEditor({ taskId: selected.id }); }} disabled={busy || !selected.config} />
                        <Button label={t('scheduledTasks.remove')} icon="trash-outline" disabled={busy} onPress={() => void (async () => { if (await Modal.confirm(t('scheduledTasks.remove'), t('scheduledTasks.removeConfirm'), { destructive: true })) await perform(async () => { await sync.scheduledTasks.remove(selected); selectTask(null); }); })()} testID="scheduled-task-delete" /></View>
                    {launch && <View style={styles.titleRow} accessibilityLiveRegion="polite"><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.meta}>{t('scheduledTasks.openingSession')}</Text></View>}
                </View>
                {currentRun && <ItemGroup title={t('scheduledTasks.currentRun')}>{renderRun(currentRun)}</ItemGroup>}
                <ItemGroup title={t('scheduledTasks.instruction')}><Text selectable style={styles.prompt}>{selected.config?.prompt ?? t('scheduledTasks.operationError')}</Text></ItemGroup>
                <View style={styles.settings}><View style={styles.titleRow}><Ionicons name="desktop-outline" size={17} color={theme.colors.textSecondary} /><Text style={styles.meta}>{machine?.metadata?.displayName ?? machine?.metadata?.host ?? selected.machineId} · {selected.config?.agent === 'claude' ? 'Claude Code' : 'Codex'} · {selected.config?.model ?? t('scheduledTasks.defaultModel')}</Text></View>
                    <Button label={t('scheduledTasks.executionSettings')} icon={detailsOpen ? 'chevron-up' : 'chevron-down'} expanded={detailsOpen} onPress={() => setDetailsOpen(value => !value)} />
                </View>
                {detailsOpen && <ItemGroup>
                    <Item title={t('scheduledTasks.directory')} detail={selected.config?.directory} showChevron={false} />
                    <Item title={t('scheduledTasks.timezone')} detail={selected.rule.timezone} showChevron={false} />
                    <Item title={t('scheduledTasks.permissions')} detail={t(selected.config?.permissionMode === 'default' ? 'scheduledTasks.standard' : selected.config?.permissionMode === 'acceptEdits' ? 'scheduledTasks.acceptEdits' : selected.config?.permissionMode === 'plan' ? 'scheduledTasks.plan' : 'scheduledTasks.readOnly')} showChevron={false} />
                    <Item title={t('scheduledTasks.newChat')} detail={t(selected.newChatEachRun ? 'common.yes' : 'common.no')} showChevron={false} />
                </ItemGroup>}
                {(!runs.length || runs.length > 1) && <ItemGroup title={t('scheduledTasks.history')}>
                    {!runs.length && <Item title={t('scheduledTasks.noRuns')} showChevron={false} />}
                    {runs.filter(run => run.id !== currentRun?.id).map(renderRun)}
                </ItemGroup>}
            </> : <View style={styles.empty}><Ionicons name="time-outline" color={theme.colors.textSecondary} size={48} /><Text style={styles.heading}>{t('scheduledTasks.emptyTitle')}</Text><Text style={styles.emptyHint}>{t('scheduledTasks.emptyHint')}</Text>
                <View style={styles.templates}>{templates.map(template => <Button key={template.title} label={template.title} icon={template.icon} onPress={() => setEditor({ template })} />)}</View>
            </View>}
        </ItemList>}
        {!wide && !selected && !snapshot.tasks.length && !snapshot.loading && <View style={styles.mobileEmpty}><Text style={styles.emptyHint}>{snapshot.error === 'server-unavailable' ? t('scheduledTasks.serverUnavailable') : t('scheduledTasks.emptyHint')}</Text></View>}
        {editor && <TaskEditor task={editor.taskId ? snapshot.tasks.find(task => task.id === editor.taskId) : undefined} template={editor.template} onSaved={taskId => { if (!focused.current || generation.current !== snapshot.accountGeneration) return; setQuery(''); setFilter('all'); selectTask(taskId); }} onClose={() => setEditor(null)} />}
    </View>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.surface }, list: { flex: 1, minWidth: 0 }, wideList: { flexGrow: 0, flexShrink: 0, flexBasis: 300, width: 300, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.divider },
    listHeader: { padding: 18, gap: 14 }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, title: { color: theme.colors.text, fontSize: 20, ...Typography.default('semiBold') },
    search: { backgroundColor: theme.colors.input.background, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 9, padding: 11, color: theme.colors.text, fontSize: 14 },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 }, selected: { backgroundColor: theme.colors.surfaceSelected }, pressed: { backgroundColor: theme.colors.surfacePressed }, focused: { borderColor: theme.colors.textLink },
    taskRows: { paddingHorizontal: 10, gap: 6 }, taskRow: { gap: 9, padding: 14, borderRadius: 12, borderWidth: 2, borderColor: 'transparent', backgroundColor: theme.colors.surface }, taskSelected: { backgroundColor: theme.colors.surfaceSelected, borderColor: theme.colors.textLink },
    badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }, badgeText: { color: theme.colors.textSecondary, fontSize: 12 },
    listScroll: { backgroundColor: theme.colors.surface }, listFooter: { padding: 12 }, detail: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface }, detailContent: { width: '100%', maxWidth: 840, alignSelf: 'center', padding: 20, paddingBottom: 48 },
    detailHeader: { gap: 12, paddingHorizontal: 28, paddingTop: 10, paddingBottom: 18 }, heading: { color: theme.colors.text, fontSize: 24, ...Typography.default('semiBold') }, text: { color: theme.colors.text, fontSize: 14 }, meta: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }, button: { minHeight: 40, paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 9, backgroundColor: theme.colors.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, disabled: { opacity: 0.45 },
    prompt: { padding: 18, color: theme.colors.text, fontSize: 15, lineHeight: 23 }, run: { padding: 16, gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }, runTitle: { color: theme.colors.text, fontSize: 15, ...Typography.default('semiBold') }, settings: { padding: 28, gap: 12, alignItems: 'flex-start' }, failureText: { color: theme.colors.textDestructive, fontSize: 13, lineHeight: 20 },
    empty: { paddingVertical: 80, alignItems: 'center', gap: 18 }, emptyHint: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 23, textAlign: 'center', maxWidth: 500 }, templates: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, width: '100%', marginTop: 16 },
    loading: { padding: 20 }, mobileEmpty: { position: 'absolute', top: '42%', left: 24, right: 24 }, error: { color: theme.colors.textDestructive, padding: 16, fontSize: 14, lineHeight: 22 }, notice: { color: theme.colors.textSecondary, padding: 16, fontSize: 14, lineHeight: 22 },
}));
