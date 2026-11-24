import * as React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { v4 as uuid } from 'uuid';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Switch } from '@/components/Switch';
import { Typography } from '@/constants/Typography';
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
import { ScheduleChoice as Choice } from './ScheduleChoice';

function Field({ label, value, onChange, multiline = false, testID, disabled = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; testID?: string; disabled?: boolean }) {
    const { theme } = useUnistyles();
    return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} testID={testID} value={value}
        onChangeText={onChange} multiline={multiline} editable={!disabled} placeholderTextColor={theme.colors.textSecondary} autoCapitalize="none" autoCorrect={false}
        style={[styles.input, multiline && styles.instruction, disabled && styles.disabled]} /></View>;
}

function EditorButton({ label, onPress, disabled, primary, testID }: { label: string; onPress: () => void; disabled: boolean; primary?: boolean; testID?: string }) {
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.button, primary && styles.selected, !disabled && (hovered || pressed) && styles.pressed,
            focused && styles.focused, disabled && styles.disabled]}><Text style={[styles.label, primary && styles.primaryLabel]}>{label}</Text></Pressable>;
}

export const TaskEditor = React.memo(function TaskEditor({ task: liveTask, template, onClose, onSaved }: { task?: DecryptedScheduledTask; template?: { title: string; prompt: string }; onClose: () => void; onSaved?: (taskId: string) => void }) {
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
            const machine = machines.find(m => m.metadata?.scheduledTasks === 1 && isMachineOnline(m)) ?? machines.find(m => m.metadata?.scheduledTasks === 1) ?? machines[0];
            draft.machineId = machine?.id ?? ''; draft.directory = machine?.metadata?.homeDir ?? '';
            if (template) Object.assign(draft, template);
        }
        return draft;
    }, []);
    const baseline = React.useRef(initial);
    const directoryEdited = React.useRef(false);
    const [draft, setDraft] = React.useState(initial);
    const [advanced, setAdvanced] = React.useState(false);
    const [advancedHovered, setAdvancedHovered] = React.useState(false);
    const [advancedFocused, setAdvancedFocused] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const busyRef = React.useRef(false);
    const closingRef = React.useRef(false);
    const [error, setError] = React.useState<string | null>(null);
    const id = React.useRef(task?.id ?? uuid()).current;
    const selectedMachine = machines.find(machine => machine.id === draft.machineId);
    // The machine directory can arrive after the editor opens. Automatic defaults
    // update the dirty baseline, while preserving anything the user already typed.
    React.useEffect(() => {
        if (task || !machines.length) return;
        if (draft.machineId) {
            const homeDir = selectedMachine?.metadata?.homeDir;
            if (!draft.directory && homeDir && !directoryEdited.current) {
                if (baseline.current.machineId === draft.machineId && !baseline.current.directory) baseline.current = { ...baseline.current, directory: homeDir };
                setDraft(current => current.machineId === draft.machineId && !current.directory ? { ...current, directory: homeDir } : current);
            }
            return;
        }
        const machine = machines.find(m => m.metadata?.scheduledTasks === 1 && isMachineOnline(m)) ?? machines.find(m => m.metadata?.scheduledTasks === 1) ?? machines[0];
        baseline.current = { ...baseline.current, machineId: machine.id, directory: baseline.current.directory || machine.metadata?.homeDir || '' };
        setDraft(current => current.machineId ? current : { ...current, machineId: machine.id,
            directory: directoryEdited.current ? current.directory : current.directory || machine.metadata?.homeDir || '' });
    }, [machines, task, draft.machineId, draft.directory, selectedMachine]);
    const currentProfile = accounts.bindings.find(binding => binding.machineId === draft.machineId)?.profileId ?? undefined;
    const accountKnown = !accounts.loading && !accounts.error;
    const modelMetadata = getLatestSessionModelMetadata({ sessions, selectedMachineId: draft.machineId, agent: 'codex', codexAccountProfileId: currentProfile ?? null });
    const models = [{ key: '', name: t('scheduledTasks.defaultModel') }, ...(modelMetadata?.models?.length ? getSuggestedModelModes('codex', modelMetadata, t)
        .filter(model => model.key !== 'default').map(model => ({ key: model.key, name: model.name })) : [])];
    const efforts = [{ key: '', name: t('scheduledTasks.defaultModel') }, ...getEffortLevelsForModel('codex', draft.model, modelMetadata)
        .filter(option => ['low', 'medium', 'high', 'xhigh', 'max'].includes(option.key)).map(option => ({ key: option.key, name: option.name }))];
    const bindingChanged = Boolean(task?.config && (draft.machineId !== task.machineId || draft.agent !== task.config.agent || draft.directory !== task.config.directory));
    const update = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => {
        if (busyRef.current) return;
        if (key === 'directory') directoryEdited.current = true;
        setDraft(current => ({ ...current, [key]: value }));
    };
    const close = async () => {
        if (busyRef.current || closingRef.current) return;
        closingRef.current = true;
        try {
            if (JSON.stringify(baseline.current) !== JSON.stringify(draft) && !await Modal.confirm(t('scheduledTasks.discardTitle'), t('scheduledTasks.discardBody'), { destructive: true })) return;
            onClose();
        } finally { closingRef.current = false; }
    };
    const save = async () => {
        if (busyRef.current || closingRef.current) return;
        busyRef.current = true;
        setBusy(true); setError(null);
        try {
            if (!selectedMachine) throw new Error('machine-required');
            if (selectedMachine.metadata?.scheduledTasks !== 1) throw new Error('machine-upgrade-required');
            const pinnedProfile = task?.config && !draft.resetBinding ? task.config.codexAccountProfileId : currentProfile;
            const prepared = prepareScheduleDraft({ ...draft, codexAccountProfileId: draft.agent === 'codex' ? pinnedProfile : undefined }, Date.now(), task?.config ? { config: task.config, machineId: task.machineId } : undefined);
            if (draft.agent === 'codex' && !accountKnown) throw new Error('account-unavailable');
            await sync.scheduledTasks.save({ id, machineId: draft.machineId, rule: prepared.rule, enabled: task?.enabled ?? true,
                newChatEachRun: draft.newChatEachRun, notificationPolicy: draft.notificationPolicy }, prepared.config, task?.version ?? -1, prepared.resetBinding);
            onSaved?.(id);
            onClose();
        } catch (caught) {
            const code = caught instanceof Error ? caught.message : '';
            if (code === 'invalid-directory' || code === 'binding-reset-required') setAdvanced(true);
            setError(code === 'version-conflict' ? t('scheduledTasks.conflict') : code === 'binding-reset-required' ? t('scheduledTasks.bindingRequired') :
                code === 'time-must-be-future' ? t('scheduledTasks.future') : code === 'machine-required' ? t('scheduledTasks.selectMachine') :
                code === 'machine-upgrade-required' ? t('scheduledTasks.upgradeRequired') : code === 'account-unavailable' ? t('scheduledTasks.accountUnavailable') :
                ['network-error', 'request-failed', 'authentication-required', 'account-changed', 'encryption-unavailable'].includes(code) ? t('scheduledTasks.error') : t('scheduledTasks.invalid'));
        } finally { busyRef.current = false; setBusy(false); }
    };
    const days = t('scheduledTasks.weekdaysShort').split(' ');
    return <DesktopDialogFrame visible title={t(task ? 'scheduledTasks.edit' : 'scheduledTasks.create')} onClose={() => void close()} maxWidth={660} testID="scheduled-task-editor">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.editorBody}>
        <ScrollView style={styles.formScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
            <Field label={t('scheduledTasks.name')} value={draft.title} onChange={v => update('title', v)} disabled={busy} testID="scheduled-task-name" />
            <Field label={t('scheduledTasks.instruction')} value={draft.prompt} onChange={v => update('prompt', v)} multiline disabled={busy} testID="scheduled-task-prompt" />
            <Choice title={t('scheduledTasks.repeat')} value={draft.repeat} options={(['once', 'interval', 'daily', 'weekly'] as const).map(key => ({ key, name: t(`scheduledTasks.${key}`) }))}
                disabled={busy} onChange={key => setDraft(current => ({ ...current, repeat: key as ScheduleDraft['repeat'],
                    ...(key === 'once' && !task ? localScheduleDateTime(Date.now() + 120000, current.timezone) : {}) }))} testID="scheduled-task-repeat" />
            <View style={styles.fieldRow}>
                {draft.repeat === 'once' && <View style={styles.fieldColumn}><Field label={t('scheduledTasks.date')} value={draft.date} onChange={v => update('date', v)} disabled={busy} testID="scheduled-task-date" /></View>}
                <View style={styles.fieldColumn}>{draft.repeat === 'interval' ? <Field label={t('scheduledTasks.hours')} value={draft.hours} disabled={busy} onChange={v => setDraft(current => ({ ...current, hours: v, intervalAnchor: undefined }))} />
                    : <Field label={t('scheduledTasks.time')} value={draft.time} onChange={v => update('time', v)} disabled={busy} testID="scheduled-task-time" />}</View>
            </View>
            {draft.repeat === 'weekly' && <View style={styles.field}><Text style={styles.label}>{t('scheduledTasks.weekdays')}</Text><View style={styles.days}>{days.map((label, index) => <Pressable key={index} disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: draft.weekdays.includes(index), disabled: busy }}
                onPress={() => update('weekdays', draft.weekdays.includes(index) ? draft.weekdays.filter(day => day !== index) : [...draft.weekdays, index])}
                style={({ pressed }) => [styles.day, draft.weekdays.includes(index) && styles.selected, pressed && styles.pressed, busy && styles.disabled]}><Text style={styles.label}>{label}</Text></Pressable>)}</View></View>}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('scheduledTasks.executionSettings')}</Text>
                <Choice title={t('scheduledTasks.machine')} value={draft.machineId} options={machines.map(machine => ({ key: machine.id, name: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id }))}
                    disabled={busy} placeholder={t('scheduledTasks.selectMachine')}
                    onChange={key => {
                        if (key === draft.machineId) return;
                        const machine = machines.find(m => m.id === key);
                        directoryEdited.current = false;
                        setDraft(current => ({ ...current, machineId: key, directory: machine?.metadata?.homeDir ?? '', model: '', effort: '' }));
                    }} testID="scheduled-task-machine" />
                {!selectedMachine && <Text style={styles.hint}>{machines.length ? t('scheduledTasks.selectMachine') : t('scheduledTasks.noMachines')}</Text>}
                {selectedMachine && selectedMachine.metadata?.scheduledTasks !== 1 && <Text style={styles.hint}>{t('scheduledTasks.upgradeRequired')}</Text>}
                {selectedMachine && !isMachineOnline(selectedMachine) && <Text style={styles.hint}>{t('scheduledTasks.offlineHint')}</Text>}
                <View style={styles.fieldRow}><View style={styles.fieldColumn}>
                    <Choice title={t('scheduledTasks.engine')} value={draft.agent} options={[{ key: 'codex', name: 'Codex' }, { key: 'claude', name: 'Claude Code' }]}
                        disabled={busy} onChange={key => setDraft(current => current.agent === key ? current : { ...current, agent: key as 'codex' | 'claude', model: '', effort: '' })} testID="scheduled-task-engine" />
                </View>{draft.agent === 'codex' && <View style={styles.fieldColumn}><Choice title={t('scheduledTasks.model')} value={draft.model} options={models}
                    disabled={busy} onChange={key => setDraft(current => current.model === key ? current : { ...current, model: key, effort: '' })} testID="scheduled-task-model" /></View>}</View>
                <Choice title={t('scheduledTasks.permissions')} value={draft.permissionMode} options={[{ key: 'read-only', name: t('scheduledTasks.readOnly') }, { key: 'default', name: t('scheduledTasks.standard') }, { key: 'acceptEdits', name: t('scheduledTasks.acceptEdits') }, { key: 'plan', name: t('scheduledTasks.plan') }]}
                    disabled={busy} onChange={key => update('permissionMode', key as ScheduleDraft['permissionMode'])} testID="scheduled-task-permissions" />
                {task && bindingChanged && <Item title={t('scheduledTasks.resetBinding')} subtitle={t('scheduledTasks.resetBindingHint')} showChevron={false}
                    rightElement={<Switch disabled={busy} value={draft.resetBinding} onValueChange={value => update('resetBinding', value)} />} />}
            </View>
            <Pressable testID="scheduled-task-advanced" accessibilityRole="button" accessibilityLabel={t('scheduledTasks.advanced')} accessibilityState={{ expanded: advanced, disabled: busy }}
                disabled={busy} onPress={() => setAdvanced(v => !v)} onHoverIn={() => setAdvancedHovered(true)} onHoverOut={() => setAdvancedHovered(false)}
                onFocus={() => setAdvancedFocused(true)} onBlur={() => setAdvancedFocused(false)}
                style={({ pressed }) => [styles.advancedTrigger, (advancedHovered || pressed) && styles.pressed, advancedFocused && styles.focused, busy && styles.disabled]}>
                <View style={styles.advancedCopy}><Text style={styles.label}>{t('scheduledTasks.advanced')}</Text>
                    <Text style={styles.summary} numberOfLines={1}>{draft.timezone} · {draft.directory || t('scheduledTasks.directory')}</Text></View>
                <Ionicons name={advanced ? 'chevron-up' : 'chevron-down'} color={theme.colors.textSecondary} size={16} />
            </Pressable>
            {advanced && <View style={styles.advancedContent}>
                <Field label={t('scheduledTasks.directory')} value={draft.directory} onChange={v => update('directory', v)} disabled={busy} testID="scheduled-task-directory" />
                <Field label={t('scheduledTasks.timezone')} value={draft.timezone} onChange={v => update('timezone', v)} disabled={busy} testID="scheduled-task-timezone" />
                {draft.agent === 'codex' && <Choice title={t('scheduledTasks.effort')} value={draft.effort} options={efforts} disabled={busy} onChange={key => update('effort', key)} testID="scheduled-task-effort" />}
                <Choice title={t('scheduledTasks.notification')} value={draft.notificationPolicy} options={[{ key: 'all', name: t('scheduledTasks.notifyAll') }, { key: 'important', name: t('scheduledTasks.notifyImportant') }, { key: 'none', name: t('scheduledTasks.notifyNone') }]}
                    disabled={busy} onChange={key => update('notificationPolicy', key as ScheduleDraft['notificationPolicy'])} testID="scheduled-task-notifications" />
                <ItemGroup>
                    <Item title={t('scheduledTasks.newChat')} subtitle={t('scheduledTasks.newChatHint')} showChevron={false} rightElement={<Switch disabled={busy} value={draft.newChatEachRun} onValueChange={value => update('newChatEachRun', value)} />} />
                    {task && !bindingChanged && <Item title={t('scheduledTasks.resetBinding')} subtitle={t('scheduledTasks.resetBindingHint')} showChevron={false} rightElement={<Switch disabled={busy} value={draft.resetBinding} onValueChange={value => update('resetBinding', value)} />} />}
                </ItemGroup><Text style={styles.hint}>{t('scheduledTasks.importantHint')}</Text>
            </View>}
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </ScrollView>
        <View style={styles.footer}><EditorButton label={t('scheduledTasks.cancel')} onPress={() => void close()} disabled={busy} />
            <EditorButton testID="scheduled-task-save" primary label={t(busy ? 'scheduledTasks.saving' : 'scheduledTasks.save')} onPress={() => void save()} disabled={busy} /></View>
        </KeyboardAvoidingView>
    </DesktopDialogFrame>;
});

