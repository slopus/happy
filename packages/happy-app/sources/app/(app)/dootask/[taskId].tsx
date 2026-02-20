import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { storage, useDootaskProfile } from '@/sync/storage';
import { dootaskFetchTaskDetail } from '@/sync/dootask/api';
import { machineSpawnNewSession } from '@/sync/ops';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import type { DooTaskItem } from '@/sync/dootask/types';

function DetailField({ label, value, color, theme }: {
    label: string; value: string; color?: string; theme: any;
}) {
    return (
        <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
            <Text style={[styles.fieldValue, { color: color || theme.colors.text }]}>{value}</Text>
        </View>
    );
}

export default function DooTaskDetail() {
    const { taskId } = useLocalSearchParams<{ taskId: string }>();
    const router = useRouter();
    const { theme } = useUnistyles();
    const profile = useDootaskProfile();
    const navigateToSession = useNavigateToSession();

    const [task, setTask] = React.useState<DooTaskItem | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [spawning, setSpawning] = React.useState(false);

    React.useEffect(() => {
        if (!profile || !taskId) return;
        setLoading(true);
        dootaskFetchTaskDetail(profile.serverUrl, profile.token, Number(taskId))
            .then((res) => {
                if (res.ret === 1) {
                    setTask(res.data);
                } else {
                    setError(res.msg || 'Failed to load task');
                }
            })
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, [taskId, profile?.serverUrl]);

    const handleStartAiSession = React.useCallback(async () => {
        if (!profile || !task) return;
        setSpawning(true);
        try {
            const state = storage.getState();
            const machines = Object.values(state.machines);
            const onlineMachine = machines.find((m) => m.active);

            if (!onlineMachine) {
                router.push('/new');
                return;
            }

            const mcpServers = [{
                name: 'dootask',
                url: `${profile.serverUrl}/apps/mcp_server/mcp`,
                headers: { Authorization: `Bearer ${profile.token}` },
            }];

            const result = await machineSpawnNewSession({
                machineId: onlineMachine.id,
                directory: onlineMachine.metadata?.homeDir || '~',
                agent: 'claude',
                sessionTitle: `DooTask: ${task.name}`,
                mcpServers,
            });

            if (result.type === 'success') {
                const taskPrompt = [
                    'I need your help with a task from DooTask.',
                    `Task ID: ${task.id}`,
                    `Title: ${task.name}`,
                    `Project: ${task.project_name}`,
                    task.desc ? `Description:\n${task.desc}` : '',
                    '',
                    'Use DooTask MCP tools when needed: get_task, send_message, update_task, complete_task.',
                ].filter(Boolean).join('\n');

                storage.getState().updateSessionDraft(result.sessionId, taskPrompt);
                navigateToSession(result.sessionId);
            } else if (result.type === 'error') {
                setError(result.errorMessage);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to start session');
        } finally {
            setSpawning(false);
        }
    }, [profile, task, router, navigateToSession]);

    if (loading) {
        return <ActivityIndicator style={{ flex: 1 }} />;
    }

    if (error || !task) {
        return (
            <View style={styles.empty}>
                <Text style={{ color: theme.colors.textDestructive }}>{error || 'Task not found'}</Text>
            </View>
        );
    }

    const owner = task.taskUser?.find((u) => u.owner === 1);

    return (
        <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.groupped.background }}>
            <Text style={[styles.title, { color: theme.colors.text }]}>{task.name}</Text>

            <View style={styles.fieldGroup}>
                <DetailField label={t('dootask.project')} value={task.project_name} theme={theme} />
                <DetailField label={t('dootask.status')} value={task.flow_item_name} theme={theme} />
                <DetailField label={t('dootask.priority')} value={task.p_name} color={task.p_color} theme={theme} />
                {owner ? <DetailField label={t('dootask.assignee')} value={owner.nickname} theme={theme} /> : null}
                {task.end_at ? (
                    <DetailField
                        label={t('dootask.dueDate')}
                        value={task.end_at}
                        color={task.overdue ? theme.colors.deleteAction : undefined}
                        theme={theme}
                    />
                ) : null}
            </View>

            {task.desc ? (
                <View style={styles.descSection}>
                    <Text style={[styles.descLabel, { color: theme.colors.textSecondary }]}>
                        {t('dootask.description')}
                    </Text>
                    <Text style={[styles.descText, { color: theme.colors.text }]}>{task.desc}</Text>
                </View>
            ) : null}

            <Pressable
                style={[styles.aiButton, { backgroundColor: theme.colors.button.primary.background }, spawning && { opacity: 0.6 }]}
                onPress={handleStartAiSession}
                disabled={spawning}
            >
                {spawning ? (
                    <ActivityIndicator color={theme.colors.button.primary.tint} />
                ) : (
                    <Text style={[styles.aiButtonText, { color: theme.colors.button.primary.tint }]}>
                        {t('dootask.startAiSession')}
                    </Text>
                )}
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { padding: 20, gap: 16 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    title: { ...Typography.default('semiBold'), fontSize: 20 },
    fieldGroup: { gap: 12 },
    field: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    fieldLabel: { ...Typography.default(), fontSize: 14 },
    fieldValue: { ...Typography.default('semiBold'), fontSize: 14 },
    descSection: { gap: 6 },
    descLabel: { ...Typography.default('semiBold'), fontSize: 14 },
    descText: { ...Typography.default(), fontSize: 14, lineHeight: 20 },
    aiButton: {
        height: 48,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 8,
    },
    aiButtonText: { ...Typography.default('semiBold'), fontSize: 16 },
}));
