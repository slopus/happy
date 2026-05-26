import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/AuthContext';
import { kvGet, kvList } from '@/sync/apiKv';
import { sync } from '@/sync/sync';
import { useAllSessions, useSessionMessages } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { Typography } from '@/constants/Typography';

type GroupAgent = 'codex' | 'claude';
type GroupRole = 'executor' | 'reviewer';

type GroupConfig = {
    id: string;
    name: string;
    cwd?: string;
    createdAt?: number;
    sessions: Array<{
        sessionId: string;
        role: GroupRole;
        agent: GroupAgent;
    }>;
};

type MergedMessage = Message & {
    sessionId: string;
    role: GroupRole;
    agent: GroupAgent;
};

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        padding: 16,
        gap: 10,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 15,
        textAlign: 'center',
        ...Typography.default(),
    },
    groupItem: {
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        padding: 14,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    groupTitle: {
        color: theme.colors.text,
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    groupSubtitle: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        marginTop: 4,
        ...Typography.default(),
    },
    messageList: {
        flex: 1,
    },
    messageContent: {
        padding: 12,
        gap: 8,
    },
    message: {
        borderRadius: 8,
        padding: 12,
        borderLeftWidth: 3,
    },
    messageHeader: {
        fontSize: 12,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    messageText: {
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
        padding: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    input: {
        flex: 1,
        minHeight: 42,
        maxHeight: 120,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 10,
        paddingVertical: 9,
        color: theme.colors.text,
        ...Typography.default(),
    },
    sendButton: {
        width: 42,
        height: 42,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
}));

export function GroupsView() {
    const auth = useAuth();
    const sessions = useAllSessions();
    const [groups, setGroups] = React.useState<GroupConfig[]>([]);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!auth.credentials) {
                setLoading(false);
                return;
            }
            try {
                const response = await kvList(auth.credentials, { prefix: 'group:', limit: 100 });
                if (cancelled) return;
                setGroups(response.items.map((item) => parseGroup(item.value)).filter(Boolean) as GroupConfig[]);
            } catch (error) {
                console.error('Failed to load groups', error);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [auth.credentials]);

    const mergedGroups = React.useMemo(() => mergeGroups(groups, sessions), [groups, sessions]);

    if (loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator />
            </View>
        );
    }

    if (mergedGroups.length === 0) {
        return (
            <View style={styles.center}>
                <Text style={styles.emptyText}>No groups yet</Text>
            </View>
        );
    }

    return <GroupList groups={mergedGroups} />;
}

function GroupList({ groups }: { groups: GroupConfig[] }) {
    const router = useRouter();
    return (
        <FlatList
            style={styles.container}
            contentContainerStyle={styles.content}
            data={groups}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
                <Pressable
                    style={styles.groupItem}
                    onPress={() => router.push(`/group/${encodeURIComponent(item.id)}`)}
                >
                    <Text style={styles.groupTitle}>{item.name}</Text>
                    <Text style={styles.groupSubtitle}>
                        {describeGroup(item)}
                    </Text>
                </Pressable>
            )}
        />
    );
}

export function GroupDetailView() {
    const auth = useAuth();
    const { groupId } = useLocalSearchParams<{ groupId: string }>();
    const sessions = useAllSessions();
    const [group, setGroup] = React.useState<GroupConfig | null>(null);
    const decodedGroupId = decodeURIComponent(groupId ?? '');

    React.useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!auth.credentials || !decodedGroupId) return;
            try {
                const item = await kvGet(auth.credentials, `group:${decodedGroupId}`);
                if (!cancelled) {
                    setGroup(item ? parseGroup(item.value) : null);
                }
            } catch (error) {
                console.error('Failed to load group', error);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [auth.credentials, decodedGroupId]);

    const fallbackGroup = React.useMemo(() => groupFromSessions(decodedGroupId, sessions), [decodedGroupId, sessions]);
    const activeGroup = group ?? fallbackGroup;

    if (!activeGroup) {
        return (
            <View style={styles.center}>
                <Text style={styles.emptyText}>Group not found</Text>
            </View>
        );
    }

    return <GroupThread group={activeGroup} />;
}

