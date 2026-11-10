import * as React from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalArtifact, GoalArtifactKind, GoalBoardCatalogEntry, GoalBoardSnapshot, GoalTask, GoalTaskStatus } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardButton } from './GoalBoardButton';

export interface GoalBoardPanelProps {
    snapshot: GoalBoardSnapshot | null;
    catalog: GoalBoardCatalogEntry[];
    loading: boolean;
    error: string | null;
    offline: boolean;
    activeTaskId?: string;
    onSelectFeature: (entry: GoalBoardCatalogEntry) => void;
    onRefresh: () => void;
    onClose: () => void;
    onOpenArtifact: (task: GoalTask, artifact: GoalArtifact) => void;
    onOpenTask: (task: GoalTask, newSession: boolean) => Promise<void>;
    getTaskSessionId: (task: GoalTask) => string | null;
    openingTaskId?: string | null;
    renderTaskFiles?: (task: GoalTask) => React.ReactNode;
}

const NO_TASKS: GoalTask[] = [];
const STATUSES: GoalTaskStatus[] = ['pending', 'running', 'review', 'done', 'blocked', 'unknown'];
const STATUS_KEYS = {
    pending: 'goalBoard.status.pending', running: 'goalBoard.status.running', review: 'goalBoard.status.review',
    done: 'goalBoard.status.done', blocked: 'goalBoard.status.blocked', unknown: 'goalBoard.status.unknown',
} as const;
const KIND_KEYS: Record<GoalArtifactKind, 'goalBoard.kind.text' | 'goalBoard.kind.image' | 'goalBoard.kind.audio' | 'goalBoard.kind.video' | 'goalBoard.kind.pdf' | 'goalBoard.kind.commit' | 'goalBoard.kind.url' | 'goalBoard.kind.unsupported'> = {
    text: 'goalBoard.kind.text', image: 'goalBoard.kind.image', audio: 'goalBoard.kind.audio', video: 'goalBoard.kind.video',
    pdf: 'goalBoard.kind.pdf', commit: 'goalBoard.kind.commit', url: 'goalBoard.kind.url', unsupported: 'goalBoard.kind.unsupported',
};

const StatusLabel = React.memo(function StatusLabel({ status }: { status: GoalTaskStatus }) {
    return <Text style={styles.meta}>{t(STATUS_KEYS[status])}</Text>;
});

const TaskRow = React.memo(function TaskRow({ task, active, onSelect, registerRef }: {
    task: GoalTask; active: boolean; onSelect: (task: GoalTask) => void; registerRef: (id: string, node: View | null) => void;
}) {
    const { theme } = useUnistyles();
    const outputs = task.artifacts.filter((artifact) => artifact.relation === 'output').length;
    const onPress = React.useCallback(() => onSelect(task), [task, onSelect]);
    const ref = React.useCallback((node: View | null) => registerRef(task.id, node), [registerRef, task.id]);
    return <GoalBoardButton ref={ref} testID={`goal-board-task-${task.id}`} label={[task.code, task.title, t(STATUS_KEYS[task.status])].filter(Boolean).join(' · ')}
        selected={active} onPress={onPress} variant="row">
        {task.code ? <Text style={styles.code}>{task.code}</Text> : null}
        <View style={styles.rowCopy}>
            <Text style={styles.taskTitle}>{task.title}</Text>
            <StatusLabel status={task.status} />
            {task.stage ? <Text style={styles.meta}>{task.stage}</Text> : null}
            {outputs > 0 ? <Text style={styles.meta}>{t('goalBoard.outputCount', { count: outputs })}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
    </GoalBoardButton>;
});

function Fold({ id, title, children }: { id: string; title: string; children: React.ReactNode | (() => React.ReactNode) }) {
    const [expanded, setExpanded] = React.useState(false);
    const { theme } = useUnistyles();
    return <View style={styles.fold}>
        <GoalBoardButton testID={id} label={title} expanded={expanded} onPress={() => setExpanded((value) => !value)} variant="row">
            <Text style={styles.foldTitle}>{title}</Text>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
        </GoalBoardButton>
        {expanded ? <View style={styles.foldBody}>{typeof children === 'function' ? children() : children}</View> : null}
    </View>;
}

const ArtifactCard = React.memo(function ArtifactCard({ task, artifact, offline, onOpen }: {
    task: GoalTask; artifact: GoalArtifact; offline: boolean; onOpen: GoalBoardPanelProps['onOpenArtifact'];
}) {
    const disabled = offline || !artifact.available || artifact.kind === 'unsupported';
    return <View style={styles.artifact}>
        <Text style={styles.meta}>{t(KIND_KEYS[artifact.kind])}</Text>
        <Text style={styles.taskTitle}>{artifact.name}</Text>
        {artifact.description ? <Text style={styles.body}>{artifact.description}</Text> : null}
        {!artifact.available ? <Text style={styles.error}>{t('goalBoard.unavailable')}</Text> : null}
        <GoalBoardButton label={t('goalBoard.openOriginal')} testID={`goal-board-artifact-${artifact.id}`} disabled={disabled}
            onPress={() => onOpen(task, artifact)}>
            <Text style={styles.link}>{t('goalBoard.openOriginal')}</Text>
        </GoalBoardButton>
    </View>;
});

function Field({ title, value }: { title: string; value?: string }) {
    return <View style={styles.field}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.body}>{value || t('goalBoard.unknownField')}</Text>
    </View>;
}

