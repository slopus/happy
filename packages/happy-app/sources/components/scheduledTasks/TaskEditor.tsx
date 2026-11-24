import * as React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { v4 as uuid } from 'uuid';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useCodexAccounts } from '@/hooks/useCodexAccounts';
import { getLatestSessionModelMetadata } from '@/utils/newSessionModelMetadata';
import { getSuggestedModelModes, getEffortLevelsForModel } from '@/components/modelModeOptions';
import type { DecryptedScheduledTask } from '@/sync/scheduledTasks';
import { createScheduleDraft, localScheduleDateTime, prepareScheduleDraft, type ScheduleDraft } from './draft';

function Field({ label, value, onChange, multiline = false, testID }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; testID?: string }) {
    const { theme } = useUnistyles();
    return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} testID={testID} value={value}
        onChangeText={onChange} multiline={multiline} placeholderTextColor={theme.colors.textSecondary} autoCapitalize="none" autoCorrect={false}
        style={[styles.input, multiline && styles.instruction]} /></View>;
}
function Choice({ title, value, options, onChange, testID }: { title: string; value: string; options: Array<{ key: string; name: string }>; onChange: (key: string) => void; testID?: string }) {
    const [expanded, setExpanded] = React.useState(false);
    const { theme } = useUnistyles();
    return <View><Item title={title} detail={options.find(option => option.key === value)?.name ?? value} onPress={() => setExpanded(v => !v)} testID={testID}
        rightElement={<Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} color={theme.colors.textSecondary} size={16} />} />
        {expanded && <ScrollView style={styles.choices} nestedScrollEnabled>{options.map(option => <Item key={option.key} title={option.name} selected={option.key === value}
            onPress={() => { onChange(option.key); setExpanded(false); }} showChevron={false} testID={`${testID}-${option.key}`} />)}</ScrollView>}
    </View>;
}

