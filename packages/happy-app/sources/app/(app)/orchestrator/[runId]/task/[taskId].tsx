import * as React from 'react';
import { View, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useAuth } from '@/auth/AuthContext';
import { getOrchestratorTask, type OrchestratorExecutionRecord, type OrchestratorTaskDetail, type OrchestratorTaskRecord } from '@/sync/apiOrchestrator';
import { OrchestratorStatusBadge } from '@/components/orchestrator/OrchestratorStatusBadge';
import { formatDate } from '@/utils/formatDate';

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
    title: {
        fontSize: 20,
        fontWeight: '700',
        color: theme.colors.text,
        marginBottom: 6,
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
    return task.title || task.taskKey || `${task.provider} task`;
}

function sortExecutions(executions: OrchestratorExecutionRecord[]): OrchestratorExecutionRecord[] {
    return [...executions].sort((a, b) => b.attempt - a.attempt);
}

export default function OrchestratorTaskDetailScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { runId, taskId } = useLocalSearchParams<{ runId: string; taskId: string; }>();
    const auth = useAuth();
    const credentials = auth.credentials;

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
            setError(err instanceof Error ? err.message : 'Failed to load task');
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
                <Stack.Screen options={{ headerTitle: 'Task Details' }} />
                <ActivityIndicator size="large" />
                <Text style={styles.hint}>Loading task details...</Text>
            </View>
        );
    }

    if (!task) {
        return (
            <View style={styles.center}>
                <Stack.Screen options={{ headerTitle: 'Task Details' }} />
                <Text style={styles.sectionTitle}>Task not found</Text>
                {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>
        );
    }

    const sortedExecutions = sortExecutions(task.executions ?? []);

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ headerTitle: `Task #${task.seq}` }} />
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
                    <Text style={styles.title}>{buildTaskTitle(task)}</Text>
                    <OrchestratorStatusBadge status={task.status} />
                    <Text style={styles.row}>Run: {run?.title || run?.runId || runId}</Text>
                    <Text style={styles.row}>Provider: {task.provider}</Text>
                    <Text style={styles.row}>Task Key: {task.taskKey || '-'}</Text>
                    <Text style={styles.row}>Working Directory: {task.workingDirectory || '-'}</Text>
                    <Text style={styles.row}>Depends On: {task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '-'}</Text>
                    <Text style={styles.row}>Retry Policy: {task.retry.maxAttempts} attempt(s), backoff {task.retry.backoffMs}ms</Text>
                    <Text style={styles.row}>Next Attempt At: {formatDate(task.nextAttemptAt)}</Text>
                </View>

                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>Result</Text>
                    <Text style={styles.row}>Output Summary: {task.outputSummary || '-'}</Text>
                    <Text style={styles.row}>Error Code: {task.errorCode || '-'}</Text>
                    <Text style={styles.row}>Error Message: {task.errorMessage || '-'}</Text>
                </View>

                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>Retry / Execution History</Text>
                    {sortedExecutions.length === 0 ? (
                        <Text style={styles.hint}>No execution records yet.</Text>
                    ) : sortedExecutions.map((execution) => (
                        <View key={execution.executionId} style={styles.executionRow}>
                            <View style={styles.executionHeader}>
                                <Text style={styles.executionTitle}>
                                    Attempt #{execution.attempt} · {execution.machineId}
                                </Text>
                                <OrchestratorStatusBadge status={execution.status} />
                            </View>
                            <Text style={styles.row}>Started: {formatDate(execution.startedAt)}</Text>
                            <Text style={styles.row}>Finished: {formatDate(execution.finishedAt)}</Text>
                            <Text style={styles.row}>Exit Code: {execution.exitCode ?? '-'}</Text>
                            <Text style={styles.row}>Signal: {execution.signal || '-'}</Text>
                            <Text style={styles.row}>Error: {execution.errorCode || '-'} {execution.errorMessage ? `· ${execution.errorMessage}` : ''}</Text>
                            {execution.outputSummary ? <Text style={styles.bodyText}>{execution.outputSummary}</Text> : null}
                        </View>
                    ))}
                </View>

                {!!error && <Text style={styles.errorText}>{error}</Text>}
            </ScrollView>
        </View>
    );
}