const TaskDetail = React.memo(function TaskDetail({ task, offline, onOpenArtifact, renderTaskFiles }: {
    task: GoalTask; offline: boolean; onOpenArtifact: GoalBoardPanelProps['onOpenArtifact'];
    renderTaskFiles: GoalBoardPanelProps['renderTaskFiles'];
}) {
    const outputs = task.artifacts.filter((artifact) => artifact.relation === 'output');
    const references = task.artifacts.filter((artifact) => artifact.relation === 'reference');
    return <View style={styles.detail}>
        <View style={styles.line}><Text style={styles.code}>{task.code}</Text><StatusLabel status={task.status} /></View>
        <Text accessibilityRole="header" style={styles.detailTitle}>{task.title}</Text>
        <Field title={t('goalBoard.goal')} value={task.goal} />
        <Field title={t('goalBoard.problem')} value={task.problem} />
        <View style={styles.stage}><Field title={t('goalBoard.stage')} value={task.stage} /></View>
        <Text accessibilityRole="header" style={styles.sectionTitle}>{t('goalBoard.deliverables')}</Text>
        {outputs.length ? outputs.map((artifact) => <ArtifactCard key={artifact.id} task={task} artifact={artifact} offline={offline} onOpen={onOpenArtifact} />)
            : <Text style={styles.meta}>{t('goalBoard.noDeliverables')}</Text>}
        {renderTaskFiles ? <Fold id="goal-board-files" title={t('common.files')}>
            {() => <View style={styles.taskFiles}>{offline ? <Text style={styles.meta}>{t('status.offline')}</Text> : renderTaskFiles(task)}</View>}
        </Fold> : null}
        <Fold id="goal-board-expected" title={t('goalBoard.expected')}>
            {task.expectedDeliverables.length ? task.expectedDeliverables.map((value, index) => <Text key={index} style={styles.body}>{value}</Text>)
                : <Text style={styles.meta}>{t('goalBoard.unknownField')}</Text>}
            <Text style={styles.meta}>{t('goalBoard.expectedHint')}</Text>
        </Fold>
        {references.length ? <Fold id="goal-board-references" title={t('goalBoard.references')}>
            {references.map((artifact) => <ArtifactCard key={artifact.id} task={task} artifact={artifact} offline={offline} onOpen={onOpenArtifact} />)}
        </Fold> : null}
        <Fold id="goal-board-progress" title={t('goalBoard.progress')}>
            <Field title={t('goalBoard.currentProgress')} value={task.progress} />
            <Field title={t('goalBoard.nextStep')} value={task.nextStep} />
            <Field title={t('goalBoard.dependencies')} value={task.dependencies.join('\n')} />
        </Fold>
        <Fold id="goal-board-source" title={t('goalBoard.source')}>
            <Text selectable style={styles.path}>{task.indexPath}</Text>
            {task.promptPath ? <Text selectable style={styles.path}>{task.promptPath}</Text> : null}
        </Fold>
    </View>;
});

