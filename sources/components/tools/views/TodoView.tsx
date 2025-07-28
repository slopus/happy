import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolViewProps } from "./_all";
import { knownTools } from '../../tools/knownTools';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { useSetting } from '@/sync/storage';

export interface Todo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority: 'high' | 'medium' | 'low';
    id: string;
}

export interface TodoChanges {
    added: { content: string; id: string }[];
    started: { content: string; id: string }[];
    finished: { content: string; id: string }[];
}

export function calculateTodoChanges(oldTodos: Todo[], newTodos: Todo[]): TodoChanges {
    const added: { content: string; id: string }[] = [];
    const started: { content: string; id: string }[] = [];
    const finished: { content: string; id: string }[] = [];

    // Build maps for efficient lookup
    const oldTodosMap = new Map<string, Todo>();
    const newTodosMap = new Map<string, Todo>();

    for (const todo of oldTodos) {
        oldTodosMap.set(todo.id, todo);
    }
    for (const todo of newTodos) {
        newTodosMap.set(todo.id, todo);
    }

    // Process each new todo
    for (const [id, newTodo] of newTodosMap) {
        const oldTodo = oldTodosMap.get(id);

        if (!oldTodo) {

            // This is a new todo
            if (newTodo.status === 'pending') {
                added.push({ content: newTodo.content, id: newTodo.id });
            } else if (newTodo.status === 'in_progress') {
                started.push({ content: newTodo.content, id: newTodo.id });
            } else if (newTodo.status === 'completed') {
                finished.push({ content: newTodo.content, id: newTodo.id });
            } else {
                console.warn('Unknown todo status', newTodo.status);
            }
        } else {
            // This todo existed before, check if status changed
            if (oldTodo.status !== newTodo.status) {
                if (newTodo.status === 'in_progress') {
                    started.push({ content: newTodo.content, id: newTodo.id });
                } else if (newTodo.status === 'completed') {
                    finished.push({ content: newTodo.content, id: newTodo.id });
                }
            }
        }
    }

    return { added, started, finished };
}

export const TodoView = React.memo<ToolViewProps>(({ tool }) => {

    const expandTodos = useSetting('expandTodos');
    let oldTodosList: Todo[] = [];
    let newTodosList: Todo[] = [];
    let parsedArguments = knownTools.TodoWrite.input.safeParse(tool.input);
    let parsed = knownTools.TodoWrite.result.safeParse(tool.result);
    if (parsedArguments.success) {
        newTodosList = parsedArguments.data.todos || [];
    }
    if (parsed.success) {
        oldTodosList = parsed.data.oldTodos || [];
        newTodosList = parsed.data.newTodos || [];
    }
    const { added, started, finished } = calculateTodoChanges(oldTodosList, newTodosList);

    if ((expandTodos || (added.length === 0 && started.length === 0 && finished.length === 0)) && newTodosList.length > 0) {
        return (
            <ToolSectionView>
                <View style={styles.container}>
                    {newTodosList.map((todo) => {
                        const isCompleted = todo.status === 'completed';
                        const isInProgress = todo.status === 'in_progress';
                        const isPending = todo.status === 'pending';

                        let textStyle: any = styles.todoText;
                        let icon = '☐';

                        if (isCompleted) {
                            textStyle = [styles.todoText, styles.completedText];
                            icon = '☑';
                        } else if (isInProgress) {
                            textStyle = [styles.todoText, styles.startedText];
                        } else if (isPending) {
                            textStyle = [styles.todoText, styles.pendingText];
                        }

                        return (
                            <View key={todo.id} style={styles.todoItem}>
                                <Text style={textStyle}>
                                    {icon} {todo.content}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            </ToolSectionView>
        )
    }

    if (added.length > 0 || started.length > 0 || finished.length > 0) {
        return (
            <ToolSectionView>
                <View style={styles.container}>
                    {finished.map((todo) => (
                        <View key={todo.id} style={styles.todoItem}>
                            <Text style={[styles.todoText, styles.completedText]}>
                                ☑ {todo.content}
                            </Text>
                        </View>
                    ))}
                    {started.map((todo) => (
                        <View key={todo.id} style={styles.todoItem}>
                            <Text style={[styles.todoText, styles.startedText]}>
                                ☐ {todo.content}
                            </Text>
                        </View>
                    ))}
                    {added.map((todo) => (
                        <View key={todo.id} style={styles.todoItem}>
                            <Text style={[styles.todoText, styles.addedText]}>
                                ☐ {todo.content}
                            </Text>
                        </View>
                    ))}
                </View>
            </ToolSectionView>
        )
    }

    return null;
});

const styles = StyleSheet.create({
    container: {
        gap: 4,
    },
    todoItem: {
        paddingVertical: 2,
    },
    todoText: {
        fontSize: 14,
        color: '#000',
        flex: 1,
    },
    completedText: {
        color: '#34C759',
        textDecorationLine: 'line-through',
    },
    startedText: {
        color: '#007AFF',
    },
    addedText: {
        color: '#007AFF',
    },
    pendingText: {
        color: '#666',
    },
});