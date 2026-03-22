import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { ToolCall } from '@/sync/typesMessage';
import { MODEL_MODE_DEFAULT } from 'happy-wire';
import { CommandView } from '../CommandView';
import { CodeView } from '../CodeView';
import { SmartDataView } from '../KeyValueView';
import { OrchestratorStatusBadge } from '@/components/orchestrator/OrchestratorStatusBadge';
import { sanitizeOrchestratorOutputSummary } from '@/components/orchestrator/display';
import { formatToolOutputContent, isTrimmedToolOutput } from './toolOutputContent';
import { createToolOutputLoadingCardStyles, formatToolOutputSummaryValue } from './toolOutputLoadingCard';
import { parseMcpResult } from './parseMcpResult';
import { LongPressCopy, useCopySelectable } from '../LongPressCopy';
import { t } from '@/text';
import { useAuth } from '@/auth/AuthContext';
import { getOrchestratorRun, pendOrchestratorRun } from '@/sync/apiOrchestrator';
import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

interface ToolOutputDetailProps {
    tool: ToolCall;
}

interface GetToolOutputResponse {
    success: boolean;
    result?: unknown;
    error?: string;
}

export const ToolOutputDetail = React.memo<ToolOutputDetailProps>(({ tool }) => {
    const selectable = useCopySelectable();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const marker = isTrimmedToolOutput(tool.result) ? tool.result : null;
    const [loading, setLoading] = React.useState(Boolean(marker));
    const [error, setError] = React.useState<string | null>(null);
    const [loadedResult, setLoadedResult] = React.useState<unknown>(null);

    React.useEffect(() => {
        if (!marker) {
            setLoading(false);
            setError(null);
            setLoadedResult(null);
            return;
        }

        let cancelled = false;

        const loadResult = async () => {
            if (!sessionId) {
                setLoading(false);
                setError('Result not available');
                return;
            }

            setLoading(true);
            setError(null);

            try {
                const response = await apiSocket.sessionRPC<GetToolOutputResponse, { callId: string }>(
                    sessionId,
                    'getToolOutput',
                    { callId: marker._callId }
                );

                if (cancelled) {
                    return;
                }

                if (response.success) {
                    setLoadedResult(response.result);
                } else {
                    setError(response.error || 'Result not available');
                }
            } catch (fetchError: any) {
                if (!cancelled) {
                    setError(fetchError?.message || 'Failed to load output');
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadResult();

        return () => {
            cancelled = true;
        };
    }, [marker?._callId, sessionId]);

    if (!marker) {
        const orchestratorView = renderOrchestratorStructuredOutput(tool, tool.result, tool.result);
        if (orchestratorView) {
            return orchestratorView;
        }
        return <SmartDataView data={tool.result} />;
    }

    if (loading) {
        return (
            <View style={styles.loadingCard} testID="tool-output-loading-card">
                <ActivityIndicator size="small" testID="tool-output-loading-spinner" />
            </View>
        );
    }

    if (error) {
        const summary = getSummaryData(marker);
        const copyText = [error, ...Object.entries(summary || {}).map(([k, v]) => `${k}: ${formatToolOutputSummaryValue(v)}`)].join('\n');
        return (
            <LongPressCopy text={copyText}>
                <View style={styles.errorCard}>
                    <Text selectable={selectable} style={styles.errorText}>{error}</Text>
                    {summary ? (
                        <View style={styles.summarySection}>
                            {Object.entries(summary).map(([key, value]) => (
                                <View key={key} style={styles.summaryRow}>
                                    <Text style={styles.summaryKey}>{key}</Text>
                                    <Text style={styles.summaryValue} selectable={selectable}>
                                        {formatToolOutputSummaryValue(value)}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ) : null}
                </View>
            </LongPressCopy>
        );
    }

    const orchestratorView = renderOrchestratorStructuredOutput(tool, loadedResult, loadedResult ?? tool.result);
    if (orchestratorView) {
        return orchestratorView;
    }

    const content = formatToolOutputContent({
        toolName: tool.name,
        toolInput: tool.input,
        result: loadedResult,
        kind: marker._toolResultKind,
    });

    if (content.kind === 'command') {
        return (
            <CommandView
                command={content.command}
                stdout={content.stdout}
                stderr={content.stderr}
                error={content.error}
                fullWidth
            />
        );
    }

    if (content.kind === 'text') {
        return <CodeView code={content.text} />;
    }

    return <SmartDataView data={content.data} />;
});

type ParsedOrchestratorSummary = {
    total?: number;
    queued?: number;
    running?: number;
    completed?: number;
    failed?: number;
    cancelled?: number;
};

type ParsedOrchestratorTask = {
    taskId?: string;
    seq?: number;
    taskKey?: string;
    title?: string;
    provider?: string;
    model?: string;
    status?: string;
    outputSummary?: string | null;
};

type ParsedOrchestratorRun = {
    runId?: string;
    title?: string;
    status?: string;
    summary: ParsedOrchestratorSummary | null;
    tasks: ParsedOrchestratorTask[];
};

type ParsedOrchestratorRunFallback = {
    runId?: string;
    title?: string;
    status?: string;
    summary?: ParsedOrchestratorSummary | null;
    tasks?: ParsedOrchestratorTask[];
};

type ParsedOrchestratorContext = {
    controllerSessionId?: string;
    machineId?: string;
    workingDirectory?: string;
    defaults?: {
        mode?: string;
        maxConcurrency?: number;
        waitTimeoutMs?: number;
        pollIntervalMs?: number;
        retryMaxAttempts?: number;
        retryBackoffMs?: number;
    };
    providers: string[];
    modelModes: Record<string, string[]>;
    machines: Array<{
        machineId?: string;
        active?: boolean;
        online?: boolean;
        dispatchReady?: boolean;
        lastActiveAt?: string;
    }>;
};

function renderOrchestratorStructuredOutput(tool: ToolCall, result: unknown, fallbackData: unknown): React.ReactElement | null {
    if (!isOrchestratorToolName(tool.name)) {
        return null;
    }

    try {
        const payload = parseMcpResult(result);
        const context = extractOrchestratorContext(payload);
        const runs = extractOrchestratorRuns(payload);
        if (!context && runs.length === 0) {
            return <SmartDataView data={fallbackData} />;
        }
        return <OrchestratorStructuredOutput context={context} runs={runs} />;
    } catch (_error) {
        return <SmartDataView data={fallbackData} />;
    }
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Persisted cache: runId → latest known run state (stale-while-revalidate)
const mmkv = new MMKV();
const RUN_CACHE_KEY = 'orchestrator-run-cache';

interface OrchestratorRunCacheState {
    runs: Record<string, ParsedOrchestratorRun>;
}

function loadRunCache(): Record<string, ParsedOrchestratorRun> {
    try {
        const raw = mmkv.getString(RUN_CACHE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return {};
}

const useOrchestratorRunCache = create<OrchestratorRunCacheState>()(() => ({
    runs: loadRunCache(),
}));

useOrchestratorRunCache.subscribe((state) => {
    mmkv.set(RUN_CACHE_KEY, JSON.stringify(state.runs));
});

function cacheRun(run: ParsedOrchestratorRun) {
    if (!run.runId) return;
    const runId = run.runId;
    useOrchestratorRunCache.setState((state) => {
        if (state.runs[runId] === run) return state;
        return { runs: { ...state.runs, [runId]: run } };
    });
}

function mergeWithCache(
    initialRuns: ParsedOrchestratorRun[],
    cached: Record<string, ParsedOrchestratorRun>,
): ParsedOrchestratorRun[] {
    return initialRuns.map((run) => {
        if (!run.runId) return run;
        const hit = cached[run.runId];
        if (!hit) return run;
        // Prefer cached version if it has a terminal status (more recent than initial snapshot)
        if (hit.status && TERMINAL_STATUSES.has(hit.status)) return hit;
        // Prefer cached version if initial is still non-terminal but cache is fresher (has tasks)
        if (hit.tasks.length > 0 && run.tasks.length === 0) return hit;
        return run;
    });
}

function useOrchestratorRunPolling(initialRuns: ParsedOrchestratorRun[]): ParsedOrchestratorRun[] {
    const { credentials } = useAuth();
    const cachedRuns = useOrchestratorRunCache((state) => state.runs);
    const merged = React.useMemo(() => mergeWithCache(initialRuns, cachedRuns), [initialRuns, cachedRuns]);
    const [liveRuns, setLiveRuns] = React.useState(merged);

    // Sync liveRuns when merged changes (new initialRuns or cache update) without double-paint
    const prevMergedRef = React.useRef(merged);
    if (prevMergedRef.current !== merged) {
        prevMergedRef.current = merged;
        setLiveRuns(merged);
    }

    React.useEffect(() => {
        const activeRunIds = merged
            .filter((run) => run.runId && run.status && !TERMINAL_STATUSES.has(run.status))
            .map((run) => run.runId!);

        if (activeRunIds.length === 0 || !credentials) {
            return;
        }

        let cancelled = false;
        const pendControllers = new Map<string, AbortController>();

        const pollRun = async (runId: string) => {
            let cursor: string | undefined;
            while (!cancelled) {
                try {
                    const controller = new AbortController();
                    pendControllers.set(runId, controller);
                    const pend = await pendOrchestratorRun(credentials, runId, {
                        cursor,
                        waitFor: 'change',
                        timeoutMs: 25_000,
                        include: 'all_tasks',
                    }, { signal: controller.signal });
                    pendControllers.delete(runId);

                    if (cancelled) break;
                    cursor = pend.cursor;

                    if (pend.changed) {
                        try {
                            const detail = await getOrchestratorRun(credentials, runId, { includeTasks: true });
                            if (cancelled) break;
                            const updates = {
                                status: detail.status,
                                summary: detail.summary,
                                tasks: (detail.tasks ?? []).map((task) => ({
                                    taskId: task.taskId,
                                    seq: task.seq,
                                    taskKey: task.taskKey ?? undefined,
                                    title: task.title ?? undefined,
                                    provider: task.provider,
                                    model: task.model ?? undefined,
                                    status: task.status,
                                    outputSummary: task.outputSummary,
                                })),
                            };
                            const baseRun = merged.find((r) => r.runId === runId);
                            if (baseRun) cacheRun({ ...baseRun, ...updates });
                            setLiveRuns((prev) =>
                                prev.map((run) => run.runId === runId ? { ...run, ...updates } : run),
                            );
                        } catch (_fetchError) {
                            // getOrchestratorRun failed — continue polling
                        }
                    }

                    if (pend.terminal) break;
                } catch (error) {
                    pendControllers.delete(runId);
                    if (cancelled) break;
                    if (error instanceof Error && error.name === 'AbortError') break;
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    if (cancelled) break;
                }
            }
        };

        activeRunIds.forEach((runId) => void pollRun(runId));

        return () => {
            cancelled = true;
            pendControllers.forEach((c) => c.abort());
        };
    }, [credentials, merged]);

    return liveRuns;
}

function OrchestratorStructuredOutput({ context, runs: initialRuns }: { context: ParsedOrchestratorContext | null; runs: ParsedOrchestratorRun[] }) {
    const runs = useOrchestratorRunPolling(initialRuns);

    return (
        <LongPressCopy text={JSON.stringify({ context, runs }, null, 2)}>
            <View style={styles.orchestratorContainer}>
                {context ? <OrchestratorContextCard context={context} /> : null}
                {runs.map((run, index) => {
                    const summaryLine = formatOrchestratorSummaryLine(run.summary);
                    return (
                        <View key={run.runId ? `${run.runId}-${index}` : `run-${index}`} style={styles.orchestratorRunCard}>
                            <View style={styles.orchestratorRunHeader}>
                                <View style={styles.orchestratorRunMetaWrap}>
                                    <Text style={styles.orchestratorRunMetaLabel}>{t('settings.orchestratorLabelRunId')}</Text>
                                    <Text style={styles.orchestratorRunMetaValue}>{run.runId ?? '-'}</Text>
                                    {run.title ? <Text style={styles.orchestratorRunTitle}>{run.title}</Text> : null}
                                </View>
                                {run.status ? <OrchestratorStatusBadge status={run.status as any} /> : null}
                            </View>
                            {summaryLine ? (
                                <Text style={styles.orchestratorSummaryText}>{summaryLine}</Text>
                            ) : null}
                            {run.tasks.length > 0 ? (
                                <View style={styles.orchestratorTasksWrap}>
                                    <Text style={styles.orchestratorTasksTitle}>{t('settings.orchestratorTasksTitle')}</Text>
                                    {run.tasks.map((task, taskIndex) => {
                                        const outputSummary = sanitizeOrchestratorOutputSummary(task.outputSummary);
                                        return (
                                            <View key={task.taskId ?? `${task.seq ?? taskIndex}-${taskIndex}`} style={styles.orchestratorTaskRow}>
                                                <View style={styles.orchestratorTaskHeader}>
                                                    <Text style={styles.orchestratorTaskTitle} numberOfLines={1}>
                                                        {formatTaskTitle(task, taskIndex)}
                                                    </Text>
                                                    {task.status ? <OrchestratorStatusBadge status={task.status as any} /> : null}
                                                </View>
                                                {task.provider ? (
                                                    <Text style={styles.orchestratorTaskMeta}>
                                                        {t('settings.orchestratorLabelProvider')}: {formatOrchestratorProviderLabel(task.provider, task.model)}
                                                    </Text>
                                                ) : null}
                                                {outputSummary ? (
                                                    <Text style={styles.orchestratorTaskMeta}>
                                                        {t('settings.orchestratorLabelOutputSummary')}: {outputSummary}
                                                    </Text>
                                                ) : null}
                                            </View>
                                        );
                                    })}
                                </View>
                            ) : null}
                        </View>
                    );
                })}
            </View>
        </LongPressCopy>
    );
}

function OrchestratorContextCard({ context }: { context: ParsedOrchestratorContext }) {
    const providers = context.providers.length > 0 ? context.providers.join(', ') : '-';
    const defaultsLine = formatContextDefaults(context.defaults);

    return (
        <View style={styles.orchestratorRunCard}>
            <Text style={styles.orchestratorTasksTitle}>orchestrator context</Text>
            {context.controllerSessionId ? (
                <Text style={styles.orchestratorTaskMeta}>controllerSessionId: {context.controllerSessionId}</Text>
            ) : null}
            {context.machineId ? (
                <Text style={styles.orchestratorTaskMeta}>machineId: {context.machineId}</Text>
            ) : null}
            {context.workingDirectory ? (
                <Text style={styles.orchestratorTaskMeta}>workingDirectory: {context.workingDirectory}</Text>
            ) : null}
            <Text style={styles.orchestratorTaskMeta}>providers: {providers}</Text>
            {defaultsLine ? (
                <Text style={styles.orchestratorTaskMeta}>defaults: {defaultsLine}</Text>
            ) : null}
            {Object.entries(context.modelModes).length > 0 ? (
                <View style={styles.orchestratorContextSubsection}>
                    <Text style={styles.orchestratorRunMetaLabel}>modelModes</Text>
                    {Object.entries(context.modelModes).map(([provider, modes]) => (
                        <Text key={provider} style={styles.orchestratorTaskMeta}>
                            {provider}: {modes.join(', ')}
                        </Text>
                    ))}
                </View>
            ) : null}
            {context.machines.length > 0 ? (
                <View style={styles.orchestratorContextSubsection}>
                    <Text style={styles.orchestratorRunMetaLabel}>machines</Text>
                    {context.machines.map((machine, index) => (
                        <Text key={machine.machineId ?? `machine-${index}`} style={styles.orchestratorTaskMeta}>
                            {machine.machineId ?? '-'} · active:{formatBoolean(machine.active)} · online:{formatBoolean(machine.online)} · ready:{formatBoolean(machine.dispatchReady)}
                            {machine.lastActiveAt ? ` · lastActiveAt:${machine.lastActiveAt}` : ''}
                        </Text>
                    ))}
                </View>
            ) : null}
        </View>
    );
}

function isOrchestratorToolName(toolName: string): boolean {
    const normalized = toolName.replace(/:/g, '__');
    return /(^|__)orchestrator_(get_context|submit|pend|list|cancel|send_message)$/.test(normalized);
}

function extractOrchestratorRuns(payload: unknown): ParsedOrchestratorRun[] {
    if (!payload || (typeof payload !== 'object')) {
        return [];
    }

    const runs: ParsedOrchestratorRun[] = [];
    const runsById = new Map<string, ParsedOrchestratorRun>();

    const pushRun = (candidate: unknown, fallback?: ParsedOrchestratorRunFallback) => {
        const parsed = parseOrchestratorRunCandidate(candidate, fallback);
        if (!parsed) {
            return;
        }

        if (parsed.runId) {
            const existing = runsById.get(parsed.runId);
            if (existing) {
                if (getRunDataScore(parsed) > getRunDataScore(existing)) {
                    runsById.set(parsed.runId, parsed);
                    const index = runs.findIndex((item) => item.runId === parsed.runId);
                    if (index >= 0) {
                        runs[index] = parsed;
                    }
                }
                return;
            }
            runsById.set(parsed.runId, parsed);
        }

        runs.push(parsed);
    };

    if (Array.isArray(payload)) {
        payload.forEach((item) => pushRun(item));
        return runs;
    }

    const payloadObject = payload as Record<string, unknown>;

    pushRun(payloadObject);
    pushRun(payloadObject.run);

    const data = isPlainObject(payloadObject.data) ? payloadObject.data : null;
    if (data) {
        pushRun(data);
        pushRun(data.run, {
            runId: asString(data.runId),
            title: asString(data.title),
            status: asString(data.status),
            summary: parseOrchestratorSummary(data.summary),
            tasks: parseOrchestratorTasks(data.tasks),
        });

        if (Array.isArray(data.items)) {
            data.items.forEach((item: unknown) => pushRun(item));
        }
    }

    const submit = isPlainObject(payloadObject.submit) ? payloadObject.submit : null;
    if (submit) {
        pushRun(submit);
    }

    const blocking = isPlainObject(payloadObject.blocking) ? payloadObject.blocking : null;
    if (blocking) {
        pushRun(blocking);
        pushRun(blocking.run);
        pushRun(blocking.lastPend);
    }

    return runs;
}

function extractOrchestratorContext(payload: unknown): ParsedOrchestratorContext | null {
    if (!isPlainObject(payload)) {
        return null;
    }

    const payloadObject = payload as Record<string, unknown>;
    const candidates: unknown[] = [payloadObject];
    if (isPlainObject(payloadObject.data)) {
        candidates.push(payloadObject.data);
    }

    for (const candidate of candidates) {
        const parsed = parseOrchestratorContextCandidate(candidate);
        if (parsed) {
            return parsed;
        }
    }

    return null;
}

function parseOrchestratorContextCandidate(value: unknown): ParsedOrchestratorContext | null {
    if (!isPlainObject(value)) {
        return null;
    }

    const providers = Array.isArray(value.providers)
        ? value.providers.filter((item): item is string => typeof item === 'string')
        : [];

    const modelModes = isPlainObject(value.modelModes)
        ? Object.fromEntries(
            Object.entries(value.modelModes).map(([provider, modes]) => [
                provider,
                Array.isArray(modes) ? modes.filter((mode): mode is string => typeof mode === 'string') : [],
            ]),
        )
        : {};

    const machines = Array.isArray(value.machines)
        ? value.machines.flatMap((item) => {
            if (!isPlainObject(item)) {
                return [];
            }
            return [{
                machineId: asString(item.machineId),
                active: asBoolean(item.active),
                online: asBoolean(item.online),
                dispatchReady: asBoolean(item.dispatchReady),
                lastActiveAt: asString(item.lastActiveAt),
            }];
        })
        : [];

    const defaults = isPlainObject(value.defaults)
        ? {
            mode: asString(value.defaults.mode),
            maxConcurrency: asNumber(value.defaults.maxConcurrency),
            waitTimeoutMs: asNumber(value.defaults.waitTimeoutMs),
            pollIntervalMs: asNumber(value.defaults.pollIntervalMs),
            retryMaxAttempts: asNumber(value.defaults.retryMaxAttempts),
            retryBackoffMs: asNumber(value.defaults.retryBackoffMs),
        }
        : undefined;

    const hasContextSignal = providers.length > 0
        || Object.keys(modelModes).length > 0
        || machines.length > 0
        || !!defaults
        || !!asString(value.controllerSessionId)
        || !!asString(value.workingDirectory)
        || !!asString(value.machineId);

    if (!hasContextSignal) {
        return null;
    }

    return {
        controllerSessionId: asString(value.controllerSessionId),
        machineId: asString(value.machineId),
        workingDirectory: asString(value.workingDirectory),
        defaults,
        providers,
        modelModes,
        machines,
    };
}

function parseOrchestratorRunCandidate(candidate: unknown, fallback?: ParsedOrchestratorRunFallback): ParsedOrchestratorRun | null {
    if (!isPlainObject(candidate)) {
        return null;
    }

    const run = isPlainObject(candidate.run) ? candidate.run : null;
    const summary =
        parseOrchestratorSummary(candidate.summary)
        ?? parseOrchestratorSummary(run?.summary)
        ?? fallback?.summary
        ?? null;

    const tasksFromCandidate = parseOrchestratorTasks(candidate.tasks);
    const tasksFromRun = parseOrchestratorTasks(run?.tasks);
    const tasks = tasksFromCandidate.length > 0
        ? tasksFromCandidate
        : tasksFromRun.length > 0
            ? tasksFromRun
            : (fallback?.tasks ?? []);

    const parsed: ParsedOrchestratorRun = {
        runId: asString(candidate.runId) ?? asString(run?.runId) ?? fallback?.runId,
        title: asString(candidate.title) ?? asString(run?.title) ?? fallback?.title,
        status: asString(candidate.status) ?? asString(run?.status) ?? fallback?.status,
        summary,
        tasks,
    };

    if (!parsed.runId && !parsed.status && !parsed.summary && parsed.tasks.length === 0) {
        return null;
    }

    return parsed;
}

function parseOrchestratorSummary(value: unknown): ParsedOrchestratorSummary | null {
    if (!isPlainObject(value)) {
        return null;
    }

    const summary: ParsedOrchestratorSummary = {
        total: asNumber(value.total),
        queued: asNumber(value.queued),
        running: asNumber(value.running),
        completed: asNumber(value.completed),
        failed: asNumber(value.failed),
        cancelled: asNumber(value.cancelled),
    };

    const hasAny = Object.values(summary).some((item) => typeof item === 'number');
    return hasAny ? summary : null;
}

function parseOrchestratorTasks(value: unknown): ParsedOrchestratorTask[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((item) => {
        if (!isPlainObject(item)) {
            return [];
        }

        return [{
            taskId: asString(item.taskId),
            seq: asNumber(item.seq),
            taskKey: asString(item.taskKey),
            title: asString(item.title),
            provider: asString(item.provider),
            model: asString(item.model),
            status: asString(item.status),
            outputSummary: typeof item.outputSummary === 'string' ? item.outputSummary : null,
        } satisfies ParsedOrchestratorTask];
    });
}

function getRunDataScore(run: ParsedOrchestratorRun): number {
    let score = 0;
    if (run.status) score += 1;
    if (run.summary) score += 2;
    if (run.tasks.length > 0) score += 4;
    if (run.title) score += 1;
    return score;
}

function formatOrchestratorSummaryLine(summary: ParsedOrchestratorSummary | null): string | null {
    if (!summary) {
        return null;
    }
    const running = (summary.running ?? 0) + (summary.queued ?? 0);
    const completed = summary.completed ?? 0;
    const failed = summary.failed ?? 0;
    const cancelled = summary.cancelled ?? 0;
    const total = summary.total ?? (running + completed + failed + cancelled);
    return t('settings.orchestratorSummaryLine', {
        total,
        running,
        completed,
        failed,
        cancelled,
    });
}

function formatTaskTitle(task: ParsedOrchestratorTask, taskIndex: number): string {
    const prefix = typeof task.seq === 'number' ? `#${task.seq} ` : '';
    const title = task.title || task.taskKey || task.provider || `Task ${taskIndex + 1}`;
    return `${prefix}${title}`;
}

function formatOrchestratorProviderLabel(provider: string, model?: string): string {
    const normalizedModel = model?.trim() || MODEL_MODE_DEFAULT;
    return `${provider} · ${normalizedModel}`;
}

function getSummaryData(marker: object): Record<string, unknown> | null {
    const summary = Object.fromEntries(
        Object.entries(marker as Record<string, unknown>).filter(([key]) => !key.startsWith('_'))
    );
    return Object.keys(summary).length > 0 ? summary : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatBoolean(value: boolean | undefined): string {
    if (value === undefined) {
        return '-';
    }
    return value ? 'true' : 'false';
}

function formatContextDefaults(defaults: ParsedOrchestratorContext['defaults']): string | null {
    if (!defaults) {
        return null;
    }
    const parts: string[] = [];
    if (defaults.mode) parts.push(`mode=${defaults.mode}`);
    if (typeof defaults.maxConcurrency === 'number') parts.push(`maxConcurrency=${defaults.maxConcurrency}`);
    if (typeof defaults.waitTimeoutMs === 'number') parts.push(`waitTimeoutMs=${defaults.waitTimeoutMs}`);
    if (typeof defaults.pollIntervalMs === 'number') parts.push(`pollIntervalMs=${defaults.pollIntervalMs}`);
    if (typeof defaults.retryMaxAttempts === 'number') parts.push(`retryMaxAttempts=${defaults.retryMaxAttempts}`);
    if (typeof defaults.retryBackoffMs === 'number') parts.push(`retryBackoffMs=${defaults.retryBackoffMs}`);
    return parts.length > 0 ? parts.join(', ') : null;
}

const styles = StyleSheet.create((theme) => ({
    ...createToolOutputLoadingCardStyles(theme),
    orchestratorContainer: {
        gap: 10,
    },
    orchestratorRunCard: {
        borderWidth: 0,
        borderRadius: 6,
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
        gap: 8,
    },
    orchestratorRunHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
    },
    orchestratorRunMetaWrap: {
        flex: 1,
        gap: 2,
    },
    orchestratorRunMetaLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    orchestratorRunMetaValue: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
    orchestratorRunTitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    orchestratorSummaryText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    orchestratorTasksWrap: {
        gap: 8,
    },
    orchestratorTasksTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text,
    },
    orchestratorTaskRow: {
        borderWidth: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.modal.border,
        borderRadius: 0,
        padding: 10,
        gap: 4,
        backgroundColor: 'transparent',
    },
    orchestratorTaskHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    orchestratorTaskTitle: {
        flex: 1,
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text,
    },
    orchestratorTaskMeta: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    orchestratorContextSubsection: {
        gap: 4,
        marginTop: 2,
    },
}));
