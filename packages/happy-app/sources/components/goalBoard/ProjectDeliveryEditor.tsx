import * as React from 'react';
import { ActivityIndicator, Modal, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GoalDeliveryAgreementSchema, readGoalDeliveryAgreement, writeGoalDeliveryAgreement, relativeGoalDeliveryFile, type GoalTask } from '@slopus/happy-wire';
import { projectGoalRequest, projectTaskFiles } from '@/sync/projectGoals';
import { getRuntimeAccountSelection, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { WorkspaceDirectoryTree } from '@/components/fileWorkspace/WorkspaceDirectoryTree';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';

type Draft = { source: string; hash: string; expected: string; criteria: string; finals: string; saved?: boolean };
const lines = (text: string) => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);

/** Editing the agreement changes the task index only; version acceptance remains separate. */
export function ProjectDeliveryEditor({ machineId, featurePath, tasks, onClose, onSaved, onDiscuss }: {
    machineId: string; featurePath: string; tasks: GoalTask[]; onClose: () => void; onSaved: () => Promise<void>; onDiscuss: (task: GoalTask) => void;
}) {
    const { theme } = useUnistyles();
    const { height, width } = useWindowDimensions();
    const [selected, setSelected] = React.useState(0);
    const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    useProjectModalEscape(onClose, busy);
    const [browsing, setBrowsing] = React.useState(false);
    const [suggested, setSuggested] = React.useState(false);
    const task = tasks[selected];
    const binding = React.useMemo(() => projectTaskFiles(machineId, featurePath, task), [machineId, featurePath, task]);
    const draft = drafts[task.id];
    const active = React.useRef(true);
    const saving = React.useRef(false);
    const owner = React.useMemo(() => JSON.stringify(getRuntimeAccountSelection()), []);
    const current = React.useCallback(() => active.current && accountRuntimeCurrent() && JSON.stringify(getRuntimeAccountSelection()) === owner, [owner]);
    React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    React.useEffect(() => {
        if (draft) return;
        let cancelled = false; setError(null);
        void binding.readText(task.indexPath).then(file => {
            if (cancelled || !current()) return;
            const managed = readGoalDeliveryAgreement(file.content);
            const finals = managed?.finalOutputs.map(output => output.target) ?? task.artifacts.filter(artifact => artifact.relation === 'output')
                .flatMap(artifact => { const target = artifact.path ? relativeGoalDeliveryFile(binding.root, artifact.path) : undefined; return artifact.url ? [artifact.url] : target ? [target] : []; });
            setDrafts(value => ({ ...value, [task.id]: { source: file.content, hash: file.hash,
                expected: (managed?.expectedDeliverables ?? task.expectedDeliverables).join('\n'), criteria: (managed?.acceptanceCriteria ?? task.acceptanceCriteria ?? []).join('\n'), finals: finals.join('\n') } }));
        }).catch(error => { if (!cancelled && current()) setError(String(error)); });
        return () => { cancelled = true; };
    }, [binding, task, !!draft, current]);
    const change = (patch: Partial<Draft>) => setDrafts(value => ({ ...value, [task.id]: { ...value[task.id], ...patch, saved: false } }));
    const save = async () => {
        if (!draft || saving.current) return;
        let agreement;
        try {
            agreement = GoalDeliveryAgreementSchema.parse({ expectedDeliverables: lines(draft.expected), acceptanceCriteria: lines(draft.criteria),
                finalOutputs: [...new Set(lines(draft.finals))].map(target => ({ target, name: task.artifacts.find(artifact => artifact.url === target || (artifact.path && relativeGoalDeliveryFile(binding.root, artifact.path) === target.replace(/\\/g, '/')))?.name ?? target.split(/[\\/]/).pop() ?? target })) });
        } catch { setError(t('projectGoals.deliveryInvalid')); return; }
        saving.current = true; setBusy(true); setError(null);
        try {
            const content = writeGoalDeliveryAgreement(draft.source, agreement);
            if (new TextEncoder().encode(content).length > 256 * 1024) throw new Error(t('projectGoals.deliveryInvalid'));
            const result = await binding.writeText(task.indexPath, content, draft.hash);
            if (!current()) return;
            setDrafts(value => ({ ...value, [task.id]: { ...draft, source: content, hash: result.hash, saved: true } }));
            await onSaved();
        } catch (error) { if (current()) setError(/conflict|changed|hash/i.test(String(error)) ? t('projectGoals.deliveryConflict') : String(error)); }
        finally { saving.current = false; if (current()) setBusy(false); }
    };
    const listDirectory = React.useCallback(async (_sessionId: string, path: string) => {
        try { return await projectGoalRequest<Awaited<ReturnType<typeof import('@/sync/ops').sessionWorkspaceListDirectory>>>(machineId, 'goalTaskListDirectory', { featurePath, taskId: task.id, path }); }
        catch (error) { return { success: false, error: String(error) }; }
    }, [machineId, featurePath, task.id]);
    return <Modal visible transparent animationType="none" onRequestClose={() => { if (!busy) onClose(); }}>
        <View style={styles.backdrop}><View accessibilityViewIsModal style={[styles.dialog, { width: Math.min(760, width - 24), maxHeight: height - 32 }]} testID="project-delivery-editor">
            <View style={styles.header}><Text accessibilityRole="header" style={styles.title}>{t(tasks.length > 1 ? 'projectGoals.batchDelivery' : 'projectGoals.deliveryEditor')}</Text><Button label={t('common.back')} disabled={busy} onPress={onClose}><Text style={styles.link}>{t('common.back')}</Text></Button></View>
            <Text style={styles.hint}>{t('projectGoals.deliveryEditorHint')}</Text>
            {tasks.length > 1 && <ScrollView horizontal style={styles.taskTabs}>{tasks.map((item, index) => <Button key={item.id} variant="chip" label={item.title} selected={selected === index} disabled={busy} onPress={() => { setSelected(index); setError(null); setSuggested(false); setBrowsing(false); }}><Text numberOfLines={1} style={[styles.body, { maxWidth: 180 }]}>{drafts[item.id]?.saved ? '✓ ' : ''}{item.title}</Text></Button>)}</ScrollView>}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.fields} keyboardShouldPersistTaps="handled">
                <Text style={styles.title}>{task.title}</Text>
                {!draft && !error && <ActivityIndicator color={theme.colors.textSecondary} />}
                {draft && <>
                    <Text style={styles.label}>{t('projectGoals.expected')}</Text>
                    <TextInput multiline editable={!busy} style={styles.input} value={draft.expected} onChangeText={expected => change({ expected })} accessibilityLabel={t('projectGoals.expected')} placeholder={t('projectGoals.expectedPlaceholder')} placeholderTextColor={theme.colors.textSecondary} testID="project-delivery-expected" />
                    {!draft.expected.trim() && <Button variant="toolbar" label={t('projectGoals.suggestDelivery')} disabled={busy} onPress={() => { change({ expected: task.goal || task.title }); setSuggested(true); }}><Text style={styles.link}>{t('projectGoals.suggestDelivery')}</Text></Button>}
                    {suggested && <Text style={styles.hint}>{t('projectGoals.suggestDeliveryHint')}</Text>}
                    <Text style={styles.label}>{t('projectGoals.criteria')}</Text>
                    <TextInput multiline editable={!busy} style={styles.input} value={draft.criteria} onChangeText={criteria => change({ criteria })} accessibilityLabel={t('projectGoals.criteria')} placeholder={t('projectGoals.criteriaPlaceholder')} placeholderTextColor={theme.colors.textSecondary} testID="project-delivery-criteria" />
                    <Text style={styles.label}>{t('projectGoals.finalPaths')}</Text>
                    <TextInput multiline editable={!busy} style={styles.input} value={draft.finals} onChangeText={finals => change({ finals })} accessibilityLabel={t('projectGoals.finalPaths')} placeholder={t('projectGoals.finalPathsPlaceholder')} placeholderTextColor={theme.colors.textSecondary} testID="project-delivery-finals" />
                    <Button variant="toolbar" label={t('projectGoals.useExistingFiles')} disabled={busy} selected={browsing} onPress={() => setBrowsing(value => !value)}><Text style={styles.link}>{t('projectGoals.useExistingFiles')}</Text></Button>
                    {browsing && <View style={{ height: 240 }}><WorkspaceDirectoryTree sessionId="" rootPath={binding.root} listDirectory={listDirectory} cacheKey={JSON.stringify([owner, machineId, binding.root, 'delivery-picker'])} onOpenFile={path => {
                        const target = path.slice(binding.root.length + 1);
                        if (!GoalDeliveryAgreementSchema.shape.finalOutputs.element.shape.target.safeParse(target).success) return;
                        const values = lines(draft.finals); change({ finals: (values.includes(target) ? values.filter(value => value !== target) : [...values, target]).join('\n') });
                    }} /></View>}
                    {draft.saved && <Text accessibilityLiveRegion="polite" style={styles.link}>{t('projectGoals.deliverySaved')}</Text>}
                </>}
                {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            </ScrollView>
            <View style={styles.footer}><Button variant="toolbar" label={t('projectGoals.editWithAI')} disabled={busy} onPress={() => onDiscuss(task)}><Text style={styles.link}>{t('projectGoals.editWithAI')}</Text></Button><Button variant="primary" label={t('common.save')} disabled={!draft || busy} onPress={() => { void save(); }} testID="project-delivery-save"><Text style={styles.body}>{t('common.save')}</Text></Button>{busy && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}</View>
        </View></View>
    </Modal>;
}
const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop },
    dialog: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 14, overflow: 'hidden', flexShrink: 1 },
    header: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    title: { fontSize: 16, lineHeight: 24, color: theme.colors.text, ...Typography.default('semiBold') },
    hint: { paddingHorizontal: 16, fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    taskTabs: { flexGrow: 0, padding: 12 }, scroll: { flexShrink: 1 }, fields: { padding: 16, gap: 12 },
    label: { fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') },
    input: { minHeight: 76, padding: 12, borderRadius: 8, backgroundColor: theme.colors.input.background, color: theme.colors.text, textAlignVertical: 'top', fontSize: 13, lineHeight: 21, ...Typography.default() },
    body: { fontSize: 13, color: theme.colors.text, ...Typography.default() }, link: { fontSize: 12, color: theme.colors.textLink, ...Typography.default() },
    error: { fontSize: 12, color: theme.colors.textDestructive, ...Typography.default() },
    footer: { padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
}));