/** Pure presentation: no file reads, RPC, timers or production sample records. */
export const GoalBoardPanel = React.memo(function GoalBoardPanel({
    snapshot, catalog, loading, error, offline, activeTaskId, onSelectFeature, onRefresh, onClose, onOpenArtifact,
    onOpenTask, getTaskSessionId, openingTaskId, renderTaskFiles,
}: GoalBoardPanelProps) {
    const { theme } = useUnistyles();
    const tasks = snapshot?.tasks ?? NO_TASKS;
    const [query, setQuery] = React.useState('');
    const [filter, setFilter] = React.useState<GoalTaskStatus | 'all'>('all');
    const [scope, setScope] = React.useState<'all' | 'current'>('all');
    const [choosingGoal, setChoosingGoal] = React.useState(false);
    const [selection, setSelection] = React.useState<{ featurePath: string; taskId: string } | null>(null);
    const [localOpeningId, setLocalOpeningId] = React.useState<string | null>(null);
    const [taskErrorId, setTaskErrorId] = React.useState<string | null>(null);
    const openingRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const scrollRef = React.useRef<ScrollView>(null);
    const backRef = React.useRef<View>(null);
    const rowRefs = React.useRef(new Map<string, View>());
    const focusTaskRef = React.useRef<string | null>(null);
    const featureRef = React.useRef(snapshot?.featurePath);
    featureRef.current = snapshot?.featurePath;
    const selected = selection?.featurePath === snapshot?.featurePath ? tasks.find((task) => task.id === selection?.taskId) : undefined;

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    React.useEffect(() => {
        setQuery(''); setFilter('all'); setScope('all'); setSelection(null); setChoosingGoal(false); setTaskErrorId(null);
    }, [snapshot?.featurePath]);
    React.useEffect(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
        if (selected) backRef.current?.focus();
        else if (focusTaskRef.current) {
            rowRefs.current.get(focusTaskRef.current)?.focus();
            focusTaskRef.current = null;
        }
    }, [selected?.id]);

    const registerRef = React.useCallback((id: string, node: View | null) => {
        if (node) rowRefs.current.set(id, node); else rowRefs.current.delete(id);
    }, []);
    const selectTask = React.useCallback((task: GoalTask) => {
        if (featureRef.current) setSelection({ featurePath: featureRef.current, taskId: task.id });
        setTaskErrorId(null);
    }, []);
    const back = () => {
        focusTaskRef.current = selected?.id ?? null;
        setSelection(null); setTaskErrorId(null);
    };
    const currentBatch = React.useMemo(() => {
        const active = tasks.filter((task) => ['running', 'review', 'blocked'].includes(task.status));
        const batches = new Set(active.map((task) => task.batch).filter(Boolean));
        // Multiple live batches or unbatched active tasks cannot identify a current batch.
        return batches.size === 1 && active.every((task) => task.batch) ? [...batches][0] : undefined;
    }, [tasks]);
    const completed = React.useMemo(() => tasks.filter((task) => task.status === 'done').length, [tasks]);
    const filtered = React.useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return tasks.filter((task) => (scope !== 'current' || !currentBatch || task.batch === currentBatch)
            && (filter === 'all' || task.status === filter)
            && (!normalized || [task.code, task.title, task.goal, task.problem, task.batch].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized)));
    }, [tasks, query, filter, scope, currentBatch]);
    const busy = Boolean(openingTaskId || localOpeningId);
    const openTask = async (newSession: boolean) => {
        if (!selected || offline || busy || openingRef.current) return;
        const featurePath = snapshot?.featurePath;
        openingRef.current = true;
        setLocalOpeningId(selected.id); setTaskErrorId(null);
        try { await onOpenTask(selected, newSession); }
        catch { if (mountedRef.current && featureRef.current === featurePath) setTaskErrorId(selected.id); }
        finally {
            openingRef.current = false;
            if (mountedRef.current) setLocalOpeningId(null);
        }
    };
    const linked = selected ? Boolean(getTaskSessionId(selected)) : false;
    const showCatalog = !snapshot || choosingGoal;

    return <View testID="goal-board-panel" style={styles.panel}>
        <View style={styles.header}>
            {selected ? <GoalBoardButton ref={backRef} testID="goal-board-back" label={t('goalBoard.back')} onPress={back}>
                <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} /><Text style={styles.buttonText}>{t('goalBoard.back')}</Text>
            </GoalBoardButton> : <Text accessibilityRole="header" style={styles.heading}>{t('goalBoard.title')}</Text>}
            <View style={styles.headerActions}>
                <GoalBoardButton testID="goal-board-refresh" label={t('goalBoard.refresh')} disabled={loading || offline} onPress={onRefresh}>
                    <Ionicons name="refresh-outline" size={17} color={theme.colors.textSecondary} />
                </GoalBoardButton>
                <GoalBoardButton testID="goal-board-close" label={t('goalBoard.close')} onPress={onClose}>
                    <Ionicons name="close-outline" size={20} color={theme.colors.textSecondary} />
                </GoalBoardButton>
            </View>
        </View>
        {loading ? <View accessibilityLiveRegion="polite" style={styles.notice}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.meta}>{t('goalBoard.loading')}</Text></View> : null}
        {offline ? <Text accessibilityLiveRegion="polite" style={styles.noticeText}>{t(snapshot ? 'goalBoard.offline' : 'goalBoard.offlineEmpty')}</Text> : null}
        {error ? <View accessibilityRole="alert" style={styles.notice}><Text style={styles.error}>{t('goalBoard.loadError')}: {error}</Text></View> : null}
        <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {selected ? <TaskDetail key={`${snapshot?.featurePath}:${selected.id}`} task={selected} offline={offline} onOpenArtifact={onOpenArtifact} renderTaskFiles={renderTaskFiles} /> : <>
                {snapshot ? <View style={styles.overview}>
                    {snapshot.projectTitle ? <Text style={styles.meta}>{snapshot.projectTitle}</Text> : null}
                    <Text style={styles.goalTitle}>{snapshot.title}</Text>
                    <Text style={styles.meta}>{t('goalBoard.completed', { completed, total: tasks.length })}</Text>
                    <GoalBoardButton testID="goal-board-change-goal" label={t('goalBoard.changeGoal')} expanded={choosingGoal} onPress={() => setChoosingGoal((value) => !value)}>
                        <Text style={styles.link}>{t('goalBoard.changeGoal')}</Text>
                    </GoalBoardButton>
                </View> : null}
                {showCatalog ? <View style={styles.catalog}>
                    <Text style={styles.sectionTitle}>{t('goalBoard.selectGoal')}</Text>
                    {!catalog.length && !loading && !offline && !error ? <Text style={styles.meta}>{t('goalBoard.noGoals')}</Text> : null}
                    {catalog.map((entry, index) => <GoalBoardButton key={entry.featurePath} testID={`goal-board-feature-${index}`} label={[entry.projectTitle, entry.title].filter(Boolean).join(' · ')}
                        disabled={offline || loading} selected={entry.featurePath === snapshot?.featurePath} variant="row" onPress={() => { onSelectFeature(entry); setChoosingGoal(false); }}>
                        <View style={styles.rowCopy}>{entry.projectTitle ? <Text style={styles.meta}>{entry.projectTitle}</Text> : null}<Text style={styles.taskTitle}>{entry.title}</Text></View>
                    </GoalBoardButton>)}
                </View> : null}
                {snapshot ? <>
                    {currentBatch ? <View style={styles.filters}>
                        <GoalBoardButton testID="goal-board-current-batch" label={t('goalBoard.currentBatch')} selected={scope === 'current'} variant="chip" onPress={() => setScope('current')}><Text style={styles.buttonText}>{t('goalBoard.currentBatch')}</Text></GoalBoardButton>
                        <GoalBoardButton testID="goal-board-all-batches" label={t('goalBoard.allTasks')} selected={scope === 'all'} variant="chip" onPress={() => setScope('all')}><Text style={styles.buttonText}>{t('goalBoard.allTasks')}</Text></GoalBoardButton>
                    </View> : null}
                    <TextInput testID="goal-board-search" accessibilityLabel={t('goalBoard.search')} placeholder={t('goalBoard.search')} placeholderTextColor={theme.colors.textSecondary}
                        value={query} onChangeText={setQuery} style={styles.search} clearButtonMode="while-editing" autoCorrect={false} />
                    <View style={styles.filters}>
                        <GoalBoardButton testID="goal-board-filter-all" label={t('goalBoard.allTasks')} selected={filter === 'all'} variant="chip" onPress={() => setFilter('all')}><Text style={styles.buttonText}>{t('goalBoard.allTasks')}</Text></GoalBoardButton>
                        {STATUSES.map((status) => <GoalBoardButton key={status} testID={`goal-board-filter-${status}`} label={t(STATUS_KEYS[status])} selected={filter === status} variant="chip" onPress={() => setFilter(status)}><Text style={styles.buttonText}>{t(STATUS_KEYS[status])}</Text></GoalBoardButton>)}
                    </View>
                    {!tasks.length ? <Text style={styles.empty}>{t('goalBoard.empty')}</Text> : !filtered.length ? <Text style={styles.empty}>{t('goalBoard.noMatches')}</Text>
                        : filtered.map((task, index) => <React.Fragment key={task.id}>
                            {task.batch && filtered[index - 1]?.batch !== task.batch ? <Text style={styles.batch}>{task.batch}</Text> : null}
                            <TaskRow task={task} active={task.id === activeTaskId} onSelect={selectTask} registerRef={registerRef} />
                        </React.Fragment>)}
                </> : null}
            </>}
            {snapshot?.warnings.map((warning, index) => <Text key={index} style={styles.noticeText}>{warning}</Text>)}
        </ScrollView>
        {selected ? <View style={styles.footer}>
            {taskErrorId === selected.id ? <Text accessibilityRole="alert" style={styles.error}>{t('goalBoard.taskError')}</Text> : null}
            <GoalBoardButton testID="goal-board-open-task" label={t(busy ? 'goalBoard.openingTask' : linked ? 'goalBoard.continueTask' : 'goalBoard.startTask')} disabled={busy || offline} busy={busy}
                variant="primary" onPress={() => { void openTask(false); }}>
                {busy ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name={linked ? 'chatbubble-outline' : 'add-outline'} size={17} color={theme.colors.text} />}
                <Text style={styles.buttonText}>{t(busy ? 'goalBoard.openingTask' : linked ? 'goalBoard.continueTask' : 'goalBoard.startTask')}</Text>
            </GoalBoardButton>
            {linked ? <GoalBoardButton testID="goal-board-new-task" label={t('goalBoard.newTask')} disabled={busy || offline} onPress={() => { void openTask(true); }}><Text style={styles.buttonText}>{t('goalBoard.newTask')}</Text></GoalBoardButton> : null}
            <Text style={styles.hint}>{t('goalBoard.taskHint')}</Text>
        </View> : null}
    </View>;
});