const styles = StyleSheet.create(theme => ({
    editorBody: { flexShrink: 1, minHeight: 0 }, formScroll: { flexShrink: 1, minHeight: 0 }, form: { paddingVertical: 12, paddingHorizontal: 16, gap: 12 },
    field: { gap: 7 }, label: { color: theme.colors.text, fontSize: 14 }, input: { color: theme.colors.text, backgroundColor: theme.colors.input.background, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, minHeight: 44 },
    instruction: { minHeight: 100, textAlignVertical: 'top' }, hint: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, paddingHorizontal: 8 },
    fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, fieldColumn: { flex: 1, flexBasis: 220, minWidth: 0 },
    section: { gap: 10, paddingTop: 8 }, sectionTitle: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default('semiBold') },
    advancedTrigger: { minHeight: 52, padding: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: theme.colors.surface },
    advancedCopy: { flex: 1, minWidth: 0, gap: 4 }, summary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 }, advancedContent: { gap: 12 },
    focused: { borderColor: theme.colors.textLink }, disabled: { opacity: 0.5 },
    days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    day: { padding: 10, minWidth: 40, borderRadius: 8, backgroundColor: theme.colors.surface }, selected: { backgroundColor: theme.colors.surfaceSelected }, pressed: { backgroundColor: theme.colors.surfacePressed },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, flexDirection: 'row', justifyContent: 'flex-end', padding: 16, gap: 10 },
    button: { minHeight: 44, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: 'transparent', backgroundColor: theme.colors.surface }, primaryLabel: { ...Typography.default('semiBold') }, error: { color: theme.colors.textDestructive, fontSize: 14, padding: 8 },
}));
