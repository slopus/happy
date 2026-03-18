import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useAuth } from '@/auth/AuthContext';
import { cancelOrchestratorRun, getOrchestratorRun, pendOrchestratorRun, type OrchestratorRunDetail } from '@/sync/apiOrchestrator';
import { OrchestratorStatusBadge } from '@/components/orchestrator/OrchestratorStatusBadge';
import { OrchestratorProgressBar } from '@/components/orchestrator/OrchestratorProgressBar';
import {
    formatOrchestratorProviderLabel,
    resolveOrchestratorAttemptDisplay,
    resolveOrchestratorSummaryLineDataFromTasks,
    sanitizeOrchestratorOutputSummary,
} from '@/components/orchestrator/display';
import { isRunActive } from '@/components/orchestrator/status';
import { Modal } from '@/modal';
import { delay } from '@/utils/time';
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
    metaText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    title: {
        fontSize: 20,
        fontWeight: '700',
        color: theme.colors.text,
    },
    summaryLine: {
        marginTop: 8,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    progressBar: {
        marginTop: 10,
    },
    taskRow: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        padding: 12,
        marginTop: 10,
        backgroundColor: theme.colors.surface,
    },
    taskHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    taskTitle: {
        flex: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    taskMeta: {
        marginTop: 6,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    depWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 8,
    },
    depPill: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: theme.colors.surfaceHighest,
    },
    depText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    outputSummary: {
        marginTop: 8,
        fontSize: 13,
        color: theme.colors.text,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    error: {
        marginTop: 12,
        color: theme.colors.textDestructive,
        textAlign: 'center',
    },
    cancelButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    cancelButtonText: {
        color: theme.colors.textDestructive,
        fontWeight: '600',
        fontSize: 14,
    },
}));

