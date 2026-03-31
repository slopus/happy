import React, { memo, useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { useTaskManagerStore, useTaskManagerActions } from '@/hooks/useTaskManager';
import { ChatMessage, AgentStatus, fetchChatApi, sendChatApi } from '@/sync/apiTasks';
import { t } from '@/text';

interface Props {
    taskId: string;
}

function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export const TaskDetailView = memo(function TaskDetailView({ taskId }: Props) {
    const { theme } = useUnistyles();
    const { credentials } = useAuth();
    const tasks = useTaskManagerStore(s => s.tasks);
    const projects = useTaskManagerStore(s => s.projects);
    const machines = useTaskManagerStore(s => s.machines);
    const { setTaskStatus, removeTask, loadTasks } = useTaskManagerActions();
    const task = useMemo(() => tasks.find(t => t.id === taskId), [tasks, taskId]);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const lastSeqRef = useRef(0);
    const scrollRef = useRef<ScrollView>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const pollMessages = useCallback(async () => {
        if (!task?.happySessionId || !credentials) return;
        try {
            const resp = await fetchChatApi(credentials, task.id, lastSeqRef.current);
            if (resp.messages.length > 0) {
                lastSeqRef.current = resp.messages[resp.messages.length - 1].seq;
                setMessages(prev => [...prev, ...resp.messages]);
                setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
            }
            setAgentStatus(resp.agentStatus);
            if (resp.agentStatus === 'done' && task.status === 'running') {
                loadTasks(task.projectId);
            }
        } catch { /* retry on next poll */ }
    }, [task?.id, task?.happySessionId, task?.status, task?.projectId, credentials]);

    useEffect(() => {
        setMessages([]);
        lastSeqRef.current = 0;
        if (task?.happySessionId) {
            pollMessages();
            pollRef.current = setInterval(pollMessages, 2000);
        }
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [taskId, task?.happySessionId]);

    const handleSend = useCallback(async () => {
        if (!input.trim() || sending || !task || !credentials) return;
        const text = input.trim();
        setInput('');
        setSending(true);
        try {
            await sendChatApi(credentials, task.id, text);
            await pollMessages();
        } catch (e: any) {
            console.warn('Send failed:', e.message);
        } finally {
            setSending(false);
        }
    }, [input, sending, task?.id, pollMessages, credentials]);

    if (!task) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>{t('taskManager.taskNotFound')}</Text>
            </View>
        );
    }

    const statusColors: Record<string, string> = {
        running: theme.colors.status.connected,
        waiting_for_permission: theme.colors.status.connecting,
        done: theme.colors.textSecondary,
        failed: theme.colors.status.error,
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
                        {task.happySessionId && agentStatus !== 'idle' && (
                            <View style={[styles.agentStatusBadge, {
                                backgroundColor: agentStatus === 'working' ? '#e3f2fd' : agentStatus === 'done' ? '#e8f5e9' : '#fff3e0'
                            }]}>
                                <Text style={[styles.agentStatusText, {
                                    color: agentStatus === 'working' ? '#1565c0' : agentStatus === 'done' ? '#2e7d32' : '#e65100'
                                }]}>
                                    {agentStatus === 'working' ? t('taskManager.agentWorking') : agentStatus === 'done' ? t('taskManager.agentDone') : t('taskManager.agentWaiting')}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.agentBadge}>{task.agent.name}</Text>
                    </View>
                    <Text style={styles.title}>{task.title}</Text>
                    {task.description && task.description !== task.title && (
                        <Text style={styles.description} numberOfLines={2}>{task.description}</Text>
                    )}
                    {(() => {
                        const project = projects.find(p => p.id === task.projectId);
                        const machine = machines.find(m => m.active && m.hostInfo?.workspaceRoot);
                        const hi = machine?.hostInfo;
                        const workspacePath = project && hi?.workspaceRoot
                            ? `${hi.workspaceRoot}/${slugify(project.name)}/${slugify(task.title)}-${task.id.slice(-6)}`
                            : project?.workingDirectory || null;
                        return (hi || workspacePath) ? (
                            <View style={styles.workspaceInfo}>
                                {hi?.ip && (
                                    <Text style={styles.workspaceText}>{t('taskManager.machine')}: {machine?.displayName || hi.hostname || '?'} ({hi.ip})</Text>
                                )}
                                {workspacePath && (
                                    <Text style={styles.workspaceText} selectable>Path: {workspacePath}</Text>
                                )}
                            </View>
                        ) : null;
                    })()}
                    {task.error && (
                        <View style={styles.errorBox}>
                            <Text style={styles.errorText}>{task.error}</Text>
                        </View>
                    )}
                </View>
                <View style={styles.headerActions}>
                    {isActive && (
                        <TouchableOpacity style={styles.actionButton} onPress={() => setTaskStatus(task.id, 'done')}>
                            <Text style={styles.actionButtonText}>{t('taskManager.complete')}</Text>
                        </TouchableOpacity>
                    )}
                    {isActive && (
                        <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={() => setTaskStatus(task.id, 'failed')}>
                            <Text style={styles.dangerText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={() => removeTask(task.id)}>
                        <Text style={styles.dangerText}>{t('common.delete')}</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Chat area */}
            <ScrollView ref={scrollRef} style={styles.chatArea} contentContainerStyle={styles.chatContent}>
                {!task.happySessionId && (
                    <View style={styles.placeholder}>
                        <Text style={styles.placeholderText}>{t('taskManager.noSession')}</Text>
                    </View>
                )}
                {task.happySessionId && messages.length === 0 && (
                    <View style={styles.placeholder}>
                        <Text style={styles.placeholderText}>{t('taskManager.waitingMessages')}</Text>
                    </View>
                )}
                {messages.map((msg, i) => (
                    <MessageBubble key={`${msg.seq}-${i}`} message={msg} />
                ))}
            </ScrollView>

            {/* Input */}
            {task.happySessionId && (
                <View style={styles.inputArea}>
                    <TextInput
                        style={styles.inputField}
                        value={input}
                        onChangeText={setInput}
                        placeholder={t('taskManager.chatPlaceholder')}
                        onSubmitEditing={handleSend}
                        onKeyPress={(e: any) => {
                            if (e.nativeEvent.key === 'Enter' && (e.nativeEvent.metaKey || e.nativeEvent.ctrlKey)) {
                                e.preventDefault?.();
                                handleSend();
                            }
                        }}
                        editable={!sending}
                        multiline
                    />
                    <TouchableOpacity
                        style={[styles.sendButton, (!input.trim() || sending) && { opacity: 0.4 }]}
                        onPress={handleSend}
                        disabled={!input.trim() || sending}
                    >
                        <Text style={styles.sendButtonText}>{sending ? '...' : t('taskManager.send')}</Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
});

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
    const { theme } = useUnistyles();
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system';

    if (isSystem) {
        return (
            <View style={styles.systemMsgRow}>
                <Text style={styles.systemMsgText}>{message.text}</Text>
            </View>
        );
    }

    return (
        <View style={[styles.msgRow, isUser && styles.msgRowUser]}>
            <View style={[styles.msgBubble, isUser ? styles.msgBubbleUser : styles.msgBubbleAgent]}>
                <Text style={styles.msgRole}>{isUser ? t('taskManager.you') : t('taskManager.agentLabel')}</Text>
                <Text style={[styles.msgText, !isUser && styles.msgTextAgent]} selectable>{message.text}</Text>
                <Text style={styles.msgTime}>{new Date(message.createdAt).toLocaleTimeString()}</Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, flexDirection: 'column' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    emptyText: { fontSize: 14, color: theme.colors.textSecondary },

    header: {
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    headerInfo: { flex: 1, marginRight: 16 },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    statusBadgeText: { fontSize: 11, color: '#fff', fontWeight: '600', textTransform: 'capitalize' },
    agentStatusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    agentStatusText: { fontSize: 11, fontWeight: '600' },
    agentBadge: {
        fontSize: 12, color: theme.colors.textLink, fontWeight: '600',
        backgroundColor: theme.colors.groupped.background, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
    },
    title: { fontSize: 16, fontWeight: '700', color: theme.colors.text, marginBottom: 2 },
    description: { fontSize: 13, color: theme.colors.textSecondary, marginBottom: 2 },
    workspaceInfo: { marginTop: 6, padding: 8, backgroundColor: theme.colors.groupped.background, borderRadius: 6 },
    workspaceText: { fontSize: 12, color: theme.colors.textSecondary, fontFamily: 'monospace' as any, lineHeight: 18 },
    errorBox: { marginTop: 6, padding: 8, backgroundColor: '#fce8e6', borderRadius: 6 },
    errorText: { fontSize: 12, color: theme.colors.status.error },
    headerActions: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
    actionButton: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: theme.colors.groupped.background },
    actionButtonText: { fontSize: 12, color: theme.colors.textLink, fontWeight: '500' },
    dangerButton: { backgroundColor: '#fce8e6' },
    dangerText: { fontSize: 12, color: theme.colors.status.error, fontWeight: '500' },

    chatArea: { flex: 1 },
    chatContent: { padding: 16, flexGrow: 1 },
    placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
    placeholderText: { fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center' },

    systemMsgRow: { alignItems: 'center', marginVertical: 8 },
    systemMsgText: { fontSize: 12, color: theme.colors.textSecondary, fontStyle: 'italic', backgroundColor: theme.colors.groupped.background, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
    msgRow: { marginBottom: 12, alignItems: 'flex-start' },
    msgRowUser: { alignItems: 'flex-end' },
    msgBubble: { maxWidth: '80%' as any, padding: 12, borderRadius: 12 },
    msgBubbleUser: { backgroundColor: theme.colors.textLink, borderBottomRightRadius: 4 },
    msgBubbleAgent: { backgroundColor: theme.colors.groupped.background, borderBottomLeftRadius: 4 },
    msgRole: { fontSize: 10, fontWeight: '600', color: theme.colors.textSecondary, marginBottom: 4 },
    msgText: { fontSize: 14, color: '#fff', lineHeight: 20 },
    msgTextAgent: { color: theme.colors.text, fontFamily: 'monospace' as any, fontSize: 13 },
    msgTime: { fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 4, alignSelf: 'flex-end' as any },

    inputArea: {
        flexDirection: 'row',
        padding: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        alignItems: 'flex-end',
    },
    inputField: {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 10,
        fontSize: 14,
        color: theme.colors.text,
        backgroundColor: theme.colors.groupped.background,
        maxHeight: 100,
    },
    sendButton: {
        marginLeft: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 20,
        backgroundColor: theme.colors.textLink,
    },
    sendButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
}));
