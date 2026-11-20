import * as React from 'react';
import { ActivityIndicator, Modal, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { z } from 'zod';
import { GoalBoardSnapshotSchema, emptyGoalReview, readGoalReview, writeGoalReview, type GoalTask } from '@slopus/happy-wire';
import { projectGoalRequest, projectTaskFiles, taskApproval } from '@/sync/projectGoals';
import { reviewAttention } from '@/sync/projectReview';
import { getRuntimeAccountSelection, accountRuntimeCurrent } from '@/auth/accountRuntime';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectTaskProgress } from './ProjectTaskProgress';

export type ReviewTask = { featurePath: string; task: GoalTask };
/** The result is an index into original task records, never a parallel status store. */
export function ProjectRetrospective({ machineId, featurePaths, disabled, onClose, onStart, onOpenTask, onSaved }: {
    machineId: string; featurePaths: string[]; disabled?: boolean; onClose: () => void;
    onStart: (tasks: ReviewTask[]) => Promise<void>; onOpenTask: (item: ReviewTask) => void; onSaved: () => Promise<void>;
}) {
    const { width, height } = useWindowDimensions();
    const [items, setItems] = React.useState<ReviewTask[]>([]);
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [expanded, setExpanded] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [warnings, setWarnings] = React.useState<string[]>([]);
    const [answers, setAnswers] = React.useState<Record<string, string>>({});
    const active = React.useRef(true), lock = React.useRef(false), generation = React.useRef(0);
    const owner = React.useMemo(() => JSON.stringify(getRuntimeAccountSelection()), []);
    const current = () => active.current && accountRuntimeCurrent() && owner === JSON.stringify(getRuntimeAccountSelection());
    const scopeKey = JSON.stringify(featurePaths);
    const load = async (initial = false) => {
        const epoch = ++generation.current;
        const boards = await Promise.all(featurePaths.map(async featurePath => {
            const result = z.object({ success: z.literal(true), snapshot: GoalBoardSnapshotSchema }).parse(await projectGoalRequest(machineId, 'goalProjectRead', { featurePath }));
            if (result.snapshot.featurePath !== featurePath) throw new Error('Project returned a different scope');
            return result.snapshot;
        }));
        if (!current() || generation.current !== epoch) return;
        const next = boards.flatMap(board => board.tasks.map(task => ({ featurePath: board.featurePath, task })));
        setItems(next); setWarnings(boards.flatMap(board => board.warnings));
        setSelected(previous => initial ? new Set(next.map(item => item.task.indexPath)) : new Set([...previous].filter(path => next.some(item => item.task.indexPath === path))));
    };
    React.useEffect(() => {
        active.current = true;
        void load(true).catch(err => { if (current()) setError(String(err)); }).finally(() => { if (current()) setLoading(false); });
        return () => { active.current = false; generation.current++; };
    }, [machineId, scopeKey]);
    useProjectModalEscape(onClose, busy);
    const refreshed = async () => { await load(); if (current()) await onSaved(); };
    const run = async () => {
        if (lock.current || !current()) return;
        lock.current = true; setBusy(true); setError('');
        try { await onStart(items.filter(item => selected.has(item.task.indexPath))); }
        catch (err) { if (current()) setError(String(err)); }
        finally { lock.current = false; if (current()) setBusy(false); }
    };
    const answer = async (item: ReviewTask, id: string) => {
        if (lock.current || !current()) return;
        const key = `${item.task.indexPath}:${id}`, value = answers[key]?.trim();
        if (!value) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const binding = projectTaskFiles(machineId, item.featurePath, item.task);
            const file = await binding.readText(item.task.indexPath);
            if (!current()) return;
            const review = readGoalReview(file.content) ?? emptyGoalReview();
            const before = item.task.review?.decisions.find(decision => decision.id === id);
            const latest = review.decisions.find(decision => decision.id === id);
            if (!latest || latest.answer || JSON.stringify(latest) !== JSON.stringify(before)) throw new Error(t('projectGoals.deliveryConflict'));
            const content = writeGoalReview(file.content, { ...review, decisions: review.decisions.map(decision => decision.id === id ? { ...decision, answer: value } : decision) });
            await binding.writeText(item.task.indexPath, content, file.hash);
            if (current()) await refreshed();
        } catch (err) { if (current()) setError(String(err)); }
        finally { lock.current = false; if (current()) setBusy(false); }
    };
    const chosen = items.filter(item => selected.has(item.task.indexPath));
    const needing = chosen.filter(({ task }) => { const attention = reviewAttention(task); return attention.decisions.length || attention.gaps.length || taskApproval(task) === 'unreviewed' || taskApproval(task) === 'changed'; });
    return <Modal visible transparent animationType="none" onRequestClose={() => { if (!busy) onClose(); }}><View style={styles.backdrop}><View accessibilityViewIsModal style={[styles.dialog, { width: Math.min(840, width - 24), maxHeight: height - 32 }]} testID="project-retrospective">
        <View style={styles.header}><Text accessibilityRole="header" style={styles.title}>{t('projectGoals.retrospective')}</Text><Button label={t('common.back')} disabled={busy} onPress={onClose}><Text style={styles.link}>{t('common.back')}</Text></Button></View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.secondary}>{t('projectGoals.retrospectiveHint')}</Text>
            {loading && <ActivityIndicator />}
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {warnings.map((warning, i) => <Text key={i} style={styles.secondary}>{warning}</Text>)}
            {!loading && <>
                <Text style={styles.heading}>{t('projectGoals.needsJudgment')} · {needing.length}</Text>
                {!needing.length && <Text style={styles.secondary}>{t('projectGoals.noReviewDecisions')}</Text>}
                {needing.map(item => <View key={item.task.indexPath} style={styles.card} testID={`project-review-attention-${item.task.id}`}>
                    <Button variant="toolbar" label={item.task.title} onPress={() => onOpenTask(item)}><Text style={styles.body}>{item.task.title}</Text></Button>
                    {reviewAttention(item.task).decisions.map(decision => {
                        const key = `${item.task.indexPath}:${decision.id}`;
                        return <View key={decision.id} style={styles.group}><Text selectable style={styles.body}>{decision.question}</Text>{decision.recommendation && <Text selectable style={styles.secondary}>{t('projectGoals.reviewRecommendation')}：{decision.recommendation}</Text>}
                            <TextInput accessibilityLabel={decision.question} value={answers[key] ?? ''} onChangeText={value => setAnswers(previous => ({ ...previous, [key]: value }))} editable={!disabled && !busy} placeholder={t('projectGoals.reviewAnswer')} style={styles.input} />
                            <Button label={t('projectGoals.recordDecision')} disabled={disabled || busy || !answers[key]?.trim()} onPress={() => { void answer(item, decision.id); }}><Text style={styles.link}>{t('projectGoals.recordDecision')}</Text></Button>
                        </View>;
                    })}
                    {reviewAttention(item.task).gaps.map((gap, i) => <Text key={i} selectable style={styles.body}>{t('projectGoals.workGap')}：{gap}</Text>)}
                    {['unreviewed', 'changed'].includes(taskApproval(item.task)) && <Button label={t('projectGoals.reviewDeliverables')} disabled={busy} onPress={() => onOpenTask(item)}><Text style={styles.link}>{t('projectGoals.reviewDeliverables')}</Text></Button>}
                </View>)}
                <Button variant="toolbar" label={t('projectGoals.reviewDetails')} expanded={expanded} onPress={() => setExpanded(value => !value)} testID="project-review-details-toggle"><Text style={styles.link}>{t('projectGoals.reviewDetails')} · {chosen.length}</Text></Button>
                {expanded && chosen.map(({ task, featurePath }) => <View key={task.indexPath} style={styles.card} testID={`project-review-details-${task.id}`}>
                    <Text style={styles.heading}>{task.title}</Text><ProjectTaskProgress machineId={machineId} featurePath={featurePath} task={task} disabled={disabled || busy} onSaved={refreshed} />
                    <Text selectable style={styles.body}>{task.review?.summary || t('projectGoals.notYetReviewed')}</Text>
                    <Text selectable style={styles.secondary}>{task.expectedDeliverables.join(' · ')}</Text>
                    {task.artifacts.filter(output => output.relation === 'output').map(output => <Text key={output.id} selectable style={styles.body}>{output.name} · {output.path || output.url}{!output.available ? ` · ${t('projectGoals.sessionUnavailable')}` : ''}</Text>)}
                    {task.review?.evidence.map((evidence, i) => <Text key={i} selectable style={styles.secondary}>{evidence}</Text>)}
                    {task.review?.recognitions.map((recognition, i) => <Text key={`recognition-${i}`} selectable style={styles.secondary}>{recognition.target} · {recognition.evidence.join(' · ')}</Text>)}
                    {task.review?.statusChanges.map(change => <Text key={change.id} selectable style={styles.secondary}>{t(`goalBoard.status.${change.from}`)} → {t(`goalBoard.status.${change.to}`)} · {change.reason} · {change.evidence.join(' · ')}{change.revertedAt !== undefined ? ` · ${t('projectGoals.progressUndone')}` : ''}</Text>)}
                    {task.review?.decisions.filter(decision => decision.answer).map(decision => <Text key={decision.id} selectable style={styles.secondary}>{decision.question} → {decision.answer}</Text>)}
                </View>)}
                <Text style={styles.heading}>{t('projectGoals.reviewScope')} · {selected.size}/{items.length}</Text>
                <View style={styles.row}><Button label={t('projectGoals.reviewSelectAll')} disabled={busy} onPress={() => setSelected(new Set(items.map(item => item.task.indexPath)))}><Text style={styles.link}>{t('projectGoals.reviewSelectAll')}</Text></Button><Button label={t('projectGoals.reviewClearSelection')} disabled={busy} onPress={() => setSelected(new Set())}><Text style={styles.link}>{t('projectGoals.reviewClearSelection')}</Text></Button></View>
                {items.map(item => <Button key={item.task.indexPath} variant="row" label={item.task.title} selected={selected.has(item.task.indexPath)} disabled={busy} testID={`project-review-select-${item.task.id}`} onPress={() => setSelected(previous => { const next = new Set(previous); if (next.has(item.task.indexPath)) next.delete(item.task.indexPath); else next.add(item.task.indexPath); return next; })}><Text style={styles.body}>{selected.has(item.task.indexPath) ? '☑ ' : '☐ '}{item.task.title}</Text></Button>)}
            </>}
        </ScrollView>
        <View style={styles.footer}><Text style={styles.secondary}>{t('projectGoals.reviewDraftHint')}</Text><Button variant="primary" label={t('projectGoals.startRetrospective')} disabled={disabled || loading || busy || !selected.size || !!error} onPress={() => { void run(); }} testID="project-review-start"><Text style={styles.body}>{t('projectGoals.startRetrospective')}</Text></Button></View>
    </View></View></Modal>;
}
const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop },
    dialog: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
    header: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, content: { padding: 16, gap: 14 },
    title: { fontSize: 18, color: theme.colors.text, ...Typography.default('semiBold') }, heading: { fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
    body: { fontSize: 13, lineHeight: 22, color: theme.colors.text, ...Typography.default() }, secondary: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary },
    link: { fontSize: 12, color: theme.colors.textLink }, error: { fontSize: 12, color: theme.colors.textDestructive },
    card: { padding: 14, gap: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    group: { gap: 8 }, row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, input: { padding: 12, borderRadius: 8, color: theme.colors.input.text, backgroundColor: theme.colors.input.background },
    footer: { padding: 16, gap: 10, borderTopWidth: 1, borderColor: theme.colors.divider },
}));
