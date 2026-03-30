import React, { memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useStore } from '@/store/store';

interface Props {
    taskId: string;
}

export const TaskDetail = memo(function TaskDetail({ taskId }: Props) {
    const tasks = useStore(s => s.tasks);
    const setTaskStatus = useStore(s => s.setTaskStatus);
    const removeTask = useStore(s => s.removeTask);
    const task = useMemo(() => tasks.find(t => t.id === taskId), [tasks, taskId]);

    if (!task) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>Task not found</Text>
            </View>
        );
    }

    const statusColors: Record<string, string> = {
        running: '#4caf50',
        waiting_for_permission: '#ff9800',
        done: '#9e9e9e',
        failed: '#f44336',
    };

    const isActive = task.status === 'running' || task.status === 'waiting_for_permission';

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerInfo}>
                    <View style={styles.headerRow}>
                        <View style={[styles.statusBadge, { backgroundColor: statusColors[task.status] }]}>
                            <Text style={styles.statusBadgeText}>{task.status.replace(/_/g, ' ')}</Text>
                        </View>
                        <Text style={styles.agentBadge}>{task.agent.name}</Text>
                    </View>
                    <Text style={styles.title}>{task.title}</Text>
                    {task.description && (
                        <Text style={styles.description}>{task.description}</Text>
                    )}
                    <Text style={styles.meta}>
                        Created {new Date(task.createdAt).toLocaleString()}
                        {task.finishedAt && ` · Finished ${new Date(task.finishedAt).toLocaleString()}`}
                    </Text>
                </View>
                <View style={styles.headerActions}>
                    {isActive && (
                        <TouchableOpacity
                            style={styles.actionButton}
                            onPress={() => setTaskStatus(task.id, 'done')}
                        >
                            <Text style={styles.actionButtonText}>Complete</Text>
                        </TouchableOpacity>
                    )}
                    {isActive && (
                        <TouchableOpacity
                            style={[styles.actionButton, styles.dangerButton]}
                            onPress={() => setTaskStatus(task.id, 'failed')}
                        >
                            <Text style={[styles.actionButtonText, styles.dangerText]}>Cancel</Text>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity
                        style={[styles.actionButton, styles.dangerButton]}
                        onPress={() => removeTask(task.id)}
                    >
                        <Text style={[styles.actionButtonText, styles.dangerText]}>Delete</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Conversation area (placeholder for future session messages) */}
            <ScrollView style={styles.conversation} contentContainerStyle={styles.conversationContent}>
                <View style={styles.messagePlaceholder}>
                    <Text style={styles.messagePlaceholderText}>
                        Conversation messages will appear here once connected to the agent session.
                    </Text>
                    {task.happySessionId && (
                        <Text style={styles.sessionId}>Session: {task.happySessionId}</Text>
                    )}
                </View>
            </ScrollView>

            {/* Input area (placeholder) */}
            {isActive && (
                <View style={styles.inputArea}>
                    <Text style={styles.inputPlaceholder}>
                        Message input will be available when session is connected
                    </Text>
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: '#999',
    },
    header: {
        padding: 20,
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    headerInfo: {
        flex: 1,
        marginRight: 16,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
    },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
    },
    statusBadgeText: {
        fontSize: 11,
        color: '#fff',
        fontWeight: '600',
        textTransform: 'capitalize',
    },
    agentBadge: {
        fontSize: 12,
        color: '#1a73e8',
        fontWeight: '600',
        backgroundColor: '#e8f0fe',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
    },
    title: {
        fontSize: 18,
        fontWeight: '700',
        color: '#333',
        marginBottom: 4,
    },
    description: {
        fontSize: 14,
        color: '#666',
        marginBottom: 4,
    },
    meta: {
        fontSize: 12,
        color: '#999',
    },
    headerActions: {
        flexDirection: 'row',
        gap: 8,
        alignItems: 'flex-start',
    },
    actionButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: '#e8f0fe',
    },
    actionButtonText: {
        fontSize: 13,
        color: '#1a73e8',
        fontWeight: '500',
    },
    dangerButton: {
        backgroundColor: '#fce8e6',
    },
    dangerText: {
        color: '#d93025',
    },
    conversation: {
        flex: 1,
    },
    conversationContent: {
        padding: 20,
        flexGrow: 1,
    },
    messagePlaceholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    messagePlaceholderText: {
        fontSize: 14,
        color: '#bbb',
        textAlign: 'center',
    },
    sessionId: {
        fontSize: 12,
        color: '#ccc',
        marginTop: 8,
        fontFamily: 'monospace',
    },
    inputArea: {
        padding: 16,
        borderTopWidth: 1,
        borderTopColor: '#e0e0e0',
        alignItems: 'center',
    },
    inputPlaceholder: {
        fontSize: 13,
        color: '#ccc',
    },
});
