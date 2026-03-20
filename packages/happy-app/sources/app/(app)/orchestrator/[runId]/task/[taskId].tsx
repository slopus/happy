import * as React from 'react';
import { View, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useAuth } from '@/auth/AuthContext';
import { getOrchestratorTask, type OrchestratorTaskDetail, type OrchestratorTaskRecord } from '@/sync/apiOrchestrator';
import { OrchestratorStatusBadge } from '@/components/orchestrator/OrchestratorStatusBadge';
import {
    formatOrchestratorProviderLabel,
    resolveTaskMachineId,
    resolveMachineName,
    sanitizeOrchestratorOutputSummary,
    sortOrchestratorExecutionsByAttemptDesc,
} from '@/components/orchestrator/display';
import { useMachineNameMap } from '@/hooks/useMachineNameMap';
import { formatDate } from '@/utils/formatDate';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        padding: 16,
        paddingBottom: 24,
        gap: 12,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 14,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text,
        marginBottom: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 6,
    },
    title: {
        flex: 1,
        fontSize: 20,
        fontWeight: '700',
        color: theme.colors.text,
    },
    row: {
        marginTop: 6,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    bodyText: {
        marginTop: 8,
        fontSize: 14,
        color: theme.colors.text,
        lineHeight: 20,
    },
    monoText: {
        marginTop: 8,
        fontSize: 12,
        color: theme.colors.text,
        lineHeight: 18,
        fontFamily: 'monospace',
    },
    executionRow: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        padding: 12,
        marginTop: 10,
    },
    executionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    executionTitle: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    errorText: {
        marginTop: 12,
        color: theme.colors.textDestructive,
        textAlign: 'center',
    },
    hint: {
        marginTop: 8,
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
}));

function buildTaskTitle(task: OrchestratorTaskRecord): string {
    return task.title || task.taskKey || t('settings.orchestratorProviderTask', { provider: task.provider });
}

export default function OrchestratorTaskDetailScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { runId, taskId } = useLocalSearchParams<{ runId: string; taskId: string; }>();
    const auth = useAuth();
    const credentials = auth.credentials;
    const machineNameMap = useMachineNameMap();

    const [run, setRun] = React.useState<OrchestratorTaskDetail['run'] | null>(null);
    const [task, setTask] = React.useState<OrchestratorTaskRecord | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const loadTask = React.useCallback(async (opts?: { silent?: boolean; }) => {
        if (!credentials || !runId || !taskId) {
            return;
        }
        if (!opts?.silent) {
            setLoading(true);
        }
        try {
            setError(null);
            const taskData = await getOrchestratorTask(credentials, runId, taskId, {
                includeExecutions: true,
            });
            setRun(taskData.run);
            setTask(taskData.task);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('settings.orchestratorTaskLoadError'));
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [credentials, runId, taskId]);

    useFocusEffect(React.useCallback(() => {
        if (!credentials || !runId || !taskId) {
            return () => undefined;
        }
        let active = true;
        void loadTask();
        const interval = setInterval(() => {
            if (!active) {
                return;
            }
            void loadTask({ silent: true });
        }, 5000);

        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [credentials, runId, taskId, loadTask]));

    if (loading && !task) {
        return (
            <View style={styles.center}>
                <Stack.Screen options={{ headerTitle: t('settings.orchestratorTaskDetails') }} />
                <ActivityIndicator size="large" />
                <Text style={styles.hint}>{t('settings.orchestratorLoadingTask')}</Text>
            </View>
        );
    }

    if (!task) {
        return (
            <View style={styles.center}>
                <Stack.Screen options={{ headerTitle: t('settings.orchestratorTaskDetails') }} />
                <Text style={styles.sectionTitle}>{t('settings.orchestratorTaskNotFound')}</Text>
                {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>
        );
    }

    const sortedExecutions = sortOrchestratorExecutionsByAttemptDesc(task.executions ?? []);
    const providerLabel = formatOrchestratorProviderLabel(task);
    const taskOutputSummary = sanitizeOrchestratorOutputSummary(task.outputSummary);

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ headerTitle: t('settings.orchestratorTaskSeq', { seq: task.seq }) }} />
            <ScrollView
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
                    setRefreshing(true);
                    void loadTask({ silent: true });
                }} tintColor={theme.colors.textSecondary} />}
                contentContainerStyle={[
                    styles.contentContainer,
                    { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' },
                ]}
            >
                <View style={styles.card}>
                    <View style={styles.header}>
                        <Text style={styles.title} numberOfLines={1}>{buildTaskTitle(task)}</Text>
                        <OrchestratorStatusBadge status={task.status} />
                    </View>
                    <Text style={styles.row}>{t('settings.orchestratorLabelRun')}: {run?.title || run?.runId || runId}</Text>
                    <Text style={styles.row}>{t('settings.orchestratorLabelProvider')}: {providerLabel}</Text>
                    <Text style={styles.row}>{t('settings.orchestratorLabelMachine')}: {(() => {
                        const machineId = resolveTaskMachineId(task);
                        return machineId ? resolveMachineName(machineId, machineNameMap) : '-';
                    })()}</Text>
                    {!!task.taskKey && <Text style={styles.row}>{t('settings.orchestratorLabelTaskKey')}: {task.taskKey}</Text>}
                    <Text style={styles.row}>{t('settings.orchestratorLabelWorkingDir')}: {task.workingDirectory || '-'}</Text>
                    {task.dependsOn.length > 0 && <Text style={styles.row}>{t('settings.orchestratorLabelDependsOn')}: {task.dependsOn.join(', ')}</Text>}
                    {(task.retry.maxAttempts > 1 || task.retry.backoffMs > 0) && <Text style={styles.row}>{t('settings.orchestratorLabelRetryPolicy')}: {t('settings.orchestratorRetryPolicyValue', { maxAttempts: task.retry.maxAttempts, backoffMs: task.retry.backoffMs })}</Text>}
                    {!!task.nextAttemptAt && <Text style={styles.row}>{t('settings.orchestratorLabelNextAttempt')}: {formatDate(task.nextAttemptAt)}</Text>}
                </View>

                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t('settings.orchestratorResultTitle')}</Text>
                    <Text style={styles.row}>{t('settings.orchestratorLabelOutputSummary')}: {taskOutputSummary || '-'}</Text>
                    {!!task.errorCode && <Text style={styles.row}>{t('settings.orchestratorLabelErrorCode')}: {task.errorCode}</Text>}
                    {!!task.errorMessage && <Text style={styles.row}>{t('settings.orchestratorLabelErrorMessage')}: {task.errorMessage}</Text>}
                </View>

                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t('settings.orchestratorExecutionHistoryTitle')}</Text>
                    {sortedExecutions.length === 0 ? (
                        <Text style={styles.hint}>{t('settings.orchestratorNoExecutions')}</Text>
                    ) : sortedExecutions.map((execution) => {
                        const executionOutputSummary = sanitizeOrchestratorOutputSummary(execution.outputSummary);
                        return (
                            <View key={execution.executionId} style={styles.executionRow}>
                                <View style={styles.executionHeader}>
                                    <Text style={styles.executionTitle}>
                                        {t('settings.orchestratorAttemptTitle', { attempt: execution.attempt, machineId: resolveMachineName(execution.machineId, machineNameMap) })}
                                    </Text>
                                    <OrchestratorStatusBadge status={execution.status} />
                                </View>
                                <Text style={styles.row}>{t('settings.orchestratorLabelStarted')}: {formatDate(execution.startedAt)}</Text>
                                <Text style={styles.row}>{t('settings.orchestratorLabelFinished')}: {formatDate(execution.finishedAt)}</Text>
                                <Text style={styles.row}>{t('settings.orchestratorLabelExitCode')}: {execution.exitCode ?? '-'}</Text>
                                {!!execution.signal && <Text style={styles.row}>{t('settings.orchestratorLabelSignal')}: {execution.signal}</Text>}
                                {(!!execution.errorCode || !!execution.errorMessage) && <Text style={styles.row}>{t('settings.orchestratorLabelError')}: {execution.errorCode || ''}{execution.errorMessage ? ` · ${execution.errorMessage}` : ''}</Text>}
                                {executionOutputSummary ? <Text style={styles.bodyText}>{executionOutputSummary}</Text> : null}
                            </View>
                        );
                    })}
                </View>

                {!!error && <Text style={styles.errorText}>{error}</Text>}
            </ScrollView>
        </View>
    );
}
