import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolViewProps } from "./_all";
import { knownTools } from '../../tools/knownTools';
import { ToolSectionView } from '../../tools/ToolSectionView';

export interface Todo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority?: 'high' | 'medium' | 'low';
    id: string;
}

export const TodoView = React.memo<ToolViewProps>(({ tool }) => {
    let todosList: Todo[] = [];
    
    // Try to get todos from input first
    let parsedArguments = knownTools.TodoWrite.input.safeParse(tool.input);
    if (parsedArguments.success && parsedArguments.data.todos) {
        todosList = parsedArguments.data.todos;
    }
    
    // If we have a properly structured result, use newTodos from there
    let parsed = knownTools.TodoWrite.result.safeParse(tool.result);
    if (parsed.success && parsed.data.newTodos) {
        todosList = parsed.data.newTodos;
    }
    
    // If we have todos to display, show them
    if (todosList.length > 0) {
        return (
            <ToolSectionView>
                <View style={styles.container}>
                    {todosList.map((todo) => {
                        const isCompleted = todo.status === 'completed';
                        const isInProgress = todo.status === 'in_progress';
                        const isPending = todo.status === 'pending';

                        let textStyle: any = styles.todoText;
                        let icon = '☐';

                        if (isCompleted) {
                            textStyle = [styles.todoText, styles.completedText];
                            icon = '☑';
                        } else if (isInProgress) {
                            textStyle = [styles.todoText, styles.inProgressText];
                            icon = '⬚';
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
    inProgressText: {
        color: '#007AFF',
    },
    pendingText: {
        color: '#666',
    },
});