export const TaskEditor = React.memo(function TaskEditor({ task: liveTask, template, onClose }: { task?: DecryptedScheduledTask; template?: { title: string; prompt: string }; onClose: () => void }) {
    // Freeze the version and reference configuration together with this editor's draft.
    const task = React.useRef(liveTask).current;
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useAllSessions();
    const accounts = useCodexAccounts();
    const { theme } = useUnistyles();
    const initial = React.useMemo(() => {
        const draft = createScheduleDraft();
        if (task?.config) {
            const config = task.config, rule = task.rule;
            Object.assign(draft, config, { model: config.model ?? '', effort: config.effort ?? '', machineId: task.machineId,
                repeat: rule.type, timezone: rule.timezone, newChatEachRun: task.newChatEachRun, notificationPolicy: task.notificationPolicy });
            if (rule.type === 'once') Object.assign(draft, localScheduleDateTime(rule.at, rule.timezone));
            if (rule.type === 'daily' || rule.type === 'weekly') draft.time = rule.time;
            if (rule.type === 'weekly') draft.weekdays = rule.weekdays;
            if (rule.type === 'interval') { draft.hours = String(rule.hours); draft.intervalAnchor = rule.anchor; }
        } else {
            const machine = machines.find(m => m.metadata?.scheduledTasks === 1) ?? machines[0];
            draft.machineId = machine?.id ?? ''; draft.directory = machine?.metadata?.homeDir ?? '';
            if (template) Object.assign(draft, template);
        }
        return draft;
    }, []);
    const [draft, setDraft] = React.useState(initial);
    const [advanced, setAdvanced] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const id = React.useRef(task?.id ?? uuid()).current;
    const selectedMachine = machines.find(machine => machine.id === draft.machineId);
    const currentProfile = accounts.bindings.find(binding => binding.machineId === draft.machineId)?.profileId ?? undefined;
    const accountKnown = !accounts.loading && !accounts.error;
    const modelMetadata = getLatestSessionModelMetadata({ sessions, selectedMachineId: draft.machineId, agent: 'codex', codexAccountProfileId: currentProfile ?? null });
    const models = [{ key: '', name: t('scheduledTasks.defaultModel') }, ...(modelMetadata?.models?.length ? getSuggestedModelModes('codex', modelMetadata, t)
        .filter(model => model.key !== 'default').map(model => ({ key: model.key, name: model.name })) : [])];
    const efforts = [{ key: '', name: t('scheduledTasks.defaultModel') }, ...getEffortLevelsForModel('codex', draft.model, modelMetadata)
        .filter(option => ['low', 'medium', 'high', 'xhigh', 'max'].includes(option.key)).map(option => ({ key: option.key, name: option.name }))];
    const update = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
    const close = async () => {
        if (busy) return;
        if (JSON.stringify(initial) !== JSON.stringify(draft) && !await Modal.confirm(t('scheduledTasks.discardTitle'), t('scheduledTasks.discardBody'), { destructive: true })) return;
        onClose();
    };
    const save = async () => {
        if (busy) return;
        setBusy(true); setError(null);
        try {
            if (!selectedMachine || selectedMachine.metadata?.scheduledTasks !== 1) throw new Error('machine-upgrade-required');
            const pinnedProfile = task?.config && !draft.resetBinding ? task.config.codexAccountProfileId : currentProfile;
            const prepared = prepareScheduleDraft({ ...draft, codexAccountProfileId: draft.agent === 'codex' ? pinnedProfile : undefined }, Date.now(), task?.config ? { config: task.config, machineId: task.machineId } : undefined);
            if (draft.agent === 'codex' && !accountKnown) throw new Error('account-unavailable');
            await sync.scheduledTasks.save({ id, machineId: draft.machineId, rule: prepared.rule, enabled: task?.enabled ?? true,
                newChatEachRun: draft.newChatEachRun, notificationPolicy: draft.notificationPolicy }, prepared.config, task?.version ?? -1, prepared.resetBinding);
            onClose();
        } catch (caught) {
            const code = caught instanceof Error ? caught.message : '';
            setError(code === 'version-conflict' ? t('scheduledTasks.conflict') : code === 'binding-reset-required' ? t('scheduledTasks.bindingRequired') :
                code === 'time-must-be-future' ? t('scheduledTasks.future') : code === 'machine-upgrade-required' ? t('scheduledTasks.upgradeRequired') : t('scheduledTasks.invalid'));
        } finally { setBusy(false); }
    };
    const days = t('scheduledTasks.weekdaysShort').split(' ');
    return <DesktopDialogFrame visible title={t(task ? 'scheduledTasks.edit' : 'scheduledTasks.create')} onClose={() => void close()} maxWidth={660} testID="scheduled-task-editor">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.editorBody}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
            <Field label={t('scheduledTasks.name')} value={draft.title} onChange={v => update('title', v)} testID="scheduled-task-name" />
            <Field label={t('scheduledTasks.instruction')} value={draft.prompt} onChange={v => update('prompt', v)} multiline testID="scheduled-task-prompt" />
            <ItemGroup><Choice title={t('scheduledTasks.repeat')} value={draft.repeat} options={(['once', 'interval', 'daily', 'weekly'] as const).map(key => ({ key, name: t(`scheduledTasks.${key}`) }))}
                onChange={key => { update('repeat', key as ScheduleDraft['repeat']); if (key === 'once' && !task) setDraft(current => ({ ...current, ...localScheduleDateTime(Date.now() + 120000, current.timezone), repeat: 'once' })); }} testID="scheduled-task-repeat" /></ItemGroup>
            {draft.repeat === 'once' && <Field label={t('scheduledTasks.date')} value={draft.date} onChange={v => update('date', v)} testID="scheduled-task-date" />}
            {draft.repeat === 'interval' ? <Field label={t('scheduledTasks.hours')} value={draft.hours} onChange={v => setDraft(current => ({ ...current, hours: v, intervalAnchor: undefined }))} />
                : <Field label={t('scheduledTasks.time')} value={draft.time} onChange={v => update('time', v)} testID="scheduled-task-time" />}
            <Field label={t('scheduledTasks.timezone')} value={draft.timezone} onChange={v => update('timezone', v)} testID="scheduled-task-timezone" />
            {draft.repeat === 'weekly' && <View style={styles.field}><Text style={styles.label}>{t('scheduledTasks.weekdays')}</Text><View style={styles.days}>{days.map((label, index) => <Pressable key={index} accessibilityRole="checkbox" accessibilityState={{ checked: draft.weekdays.includes(index) }}
                onPress={() => update('weekdays', draft.weekdays.includes(index) ? draft.weekdays.filter(day => day !== index) : [...draft.weekdays, index])}
                style={({ pressed }) => [styles.day, draft.weekdays.includes(index) && styles.selected, pressed && styles.pressed]}><Text style={styles.label}>{label}</Text></Pressable>)}</View></View>}
            <ItemGroup><Choice title={t('scheduledTasks.machine')} value={draft.machineId} options={machines.map(machine => ({ key: machine.id, name: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id }))}
                onChange={key => { const machine = machines.find(m => m.id === key); setDraft(current => ({ ...current, machineId: key, directory: machine?.metadata?.homeDir ?? '', model: '', effort: '' })); }} testID="scheduled-task-machine" /></ItemGroup>
            {selectedMachine?.metadata?.scheduledTasks !== 1 && <Text style={styles.hint}>{machines.length ? t('scheduledTasks.upgradeRequired') : t('scheduledTasks.noMachines')}</Text>}
            {selectedMachine && !isMachineOnline(selectedMachine) && <Text style={styles.hint}>{t('scheduledTasks.offlineHint')}</Text>}
            <Item title={t('scheduledTasks.advanced')} onPress={() => setAdvanced(v => !v)} rightElement={<Ionicons name={advanced ? 'chevron-up' : 'chevron-down'} color={theme.colors.textSecondary} size={16} />} />
            {advanced && <>
                <Field label={t('scheduledTasks.directory')} value={draft.directory} onChange={v => update('directory', v)} testID="scheduled-task-directory" />
                <ItemGroup>
                    <Choice title={t('scheduledTasks.engine')} value={draft.agent} options={[{ key: 'codex', name: 'Codex' }, { key: 'claude', name: 'Claude Code' }]}
                        onChange={key => setDraft(current => ({ ...current, agent: key as 'codex' | 'claude', model: '', effort: '' }))} testID="scheduled-task-engine" />
                    {draft.agent === 'codex' && <><Choice title={t('scheduledTasks.model')} value={draft.model} options={models} onChange={key => setDraft(current => ({ ...current, model: key, effort: '' }))} testID="scheduled-task-model" />
                        <Choice title={t('scheduledTasks.effort')} value={draft.effort} options={efforts} onChange={key => update('effort', key)} testID="scheduled-task-effort" /></>}
                    <Choice title={t('scheduledTasks.permissions')} value={draft.permissionMode} options={[{ key: 'read-only', name: t('scheduledTasks.readOnly') }, { key: 'default', name: t('scheduledTasks.standard') }, { key: 'acceptEdits', name: t('scheduledTasks.acceptEdits') }, { key: 'plan', name: t('scheduledTasks.plan') }]}
                        onChange={key => update('permissionMode', key as ScheduleDraft['permissionMode'])} testID="scheduled-task-permissions" />
                    <Choice title={t('scheduledTasks.notification')} value={draft.notificationPolicy} options={[{ key: 'all', name: t('scheduledTasks.notifyAll') }, { key: 'important', name: t('scheduledTasks.notifyImportant') }, { key: 'none', name: t('scheduledTasks.notifyNone') }]}
                        onChange={key => update('notificationPolicy', key as ScheduleDraft['notificationPolicy'])} testID="scheduled-task-notifications" />
                    <Item title={t('scheduledTasks.newChat')} subtitle={t('scheduledTasks.newChatHint')} rightElement={<Switch value={draft.newChatEachRun} onValueChange={value => update('newChatEachRun', value)} />} />
                    {task && <Item title={t('scheduledTasks.resetBinding')} subtitle={t('scheduledTasks.resetBindingHint')} rightElement={<Switch value={draft.resetBinding} onValueChange={value => update('resetBinding', value)} />} />}
                </ItemGroup><Text style={styles.hint}>{t('scheduledTasks.importantHint')}</Text>
            </>}
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </ScrollView>
        <View style={styles.footer}><Pressable onPress={() => void close()} disabled={busy} style={({ pressed }) => [styles.button, pressed && styles.pressed]}><Text style={styles.label}>{t('scheduledTasks.cancel')}</Text></Pressable>
            <Pressable testID="scheduled-task-save" accessibilityRole="button" onPress={() => void save()} disabled={busy} style={({ pressed }) => [styles.button, styles.selected, pressed && styles.pressed]}><Text style={styles.label}>{t(busy ? 'scheduledTasks.saving' : 'scheduledTasks.save')}</Text></Pressable></View>
        </KeyboardAvoidingView>
    </DesktopDialogFrame>;
});

const styles = StyleSheet.create(theme => ({
    editorBody: { flexShrink: 1 }, form: { paddingVertical: 12, paddingHorizontal: 16, gap: 10 },
    field: { gap: 7 }, label: { color: theme.colors.text, fontSize: 14 }, input: { color: theme.colors.text, backgroundColor: theme.colors.input.background, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, minHeight: 44 },
    instruction: { minHeight: 120, textAlignVertical: 'top' }, hint: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, paddingHorizontal: 8 },
    choices: { maxHeight: 220, backgroundColor: theme.colors.surface }, days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    day: { padding: 10, minWidth: 40, borderRadius: 8, backgroundColor: theme.colors.surface }, selected: { backgroundColor: theme.colors.surfaceSelected }, pressed: { backgroundColor: theme.colors.surfacePressed },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, flexDirection: 'row', justifyContent: 'flex-end', padding: 16, gap: 10 },
    button: { minHeight: 44, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: theme.colors.surface }, error: { color: theme.colors.textDestructive, fontSize: 14, padding: 8 },
}));