function GroupThread({ group }: { group: GroupConfig }) {
    const { theme } = useUnistyles();
    const [input, setInput] = React.useState('');
    const executor = group.sessions.find((item) => item.role === 'executor');
    const reviewer = group.sessions.find((item) => item.role === 'reviewer');
    const executorMessages = useGroupSessionMessages(executor?.sessionId);
    const reviewerMessages = useGroupSessionMessages(reviewer?.sessionId);

    React.useEffect(() => {
        if (executor?.sessionId) sync.onSessionVisible(executor.sessionId);
        if (reviewer?.sessionId) sync.onSessionVisible(reviewer.sessionId);
    }, [executor?.sessionId, reviewer?.sessionId]);

    const messages = React.useMemo(() => {
        return [
            ...executorMessages.map((message) => ({ ...message, sessionId: executor!.sessionId, role: 'executor' as const, agent: executor!.agent })),
            ...reviewerMessages.map((message) => ({ ...message, sessionId: reviewer!.sessionId, role: 'reviewer' as const, agent: reviewer!.agent })),
        ].sort((a, b) => a.createdAt - b.createdAt);
    }, [executor, executorMessages, reviewer, reviewerMessages]);

    const send = React.useCallback(() => {
        const text = input.trim();
        if (!text || !executor || !reviewer) return;
        const reviewerPrefix = /^@(claude|reviewer)\s+/i;
        const target = reviewerPrefix.test(text) ? reviewer : executor;
        const cleanText = text.replace(reviewerPrefix, '').trim();
        if (!cleanText) return;
        setInput('');
        sync.sendMessage(target.sessionId, cleanText, {
            source: 'chat',
        });
    }, [executor, input, reviewer]);

    return (
        <View style={styles.container}>
            <FlatList
                style={styles.messageList}
                contentContainerStyle={styles.messageContent}
                data={messages}
                keyExtractor={(item) => `${item.sessionId}:${item.id}`}
                renderItem={({ item }) => <GroupMessage message={item} />}
            />
            <View style={styles.composer}>
                <TextInput
                    style={styles.input}
                    value={input}
                    onChangeText={setInput}
                    placeholder="Message Codex, or @claude"
                    placeholderTextColor={theme.colors.textSecondary}
                    multiline
                />
                <Pressable style={styles.sendButton} onPress={send}>
                    <Ionicons name="send" size={19} color={theme.colors.button.primary.tint} />
                </Pressable>
            </View>
        </View>
    );
}

function GroupMessage({ message }: { message: MergedMessage }) {
    const { theme } = useUnistyles();
    const color = message.role === 'executor' ? '#10B981' : '#6366F1';
    const backgroundColor = theme.dark ? '#1F2937' : '#FFFFFF';
    return (
        <View style={[styles.message, { borderLeftColor: color, backgroundColor }]}>
            <Text style={[styles.messageHeader, { color }]}>
                {message.role === 'executor' ? 'Executor' : 'Reviewer'} / {message.agent}
            </Text>
            <Text style={styles.messageText}>{messageText(message)}</Text>
        </View>
    );
}

function useGroupSessionMessages(sessionId?: string): Message[] {
    const result = useSessionMessages(sessionId ?? '');
    return sessionId ? result.messages : [];
}

function mergeGroups(groups: GroupConfig[], sessions: Session[]): GroupConfig[] {
    const byId = new Map(groups.map((group) => [group.id, group]));
    for (const session of sessions) {
        const groupId = session.metadata?.groupId;
        if (!groupId || byId.has(groupId)) continue;
        const group = groupFromSessions(groupId, sessions);
        if (group) byId.set(groupId, group);
    }
    return Array.from(byId.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function groupFromSessions(groupId: string, sessions: Session[]): GroupConfig | null {
    const groupSessions = sessions.filter((session) => session.metadata?.groupId === groupId);
    if (groupSessions.length === 0) return null;
    return {
        id: groupId,
        name: groupSessions[0].metadata?.groupName ?? groupId,
        sessions: groupSessions.map((session) => ({
            sessionId: session.id,
            role: session.metadata?.agentRole === 'reviewer' ? 'reviewer' : 'executor',
            agent: session.metadata?.agentType === 'claude' ? 'claude' : 'codex',
        })),
    };
}

function parseGroup(value: string): GroupConfig | null {
    try {
        const parsed = JSON.parse(value);
        if (!parsed?.id || !parsed?.name || !Array.isArray(parsed.sessions)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function describeGroup(group: GroupConfig): string {
    const executor = group.sessions.find((item) => item.role === 'executor');
    const reviewer = group.sessions.find((item) => item.role === 'reviewer');
    return [executor?.agent ?? 'executor', reviewer?.agent ?? 'reviewer'].join(' + ');
}

function messageText(message: Message): string {
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        return message.kind === 'user-text' ? (message.displayText ?? message.text) : message.text;
    }
    if (message.kind === 'tool-call') {
        return message.tool.description ?? message.tool.name;
    }
    if (message.event.type === 'message') {
        return message.event.message;
    }
    return message.event.type;
}
