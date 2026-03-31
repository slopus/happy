import React, { memo, useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput, Pressable } from 'react-native';
import { useStore } from '@/store/store';
import { ChatMessage, AgentStatus, fetchChat, sendChat } from '@/api/tasks';

interface Props {
    taskId: string;
}

function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export const TaskDetail = memo(function TaskDetail({ taskId }: Props) {
    const tasks = useStore(s => s.tasks);
    const projects = useStore(s => s.projects);
    const machines = useStore(s => s.machines);
    const setTaskStatus = useStore(s => s.setTaskStatus);
    const removeTask = useStore(s => s.removeTask);
    const task = useMemo(() => tasks.find(t => t.id === taskId), [tasks, taskId]);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const lastSeqRef = useRef(0);
    const scrollRef = useRef<ScrollView>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const loadTasks = useStore(s => s.loadTasks);

    const pollMessages = useCallback(async () => {
        if (!task?.happySessionId) return;
        try {
            const resp = await fetchChat(task.id, lastSeqRef.current);
            if (resp.messages.length > 0) {
                lastSeqRef.current = resp.messages[resp.messages.length - 1].seq;
                setMessages(prev => [...prev, ...resp.messages]);
                setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
            }
            setAgentStatus(resp.agentStatus);
            if (resp.agentStatus === 'done' && task.status === 'running') {
                loadTasks(task.projectId);
            }
        } catch {}
    }, [task?.id, task?.happySessionId, task?.status, task?.projectId]);

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
        if (!input.trim() || sending || !task) return;
        const text = input.trim();
        setInput('');
        setSending(true);
        try {
            await sendChat(task.id, text);
            await pollMessages();
        } catch (e: any) {
            console.warn('Send failed:', e.message);
        } finally {
            setSending(false);
        }
    }, [input, sending, task?.id, pollMessages]);

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
                        {task.happySessionId && agentStatus !== 'idle' && (
                            <View style={[styles.agentStatusBadge, {
                                backgroundColor: agentStatus === 'working' ? '#e3f2fd' : agentStatus === 'done' ? '#e8f5e9' : '#fff3e0'
                            }]}>
                                <Text style={[styles.agentStatusText, {
                                    color: agentStatus === 'working' ? '#1565c0' : agentStatus === 'done' ? '#2e7d32' : '#e65100'
                                }]}>
                                    {agentStatus === 'working' ? 'Agent working...' : agentStatus === 'done' ? 'Agent done' : 'Waiting'}
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
                                    <Text style={styles.workspaceText}>Machine: {machine?.displayName || hi.hostname || '?'} ({hi.ip})</Text>
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
                            <Text style={styles.actionButtonText}>Complete</Text>
                        </TouchableOpacity>
                    )}
                    {isActive && (
                        <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={() => setTaskStatus(task.id, 'failed')}>
                            <Text style={[styles.actionButtonText, styles.dangerText]}>Cancel</Text>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={() => removeTask(task.id)}>
                        <Text style={[styles.actionButtonText, styles.dangerText]}>Delete</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Chat area */}
            <ScrollView ref={scrollRef} style={styles.chatArea} contentContainerStyle={styles.chatContent}>
                {!task.happySessionId && (
                    <View style={styles.placeholder}>
                        <Text style={styles.placeholderText}>No session yet. Waiting for agent to start...</Text>
                    </View>
                )}
                {task.happySessionId && messages.length === 0 && (
                    <View style={styles.placeholder}>
                        <Text style={styles.placeholderText}>Waiting for messages...</Text>
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
                        placeholder="Send a message to the agent... (Cmd+Enter to send)"
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
                        <Text style={styles.sendButtonText}>{sending ? '...' : 'Send'}</Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
});

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
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
                <Text style={styles.msgRole}>{isUser ? 'You' : 'Agent'}</Text>
                <Text style={[styles.msgText, !isUser && styles.msgTextAgent]} selectable>{message.text}</Text>
                <Text style={styles.msgTime}>{new Date(message.createdAt).toLocaleTimeString()}</Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: { flex: 1, flexDirection: 'column' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    emptyText: { fontSize: 14, color: '#999' },

    header: {
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    headerInfo: { flex: 1, marginRight: 16 },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    statusBadgeText: { fontSize: 11, color: '#fff', fontWeight: '600', textTransform: 'capitalize' },
    agentStatusBadge: {
        paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
    },
    agentStatusText: {
        fontSize: 11, fontWeight: '600',
    },
    agentBadge: {
        fontSize: 12, color: '#1a73e8', fontWeight: '600',
        backgroundColor: '#e8f0fe', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
    },
    title: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 2 },
    description: { fontSize: 13, color: '#666', marginBottom: 2 },
    workspaceInfo: { marginTop: 6, padding: 8, backgroundColor: '#f5f5f5', borderRadius: 6 },
    workspaceText: { fontSize: 12, color: '#666', fontFamily: 'monospace' as any, lineHeight: 18 },
    errorBox: { marginTop: 6, padding: 8, backgroundColor: '#fce8e6', borderRadius: 6 },
    errorText: { fontSize: 12, color: '#d93025' },
    headerActions: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
    actionButton: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: '#e8f0fe' },
    actionButtonText: { fontSize: 12, color: '#1a73e8', fontWeight: '500' },
    dangerButton: { backgroundColor: '#fce8e6' },
    dangerText: { color: '#d93025' },

    chatArea: { flex: 1 },
    chatContent: { padding: 16, flexGrow: 1 },
    placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
    placeholderText: { fontSize: 14, color: '#bbb', textAlign: 'center' },

    systemMsgRow: { alignItems: 'center', marginVertical: 8 },
    systemMsgText: { fontSize: 12, color: '#999', fontStyle: 'italic', backgroundColor: '#f5f5f5', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
    msgRow: { marginBottom: 12, alignItems: 'flex-start' },
    msgRowUser: { alignItems: 'flex-end' },
    msgBubble: { maxWidth: '80%' as any, padding: 12, borderRadius: 12 },
    msgBubbleUser: { backgroundColor: '#1a73e8', borderBottomRightRadius: 4 },
    msgBubbleAgent: { backgroundColor: '#f0f0f0', borderBottomLeftRadius: 4 },
    msgRole: { fontSize: 10, fontWeight: '600', color: '#999', marginBottom: 4 },
    msgText: { fontSize: 14, color: '#fff', lineHeight: 20 },
    msgTextAgent: { color: '#333', fontFamily: 'monospace' as any, fontSize: 13 },
    msgTime: { fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 4, alignSelf: 'flex-end' as any },

    inputArea: {
        flexDirection: 'row',
        padding: 12,
        borderTopWidth: 1,
        borderTopColor: '#e0e0e0',
        backgroundColor: '#fff',
        alignItems: 'flex-end',
    },
    inputField: {
        flex: 1,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 10,
        fontSize: 14,
        color: '#333',
        backgroundColor: '#fafafa',
        maxHeight: 100,
    },
    sendButton: {
        marginLeft: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 20,
        backgroundColor: '#1a73e8',
    },
    sendButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
