import * as React from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, useWindowDimensions, BackHandler } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { v4 as uuid } from 'uuid';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { layout } from '@/components/layout';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import type { ScheduledRun, ScheduledRunStatus } from '@slopus/happy-wire';
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
    return t('scheduledTasks.uncertain');
}
function Button({ label, onPress, disabled, testID, icon }: { label: string; onPress: () => void; disabled?: boolean; testID?: string; icon?: React.ComponentProps<typeof Ionicons>['name'] }) {
    const { theme } = useUnistyles();
    return <Pressable accessibilityLabel={label} accessibilityRole="button" disabled={disabled} onPress={onPress} testID={testID}
        style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}>{icon && <Ionicons name={icon} size={17} color={theme.colors.text} />}<Text style={styles.text}>{label}</Text></Pressable>;
}

export const ScheduledTasksWorkspace = React.memo(function ScheduledTasksWorkspace() {
    const snapshot = React.useSyncExternalStore(sync.scheduledTasks.subscribe, sync.scheduledTasks.getSnapshot);
    const machines = useAllMachines({ includeOffline: true });
    const machineKey = machines.map(machine => machine.id).sort().join(':');
    const { width } = useWindowDimensions();
    const wide = width >= 1000;
    const { theme } = useUnistyles();
    const router = useRouter();
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [filter, setFilter] = React.useState<'all' | 'enabled' | 'paused'>('all');
    const [query, setQuery] = React.useState('');
    const [editor, setEditor] = React.useState<{ taskId?: string; template?: { title: string; prompt: string } } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const busyRef = React.useRef(false);
    const requestIds = React.useRef(new Map<string, string>());
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => { sync.scheduledTasks.setVisible(true); return () => sync.scheduledTasks.setVisible(false); }, []);
    React.useEffect(() => { void sync.scheduledTasks.refresh(); }, [machineKey]);
    React.useEffect(() => {
        if (!selectedId) return;
        void sync.scheduledTasks.history(selectedId).catch(() => setError(t('scheduledTasks.error')));
    }, [selectedId, snapshot.revision]);
    React.useEffect(() => {
        if (wide || !selectedId) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setSelectedId(null); return true; });
        return () => subscription.remove();
    }, [wide, selectedId]);
    const selected = snapshot.tasks.find(task => task.id === selectedId);
    const runs = selectedId ? snapshot.histories[selectedId] ?? [] : [];
    const pendingRun = runs.find(run => run.id === selected?.activeRunId && run.status === 'pending');
    const canResume = selected?.rule.type !== 'once' || selected.rule.at > Date.now();
    const machine = machines.find(m => m.id === selected?.machineId);
    const filtered = snapshot.tasks.filter(task => (filter === 'all' || task.enabled === (filter === 'enabled'))
        && (task.config?.title ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const perform = async (action: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setError(null);
        try { await action(); }
        catch (caught) { setError(caught instanceof Error && caught.message === 'version-conflict' ? t('scheduledTasks.conflict') : t('scheduledTasks.error')); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const launchNow = () => {
        if (!selected) return;
        let requestId = requestIds.current.get(selected.id);
        if (!requestId) { requestId = uuid(); requestIds.current.set(selected.id, requestId); }
        const id = requestId;
        void perform(async () => { await sync.scheduledTasks.runNow(selected.id, id); requestIds.current.delete(selected.id); });
    };
    const templates = [
        { title: t('scheduledTasks.dailyBrief'), prompt: t('scheduledTasks.dailyBriefPrompt'), icon: 'newspaper-outline' as const },
        { title: t('scheduledTasks.accountUpdates'), prompt: t('scheduledTasks.accountUpdatesPrompt'), icon: 'at-outline' as const },
        { title: t('scheduledTasks.weeklyReview'), prompt: t('scheduledTasks.weeklyReviewPrompt'), icon: 'folder-open-outline' as const },
    ];
    return <View style={styles.root} testID="scheduled-tasks-workspace">
        {(wide || !selected) && <View style={[styles.list, wide && styles.wideList]}>
            <View style={styles.listHeader}><View style={styles.titleRow}><Ionicons name="time-outline" size={22} color={theme.colors.text} /><Text style={styles.title}>{t('scheduledTasks.title')}</Text></View>
                <Button label={t('scheduledTasks.create')} icon="add" onPress={() => setEditor({})} testID="scheduled-task-create" />
                <TextInput accessibilityLabel={t('scheduledTasks.search')} placeholder={t('scheduledTasks.search')} value={query} onChangeText={setQuery} style={styles.search} placeholderTextColor={theme.colors.textSecondary} />
                <View style={styles.filters}>{(['all', 'enabled', 'paused'] as const).map(key => <Pressable key={key} onPress={() => setFilter(key)} accessibilityRole="tab" accessibilityState={{ selected: key === filter }}
                    style={({ pressed }) => [styles.filter, key === filter && styles.selected, pressed && styles.pressed]}><Text style={styles.meta}>{t(`scheduledTasks.${key}`)}</Text></Pressable>)}</View>
            </View>
            <ItemList style={styles.listScroll}>
                {snapshot.loading && !snapshot.tasks.length && <ActivityIndicator style={styles.loading} color={theme.colors.textSecondary} />}
                {filtered.map(task => <Item key={task.id} title={task.config?.title ?? t('scheduledTasks.title')} selected={task.id === selectedId}
                    subtitle={`${task.nextAt ? instant(task.nextAt, task.rule.timezone) : t('scheduledTasks.noNext')} · ${t(`scheduledTasks.${task.rule.type}`)}`}
                    detail={task.enabled ? t('scheduledTasks.enabled') : task.rule.type === 'once' && task.rule.at <= Date.now() ? t('scheduledTasks.noNext') : t('scheduledTasks.paused')}
                    onPress={() => setSelectedId(task.id)} testID={`scheduled-task-row-${task.id}`} />)}
            </ItemList>
            <View style={styles.listFooter}><Button label={t('scheduledTasks.refresh')} icon="refresh-outline" onPress={() => void sync.scheduledTasks.refresh(true)} disabled={busy} /></View>
        </View>}
        {(wide || selected) && <ItemList style={styles.detail} containerStyle={styles.detailContent}>
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {snapshot.error && <ItemGroup><Item title={snapshot.error === 'server-unavailable' ? t('scheduledTasks.serverUnavailable') : t('scheduledTasks.error')} onPress={() => void sync.scheduledTasks.refresh(true)} /></ItemGroup>}
            {selected ? <>
                {!wide && <Button label={t('common.back')} icon="arrow-back" onPress={() => setSelectedId(null)} />}
                <View style={styles.detailHeader}><Text style={styles.heading}>{selected.config?.title ?? t('scheduledTasks.title')}</Text><Text style={styles.meta}>{t('scheduledTasks.nextRun')} · {selected.nextAt ? instant(selected.nextAt, selected.rule.timezone) : t('scheduledTasks.noNext')}</Text>
                    <View style={styles.actions}><Button label={t('scheduledTasks.runNow')} icon="play-outline" onPress={launchNow} disabled={busy} testID="scheduled-task-run-now" />
                        {(selected.enabled || pendingRun || canResume) && <Button label={t(selected.enabled || pendingRun ? 'scheduledTasks.pause' : 'scheduledTasks.resume')} icon={selected.enabled || pendingRun ? 'pause-outline' : 'play-circle-outline'} onPress={() => void perform(() => sync.scheduledTasks.toggle(selected, pendingRun ? false : !selected.enabled))} disabled={busy} testID="scheduled-task-toggle" />}
                        <Button label={t('scheduledTasks.edit')} icon="create-outline" onPress={() => setEditor({ taskId: selected.id })} disabled={busy || !selected.config} />
                        <Button label={t('scheduledTasks.remove')} icon="trash-outline" disabled={busy} onPress={() => void (async () => { if (await Modal.confirm(t('scheduledTasks.remove'), t('scheduledTasks.removeConfirm'), { destructive: true })) await perform(async () => { await sync.scheduledTasks.remove(selected); setSelectedId(null); }); })()} testID="scheduled-task-delete" /></View>
                </View>
                <ItemGroup title={t('scheduledTasks.instruction')}><Text selectable style={styles.prompt}>{selected.config?.prompt ?? t('scheduledTasks.error')}</Text></ItemGroup>
                <ItemGroup title={t('scheduledTasks.advanced')}>
                    <Item title={t('scheduledTasks.machine')} detail={machine?.metadata?.displayName ?? machine?.metadata?.host ?? selected.machineId} subtitle={machine && !isMachineOnline(machine) ? t('scheduledTasks.offlineHint') : undefined} showChevron={false} />
                    <Item title={t('scheduledTasks.directory')} detail={selected.config?.directory} showChevron={false} />
                    <Item title={t('scheduledTasks.engine')} detail={selected.config?.agent === 'claude' ? 'Claude Code' : 'Codex'} showChevron={false} />
                    <Item title={t('scheduledTasks.model')} detail={selected.config?.model ?? t('scheduledTasks.defaultModel')} showChevron={false} />
                    <Item title={t('scheduledTasks.timezone')} detail={selected.rule.timezone} showChevron={false} />
                    <Item title={t('scheduledTasks.newChat')} detail={t(selected.newChatEachRun ? 'common.yes' : 'common.no')} showChevron={false} />
                </ItemGroup>
                <ItemGroup title={t('scheduledTasks.history')}>
                    {!runs.length && <Item title={t('scheduledTasks.noRuns')} showChevron={false} />}
                    {runs.map(run => <View key={run.id} style={styles.run} testID={`scheduled-run-${run.id}`}><View style={styles.titleRow}><Text style={styles.runTitle}>{runStatus(run.status)}</Text><Text style={styles.meta}>{instant(run.scheduledAt, selected.rule.timezone)}</Text></View>
                        {run.startedAt && <Text style={styles.meta}>{t('scheduledTasks.startedAt')} · {instant(run.startedAt)}</Text>}
                        {run.finishedAt && <Text style={styles.meta}>{t('scheduledTasks.finishedAt')} · {instant(run.finishedAt)}</Text>}
                        {run.missedUntil && <Text style={styles.meta}>{t('scheduledTasks.missed')}</Text>}
                        {reason(run) && <Text style={styles.meta}>{reason(run)}</Text>}
                        <View style={styles.actions}>{run.sessionId && <Button label={t('scheduledTasks.openResult')} icon="chatbubble-outline" onPress={() => router.push(`/session/${run.sessionId}`)} testID="scheduled-run-open-result" />}
                            {(run.status === 'uncertain' || run.status === 'waiting-for-input') && <Button label={t('scheduledTasks.abandon')} disabled={busy} onPress={() => void (async () => { if (await Modal.confirm(t('scheduledTasks.abandon'), t('scheduledTasks.abandonConfirm'), { destructive: true })) await perform(() => sync.scheduledTasks.abandon(selected.id, run.id)); })()} />}</View>
                    </View>)}
                </ItemGroup>
            </> : <View style={styles.empty}><Ionicons name="time-outline" color={theme.colors.textSecondary} size={48} /><Text style={styles.heading}>{t('scheduledTasks.emptyTitle')}</Text><Text style={styles.emptyHint}>{t('scheduledTasks.emptyHint')}</Text>
                <View style={styles.templates}>{templates.map(template => <Pressable key={template.title} onPress={() => setEditor({ template })} style={({ pressed }) => [styles.template, pressed && styles.pressed]}>
                    <Ionicons name={template.icon} color={theme.colors.textSecondary} size={24} /><View style={styles.templateCopy}><Text style={styles.text}>{template.title}</Text><Text numberOfLines={3} style={styles.meta}>{template.prompt}</Text></View></Pressable>)}</View>
            </View>}
        </ItemList>}
        {!wide && !selected && !snapshot.tasks.length && !snapshot.loading && <View style={styles.mobileEmpty}><Text style={styles.emptyHint}>{snapshot.error === 'server-unavailable' ? t('scheduledTasks.serverUnavailable') : t('scheduledTasks.emptyHint')}</Text></View>}
        {editor && <TaskEditor task={editor.taskId ? snapshot.tasks.find(task => task.id === editor.taskId) : undefined} template={editor.template} onClose={() => setEditor(null)} />}
    </View>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.surface }, list: { flex: 1, minWidth: 0 }, wideList: { flexGrow: 0, flexShrink: 0, flexBasis: 320, width: 320, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.divider },
    listHeader: { padding: 18, gap: 16 }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, title: { color: theme.colors.text, fontSize: 20, ...Typography.default('semiBold') },
    search: { backgroundColor: theme.colors.input.background, borderColor: theme.colors.divider, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, color: theme.colors.text, fontSize: 14 },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 }, filter: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 }, selected: { backgroundColor: theme.colors.surfaceSelected }, pressed: { backgroundColor: theme.colors.surfacePressed },
    listScroll: { backgroundColor: theme.colors.surface }, listFooter: { padding: 12 }, detail: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface }, detailContent: { width: '100%', maxWidth: layout.maxWidth + 80, alignSelf: 'center', padding: 20, paddingBottom: 48 },
    detailHeader: { gap: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10 }, heading: { color: theme.colors.text, fontSize: 24, ...Typography.default('semiBold') }, text: { color: theme.colors.text, fontSize: 14 }, meta: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }, button: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 9, backgroundColor: theme.colors.surface, flexDirection: 'row', alignItems: 'center', gap: 7 }, disabled: { opacity: 0.45 },
    prompt: { padding: 18, color: theme.colors.text, fontSize: 15, lineHeight: 23 }, run: { padding: 16, gap: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }, runTitle: { color: theme.colors.text, fontSize: 15, ...Typography.default('semiBold') },
    empty: { paddingVertical: 100, alignItems: 'center', gap: 18 }, emptyHint: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 23, textAlign: 'center', maxWidth: 500 }, templates: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, width: '100%', marginTop: 24 },
    template: { flexBasis: 250, flexGrow: 1, minHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 14, padding: 18, flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: theme.colors.surface }, templateCopy: { flex: 1, gap: 7 },
    loading: { padding: 20 }, mobileEmpty: { position: 'absolute', top: '42%', left: 24, right: 24 }, error: { color: theme.colors.textDestructive, padding: 16 },
}));
