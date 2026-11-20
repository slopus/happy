import * as React from 'react';
import { Modal, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { changeGoalTaskStatus, undoGoalTaskStatus, readGoalReview, readGoalTaskStatus, type GoalTask, type GoalTaskStatus } from '@slopus/happy-wire';
import { getRuntimeAccountSelection, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { projectTaskFiles, isReadOnlyProjectPreview } from '@/sync/projectGoals';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectTaskStatus } from './ProjectTaskStatus';

export function ProjectTaskProgress({ machineId, featurePath, task, disabled, onSaved, compact = false }: {
    machineId: string; featurePath: string; task: GoalTask; disabled?: boolean; onSaved?: () => Promise<void>; compact?: boolean;
}) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    return <><Button variant="toolbar" label={t('projectGoals.changeProgress')} disabled={disabled || isReadOnlyProjectPreview()} onPress={() => setOpen(true)} testID={`project-task-progress-${task.id}`}><ProjectTaskStatus status={task.status} />{!compact && <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{t(`goalBoard.status.${task.status}`)}</Text>}</Button>
        {open && <ProgressEditor machineId={machineId} featurePath={featurePath} task={task} onClose={() => setOpen(false)} onSaved={onSaved} />}</>;
}
function ProgressEditor({ machineId, featurePath, task, onClose, onSaved }: {
    machineId: string; featurePath: string; task: GoalTask; onClose: () => void; onSaved?: () => Promise<void>;
}) {
    const { width, height } = useWindowDimensions();
    const [file, setFile] = React.useState<{ content: string; hash: string }>();
    const [status, setStatus] = React.useState<GoalTaskStatus>(task.status);
    const [reason, setReason] = React.useState('');
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const lock = React.useRef(false);
    const owner = React.useMemo(() => JSON.stringify(getRuntimeAccountSelection()), []);
    const alive = React.useRef(true);
    const current = () => alive.current && accountRuntimeCurrent() && owner === JSON.stringify(getRuntimeAccountSelection());
    const binding = React.useMemo(() => projectTaskFiles(machineId, featurePath, task), [machineId, featurePath, task]);
    React.useEffect(() => {
        alive.current = true;
        let cancelled = false;
        void binding.readText(task.indexPath).then(value => { if (!cancelled && current()) { const next = readGoalTaskStatus(value.content); readGoalReview(value.content); setFile(value); setStatus(next); } }).catch(err => { if (!cancelled && current()) setError(String(err)); });
        return () => { cancelled = true; alive.current = false; };
    }, [binding, task.indexPath]);
    useProjectModalEscape(onClose, busy);
    const save = async (undo?: string) => {
        if (!file || lock.current || !current()) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const content = undo ? undoGoalTaskStatus(file.content, undo, Date.now()) : changeGoalTaskStatus(file.content, status, {
                id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now(), actor: 'user',
                reason: reason.trim() || t('projectGoals.manualProgressReason'), evidence: [t('projectGoals.progressNotRecognition')],
            });
            const result = await binding.writeText(task.indexPath, content, file.hash);
            if (!current()) return;
            setFile({ content, hash: result.hash }); setStatus(readGoalTaskStatus(content)); setReason('');
            await onSaved?.();
        } catch (err) { if (current()) setError(String(err)); }
        finally { lock.current = false; if (current()) setBusy(false); }
    };
    const history = file ? readGoalReview(file.content)?.statusChanges ?? [] : [];
    const latest = history.at(-1);
    return <Modal visible transparent animationType="none" onRequestClose={() => { if (!busy) onClose(); }}><View style={styles.backdrop}><View accessibilityViewIsModal style={[styles.dialog, { width: Math.min(width - 24, 560), maxHeight: height - 32 }]}>
        <View style={styles.row}><Text accessibilityRole="header" style={styles.title}>{t('projectGoals.changeProgress')}</Text><Button label={t('common.back')} disabled={busy} onPress={onClose}><Text style={styles.link}>{t('common.back')}</Text></Button></View>
        <ScrollView contentContainerStyle={styles.content}><Text style={styles.body}>{task.title}</Text><Text style={styles.secondary}>{t('projectGoals.progressNotRecognition')}</Text>
            <View style={styles.options}>{(['pending', 'running', 'review', 'done', 'blocked', ...(status === 'unknown' ? ['unknown'] : [])] as GoalTaskStatus[]).map(value => <Button key={value} variant="chip" label={t(`goalBoard.status.${value}`)} selected={status === value} disabled={!file || busy} onPress={() => setStatus(value)} testID={`project-progress-option-${value}`}><Text style={styles.body}>{t(`goalBoard.status.${value}`)}</Text></Button>)}</View>
            <TextInput value={reason} onChangeText={setReason} editable={!busy} accessibilityLabel={t('projectGoals.progressReason')} placeholder={t('projectGoals.progressReason')} style={styles.input} />
            <Button variant="primary" label={t('common.save')} disabled={!file || busy || status === readGoalTaskStatus(file.content)} onPress={() => { void save(); }} testID="project-progress-save"><Text style={styles.body}>{t('common.save')}</Text></Button>
            {latest && <View style={styles.content}><Text style={styles.secondary}>{t(`goalBoard.status.${latest.from}`)} → {t(`goalBoard.status.${latest.to}`)}</Text><Text style={styles.body}>{latest.reason}</Text>{latest.evidence.map((value, i) => <Text key={i} selectable style={styles.secondary}>{value}</Text>)}<Button label={t('projectGoals.undoProgress')} disabled={busy || latest.revertedAt !== undefined || !file || readGoalTaskStatus(file.content) !== latest.to} onPress={() => { void save(latest.id); }} testID="project-progress-undo"><Text style={styles.link}>{t(latest.revertedAt !== undefined ? 'projectGoals.progressUndone' : 'projectGoals.undoProgress')}</Text></Button></View>}
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </ScrollView>
    </View></View></Modal>;
}
const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop },
    dialog: { backgroundColor: theme.colors.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, overflow: 'hidden' },
    row: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, content: { padding: 16, gap: 12 },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, title: { fontSize: 16, color: theme.colors.text, ...Typography.default('semiBold') },
    body: { fontSize: 13, lineHeight: 21, color: theme.colors.text, ...Typography.default() }, secondary: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary },
    link: { fontSize: 12, color: theme.colors.textLink }, error: { fontSize: 12, color: theme.colors.textDestructive },
    input: { padding: 12, color: theme.colors.input.text, backgroundColor: theme.colors.input.background, borderRadius: 8, fontSize: 13 },
}));
