import * as React from 'react';
import { View, Text, ScrollView, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { storage } from '@/sync/storage';
import { toggleTodo, updateTodoTitle, deleteTodo } from '@/-zen/model/ops';
import { useAuth } from '@/auth/AuthContext';
import { useShallow } from 'zustand/react/shallow';
import { clarifyPrompt } from '@/-zen/model/prompts';
import { storeTempData, type NewSessionData } from '@/utils/tempDataStore';
import { toCamelCase } from '@/utils/stringUtils';
import { removeTaskLinks, getSessionsForTask } from '@/-zen/model/taskSessionLink';

export const ZenView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams();
    const auth = useAuth();

    const todoId = params.id as string;

    // Get todo from storage
    const todo = storage(useShallow(state => {
        const todoState = state.todoState;
        if (!todoState) return null;
        const todoItem = todoState.todos[todoId];
        if (!todoItem) return null;
        return {
            id: todoItem.id,
            title: todoItem.title,
            done: todoItem.done
        };
    }));

    const [isEditing, setIsEditing] = React.useState(false);
    const [editedText, setEditedText] = React.useState(todo?.title || '');

    // Get linked sessions for this task
    const linkedSessions = React.useMemo(() => {
        return getSessionsForTask(todoId);
    }, [todoId]);

    // Update local state when todo changes
    React.useEffect(() => {
        if (todo) {
            setEditedText(todo.title);
        }
    }, [todo]);

    // Handle keyboard shortcut
    React.useEffect(() => {
        const handleKeyPress = (event: KeyboardEvent) => {
            // Navigate to new todo when any key is pressed (except when editing)
            if (!isEditing && event.key && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
                router.push('/zen/new');
            }
        };

        if (Platform.OS === 'web') {
            window.addEventListener('keypress', handleKeyPress);
            return () => window.removeEventListener('keypress', handleKeyPress);
        }
    }, [isEditing, router]);

    if (!todo) {
        // Todo was deleted or doesn't exist
        return null;
    }

    const handleSave = async () => {
        if (editedText.trim() && editedText !== todo.title && auth?.credentials) {
            await updateTodoTitle(auth.credentials, todoId, editedText.trim());
        }
        setIsEditing(false);
    };

    const handleToggleDone = async () => {
        if (auth?.credentials) {
            await toggleTodo(auth.credentials, todoId);
        }
    };

    const handleDelete = async () => {
        if (auth?.credentials) {
            // Remove any linked sessions
            removeTaskLinks(todoId);
            await deleteTodo(auth.credentials, todoId);
            router.back();
        }
    };

    const handleClarifyWithAI = () => {
        // Generate the task file name from the task title
        const taskFileName = toCamelCase(editedText) || 'untitledTask';
        const taskFile = `.dev/tasks/${taskFileName}.md`;

        // Format the prompt using the full clarifyPrompt template
        const promptText = clarifyPrompt
            .replace('{{taskFile}}', taskFile)
            .replace('{{task}}', editedText);

        // Create a display title for the prompt
        const promptDisplayTitle = `Clarify: ${editedText}`;

        // Store the prompt data in temporary store
        const sessionData: NewSessionData = {
            prompt: promptText,
            agentType: 'claude', // Default to Claude for clarification tasks
            taskId: todoId,
            taskTitle: editedText
        };
        const dataId = storeTempData(sessionData);

        // Navigate to new session screen with the data ID
        router.push({
            pathname: '/new',
            params: { dataId }
        });
    };

    const handleWorkOnTask = () => {
        // Create a simple prompt to work on the task
        const promptText = `Work on this task: ${editedText}`;

        // Store the prompt data in temporary store
        const sessionData: NewSessionData = {
            prompt: promptText,
            agentType: 'claude', // Default to Claude
            taskId: todoId,
            taskTitle: editedText
        };
        const dataId = storeTempData(sessionData);

        // Navigate to new session screen with the data ID
        router.push({
            pathname: '/new',
            params: { dataId }
        });
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.container}
        >
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ flexGrow: 1 }}
                keyboardShouldPersistTaps="handled"
            >
                <View style={[
                    styles.content,
                    { paddingBottom: insets.bottom + 20 }
                ]}>
                    {/* Checkbox and Main Content */}
                    <View style={styles.mainSection}>
                        <Pressable
                            onPress={handleToggleDone}
                            style={[
                                styles.checkbox,
                                {
                                    borderColor: todo.done ? theme.colors.success : theme.colors.textSecondary,
                                    backgroundColor: todo.done ? theme.colors.success : 'transparent',
                                }
                            ]}
                        >
                            {todo.done && (
                                <Ionicons name="checkmark" size={20} color="#FFFFFF" />
                            )}
                        </Pressable>

                        <View style={{ flex: 1 }}>
                            {isEditing ? (
                                <TextInput
                                    style={[
                                        styles.input,
                                        {
                                            color: theme.colors.text,
                                            borderBottomColor: theme.colors.divider,
                                        }
                                    ]}
                                    value={editedText}
                                    onChangeText={setEditedText}
                                    onBlur={handleSave}
                                    onSubmitEditing={handleSave}
                                    autoFocus
                                    multiline
                                    blurOnSubmit={true}
                                />
                            ) : (
                                <Pressable onPress={() => setIsEditing(true)}>
                                    <Text style={[
                                        styles.taskText,
                                        {
                                            color: todo.done ? theme.colors.textSecondary : theme.colors.text,
                                            textDecorationLine: todo.done ? 'line-through' : 'none',
                                            opacity: todo.done ? 0.6 : 1,
                                        }
                                    ]}>
                                        {editedText}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </View>

                    {/* Actions */}
                    <View style={styles.actions}>
                        <Pressable
                            onPress={handleWorkOnTask}
                            style={[styles.actionButton, { backgroundColor: theme.colors.button.primary.background }]}
                        >
                            <Ionicons name="hammer-outline" size={20} color="#FFFFFF" />
                            <Text style={styles.actionButtonText}>Work on task</Text>
                        </Pressable>

                        <Pressable
                            onPress={handleClarifyWithAI}
                            style={[styles.actionButton, { backgroundColor: theme.colors.surfaceHighest }]}
                        >
                            <Ionicons name="sparkles" size={20} color={theme.colors.text} />
                            <Text style={[styles.actionButtonText, { color: theme.colors.text }]}>Clarify</Text>
                        </Pressable>

                        <Pressable
                            onPress={handleDelete}
                            style={[styles.actionButton, { backgroundColor: theme.colors.textDestructive }]}
                        >
                            <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                            <Text style={styles.actionButtonText}>Delete</Text>
                        </Pressable>
                    </View>

                    {/* Linked Sessions */}
                    {linkedSessions.length > 0 && (
                        <View style={styles.linkedSessionsSection}>
                            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                                Linked Sessions
                            </Text>
                            {linkedSessions.map((link, index) => (
                                <Pressable
                                    key={link.sessionId}
                                    onPress={() => router.push(`/session/${link.sessionId}`)}
                                    style={[styles.linkedSession, { backgroundColor: theme.colors.surfaceHighest }]}
                                >
                                    <Ionicons name="chatbubble-outline" size={16} color={theme.colors.textSecondary} />
                                    <Text style={[styles.linkedSessionText, { color: theme.colors.text }]}>
                                        {link.promptDisplayTitle}
                                    </Text>
                                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            ))}
                        </View>
                    )}

                    {/* Helper Text */}
                    <View style={styles.helperSection}>
                        <Text style={[styles.helperText, { color: theme.colors.textSecondary }]}>
                            Tap the task text to edit
                        </Text>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        flex: 1,
        padding: 20,
    },
    mainSection: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 32,
    },
    checkbox: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
        marginTop: 4,
    },
    taskText: {
        fontSize: 20,
        lineHeight: 28,
        ...Typography.default(),
    },
    input: {
        fontSize: 20,
        lineHeight: 28,
        borderBottomWidth: 1,
        paddingVertical: 8,
        paddingHorizontal: 4,
        minHeight: 60,
        ...Typography.default(),
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        marginTop: 24,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        gap: 8,
    },
    actionButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '500',
        ...Typography.default(),
    },
    helperSection: {
        marginTop: 32,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    helperText: {
        fontSize: 14,
        ...Typography.default(),
    },
    linkedSessionsSection: {
        marginTop: 24,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '600',
        marginBottom: 12,
        ...Typography.default('semiBold'),
    },
    linkedSession: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        marginBottom: 8,
        gap: 8,
    },
    linkedSessionText: {
        flex: 1,
        fontSize: 14,
        ...Typography.default(),
    },
}));