export default function OrchestratorRunDetailScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { runId } = useLocalSearchParams<{ runId: string; }>();
    const router = useRouter();
    const auth = useAuth();
    const credentials = auth.credentials;

    const [run, setRun] = React.useState<OrchestratorRunDetail | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);
    const [canceling, setCanceling] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const loadRun = React.useCallback(async (opts?: { silent?: boolean; }) => {
        if (!credentials || !runId) {
            return;
        }
        if (!opts?.silent) {
            setLoading(true);
        }
        try {
            setError(null);
            const data = await getOrchestratorRun(credentials, runId, {
                includeTasks: true,
                includeExecutions: true,
            });
            setRun(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('settings.orchestratorRunLoadError'));
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [credentials, runId]);

    const handleRefresh = React.useCallback(() => {
        setRefreshing(true);
        void loadRun({ silent: true });
    }, [loadRun]);

    const handleCancelRun = React.useCallback(async () => {
        if (!credentials || !runId || !run) {
            return;
        }
        if (!isRunActive(run.status) || run.status === 'canceling') {
            return;
        }

        const confirmed = await Modal.confirm(
            t('settings.orchestratorCancelTitle'),
            t('settings.orchestratorCancelMessage'),
            {
                confirmText: t('settings.orchestratorCancelConfirm'),
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        try {
            setCanceling(true);
            await cancelOrchestratorRun(credentials, runId, 'Cancelled from app');
            await loadRun({ silent: true });
        } catch (err) {
            Modal.alert(t('settings.orchestratorCancelFailedTitle'), err instanceof Error ? err.message : t('settings.orchestratorCancelFailedMessage'));
        } finally {
            setCanceling(false);
        }
    }, [credentials, runId, run, loadRun]);

    useFocusEffect(React.useCallback(() => {
        if (!credentials || !runId) {
            return () => undefined;
        }

        let cancelled = false;
        let cursor: string | undefined;
        let pendController: AbortController | null = null;

        const loop = async () => {
            await loadRun({ silent: false });
            while (!cancelled) {
                try {
                    pendController = new AbortController();
                    const pend = await pendOrchestratorRun(credentials, runId, {
                        cursor,
                        waitFor: 'change',
                        timeoutMs: 25_000,
                        include: 'all_tasks',
                    }, {
                        signal: pendController.signal,
                    });
                    pendController = null;
                    if (cancelled) {
                        break;
                    }
                    cursor = pend.cursor;
                    if (pend.changed) {
                        await loadRun({ silent: true });
                        if (cancelled) {
                            break;
                        }
                    }
                    if (pend.terminal) {
                        break;
                    }
                } catch (error) {
                    pendController = null;
                    if (!cancelled) {
                        if (error instanceof Error && error.name === 'AbortError') {
                            break;
                        }
                        await delay(1500);
                    }
                }
            }
        };

        void loop();

        return () => {
            cancelled = true;
            pendController?.abort();
        };
    }, [credentials, runId, loadRun]));

    const canCancel = !!run && isRunActive(run.status) && run.status !== 'canceling';
    const runSummaryLine = run ? resolveOrchestratorSummaryLineDataFromTasks(run.summary, run.tasks) : null;

    if (loading && !run) {
        return (
            <View style={styles.center}>
                <Stack.Screen options={{ headerTitle: t('settings.orchestratorRunDetails') }} />
                <ActivityIndicator size="large" />
                <Text style={styles.metaText}>{t('settings.orchestratorLoadingRun')}</Text>
            </View>
        );
    }

    if (!run) {
        return (
            <View style={styles.center}>
                <Stack.Screen options={{ headerTitle: t('settings.orchestratorRunDetails') }} />
                <Text style={styles.sectionTitle}>{t('settings.orchestratorRunNotFound')}</Text>
                {!!error && <Text style={styles.error}>{error}</Text>}
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerTitle: run.title || t('settings.orchestratorRunDetails'),
                    headerRight: canCancel ? () => (
                        <Pressable
                            style={styles.cancelButton}
                            onPress={handleCancelRun}
                            disabled={canceling || run.status === 'canceling'}
                        >
                            <Text style={styles.cancelButtonText}>
                                {run.status === 'canceling' || canceling ? t('settings.orchestratorCanceling') : t('settings.orchestratorCancel')}
                            </Text>
                        </Pressable>
                    ) : undefined,
                }}
            />
            <ScrollView
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.colors.textSecondary} />}
                contentContainerStyle={[
                    styles.contentContainer,
                    { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' },
                ]}
            >
                <View style={styles.card}>
                    <View style={styles.taskHeader}>
                        <Text style={styles.title}>{run.title}</Text>
                        <OrchestratorStatusBadge status={run.status} />
                    </View>
                    <Text style={styles.summaryLine}>{t('settings.orchestratorLabelRunId')}: {run.runId}</Text>
                    <Text style={styles.summaryLine}>{t('settings.orchestratorLabelCreated')}: {formatDate(run.createdAt)}</Text>
                    <Text style={styles.summaryLine}>{t('settings.orchestratorLabelUpdated')}: {formatDate(run.updatedAt)}</Text>
                    <View style={styles.progressBar}>
                        <OrchestratorProgressBar summary={run.summary} />
                    </View>
                    <Text style={styles.summaryLine}>
                        {t('settings.orchestratorSummaryLine', {
                            total: runSummaryLine?.total ?? run.summary.total,
                            running: runSummaryLine?.running ?? run.summary.running,
                            completed: runSummaryLine?.completed ?? run.summary.completed,
                            failed: runSummaryLine?.failed ?? run.summary.failed,
                            cancelled: runSummaryLine?.cancelled ?? run.summary.cancelled,
                        })}
                    </Text>
                </View>

                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>{t('settings.orchestratorTasksTitle')}</Text>
                    {(run.tasks ?? []).map((task) => {
                        const attempt = resolveOrchestratorAttemptDisplay(task);
                        const providerLabel = formatOrchestratorProviderLabel(task);
                        const outputSummary = sanitizeOrchestratorOutputSummary(task.outputSummary);
                        return (
                            <Pressable
                                key={task.taskId}
                                style={styles.taskRow}
                                onPress={() => router.push(`/orchestrator/${run.runId}/task/${task.taskId}`)}
                            >
                                <View style={styles.taskHeader}>
                                    <Text style={styles.taskTitle} numberOfLines={1}>
                                        #{task.seq} {task.title || task.taskKey || t('settings.orchestratorProviderTask', { provider: task.provider })}
                                    </Text>
                                    <OrchestratorStatusBadge status={task.status} />
                                </View>
                                <Text style={styles.taskMeta}>
                                    {t('settings.orchestratorTaskMeta', { provider: providerLabel, current: attempt.current, max: attempt.max })}
                                </Text>
                                {task.taskKey ? (
                                    <Text style={styles.taskMeta}>{t('settings.orchestratorLabelTaskKey')}: {task.taskKey}</Text>
                                ) : null}
                                {task.dependsOn.length > 0 ? (
                                    <View style={styles.depWrap}>
                                        {task.dependsOn.map((dependencyKey) => (
                                            <View key={`${task.taskId}-${dependencyKey}`} style={styles.depPill}>
                                                <Text style={styles.depText}>{t('settings.orchestratorDependsOnKey', { key: dependencyKey })}</Text>
                                            </View>
                                        ))}
                                    </View>
                                ) : null}
                                {outputSummary ? <Text style={styles.outputSummary}>{outputSummary}</Text> : null}
                            </Pressable>
                        );
                    })}
                </View>

                {!!error && <Text style={styles.error}>{error}</Text>}
            </ScrollView>
        </View>
    );
}