const styles = StyleSheet.create((theme) => ({
    panel: { flex: 1, width: '100%', maxWidth: 380, minHeight: 0, backgroundColor: theme.colors.surface, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.divider },
    header: { minHeight: 56, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, gap: 8 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    heading: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 16, flexShrink: 1 },
    scroll: { flex: 1, minHeight: 0 },
    scrollContent: { paddingHorizontal: 12, paddingBottom: 24 },
    overview: { paddingTop: 18, paddingBottom: 10, gap: 6, alignItems: 'flex-start' },
    goalTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 16, lineHeight: 23 },
    catalog: { paddingVertical: 12, gap: 8 },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, paddingVertical: 8 },
    search: { ...Typography.default(), color: theme.colors.text, fontSize: 14, minHeight: 42, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, marginTop: 6 },
    rowCopy: { flex: 1, minWidth: 0, gap: 5 },
    taskTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 14, lineHeight: 21, flexShrink: 1 },
    code: { ...Typography.mono(), color: theme.colors.textSecondary, fontSize: 11, lineHeight: 20, minWidth: 30 },
    batch: { ...Typography.default('semiBold'), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, paddingTop: 18, paddingBottom: 6, paddingHorizontal: 12 },
    meta: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, flexShrink: 1 },
    buttonText: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 12, lineHeight: 19, flexShrink: 1 },
    link: { ...Typography.default('semiBold'), color: theme.colors.textLink, fontSize: 12, lineHeight: 19 },
    detail: { paddingTop: 16, gap: 14 },
    line: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    detailTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 22, lineHeight: 30 },
    field: { gap: 6 },
    sectionTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 13, lineHeight: 20 },
    body: { ...Typography.default(), color: theme.colors.text, fontSize: 14, lineHeight: 23 },
    stage: { borderLeftWidth: 2, borderLeftColor: theme.colors.divider, paddingLeft: 12, paddingVertical: 4 },
    artifact: { gap: 8, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 10 },
    fold: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    foldTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 13, lineHeight: 20, flex: 1 },
    taskFiles: { height: 360, minHeight: 0 },
    foldBody: { gap: 14, paddingHorizontal: 12, paddingBottom: 14 },
    path: { ...Typography.mono(), color: theme.colors.textSecondary, fontSize: 11, lineHeight: 19 },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, padding: 12, gap: 8 },
    hint: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 11, lineHeight: 18 },
    notice: { paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', gap: 8, alignItems: 'center' },
    noticeText: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, paddingHorizontal: 12, paddingVertical: 8 },
    error: { ...Typography.default(), color: theme.colors.textDestructive, fontSize: 12, lineHeight: 19, flexShrink: 1 },
    empty: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 14, lineHeight: 22, padding: 20 },
}));
