import * as React from 'react';
import { View, ScrollView, Text, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@/components/layout';
import { ZenHeader } from './components/ZenHeader';
import { TodoList } from './components/TodoList';
import { useUnistyles } from 'react-native-unistyles';
import { router } from 'expo-router';
import { storage, useRealtimeStatus } from '@/sync/storage';
import { toggleTodo as toggleTodoSync, reorderTodos as reorderTodosSync } from '@/-zen/model/ops';
import { useAuth } from '@/auth/AuthContext';
import { useShallow } from 'zustand/react/shallow';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { t } from '@/text';

export const ZenHome = () => {
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const auth = useAuth();
    const realtimeStatus = useRealtimeStatus();

    // Get todos from storage
    const todoState = storage(useShallow(state => state.todoState));
    const todosLoaded = storage(state => state.todosLoaded);

    // Process todos
    const { undoneTodos, doneTodos } = React.useMemo(() => {
        if (!todoState) {
            return { undoneTodos: [], doneTodos: [] };
        }

        const undone = todoState.undoneOrder
            .map(id => todoState.todos[id])
            .filter(Boolean)
            .map(todo => ({ id: todo.id, title: todo.title, done: todo.done }));

        const done = todoState.doneOrder
            .map(id => todoState.todos[id])
            .filter(Boolean)
            .map(todo => ({ id: todo.id, title: todo.title, done: todo.done }));

        return { undoneTodos: undone, doneTodos: done };
    }, [todoState]);

    // Handle toggle action
    const handleToggle = React.useCallback(async (id: string) => {
        if (auth?.credentials) {
            await toggleTodoSync(auth.credentials, id);
        }
    }, [auth?.credentials]);

    // Handle reorder action
    const handleReorder = React.useCallback(async (id: string, newIndex: number) => {
        if (auth?.credentials) {
            await reorderTodosSync(auth.credentials, id, newIndex, 'undone');
        }
    }, [auth?.credentials]);

    // Add keyboard shortcut for "T" to open new task (Web only)
    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            // Check if no input is focused (to avoid triggering when typing)
            const activeElement = document.activeElement as HTMLElement;
            const isInputFocused = activeElement?.tagName === 'INPUT' ||
                                   activeElement?.tagName === 'TEXTAREA' ||
                                   activeElement?.contentEditable === 'true';

            // Trigger on simple "T" key press when no modifier keys are pressed and no input is focused
            if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !isInputFocused) {
                e.preventDefault();
                router.push('/zen/new');
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    return (
        <>
            <ZenHeader />
            {realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="full" />
            )}
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ flexGrow: 1 }}
                showsVerticalScrollIndicator={false}
            >
                <View style={{ flexDirection: 'row', flex: 1, justifyContent: 'center' }}>
                    <View style={{
                        flex: 1,
                        maxWidth: layout.maxWidth,
                        alignSelf: 'stretch',
                        paddingTop: 20,
                    }}>
                        {undoneTodos.length === 0 ? (
                            <View style={{ padding: 20, alignItems: 'center' }}>
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 16 }}>
                                    {t('zen.home.noTasksYet')}
                                </Text>
                            </View>
                        ) : (
                            <TodoList todos={undoneTodos} onToggleTodo={handleToggle} onReorderTodo={handleReorder} />
                        )}
                    </View>
                </View>
            </ScrollView>
        </>
    );
};
