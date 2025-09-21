import * as React from 'react';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@/components/layout';
import { ZenHeader } from './components/ZenHeader';
import { TodoList } from './components/TodoList';
import { useFocusEffect } from '@react-navigation/native';

export const ZenHome = () => {
    const insets = useSafeAreaInsets();
    const [todos, setTodos] = React.useState<{ id: string, value: string, done: boolean }[]>([
        { id: '1', value: 'Sample todo item', done: false },
        { id: '2', value: 'Another task to complete', done: true },
        { id: '3', value: 'Third item in the list', done: false }
    ]);

    // Check for new todos passed via params when screen focuses
    useFocusEffect(
        React.useCallback(() => {
            // This will be called when returning from the new todo modal
            return () => {};
        }, [])
    );

    // Add method to add new todos (will be called from navigation params)
    React.useEffect(() => {
        // Store the addTodo function globally so it can be accessed from the modal
        (global as any).addZenTodo = (text: string) => {
            const newTodo = {
                id: Date.now().toString(),
                value: text,
                done: false
            };
            setTodos(prev => [newTodo, ...prev]);
        };

        return () => {
            delete (global as any).addZenTodo;
        };
    }, []);

    // Toggle todo done status
    const toggleTodo = React.useCallback((id: string) => {
        setTodos(prev => prev.map(todo =>
            todo.id === id ? { ...todo, done: !todo.done } : todo
        ));
    }, []);

    // Update todo text
    React.useEffect(() => {
        (global as any).updateZenTodo = (id: string, newValue: string) => {
            setTodos(prev => prev.map(todo =>
                todo.id === id ? { ...todo, value: newValue } : todo
            ));
        };

        return () => {
            delete (global as any).updateZenTodo;
        };
    }, []);

    // Delete todo
    React.useEffect(() => {
        (global as any).deleteZenTodo = (id: string) => {
            setTodos(prev => prev.filter(todo => todo.id !== id));
        };

        return () => {
            delete (global as any).deleteZenTodo;
        };
    }, []);

    // Toggle todo from view modal
    React.useEffect(() => {
        (global as any).toggleZenTodo = (id: string) => {
            setTodos(prev => prev.map(todo =>
                todo.id === id ? { ...todo, done: !todo.done } : todo
            ));
        };

        return () => {
            delete (global as any).toggleZenTodo;
        };
    }, []);

    return (
        <>
            <ZenHeader />
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
                        <TodoList todos={todos} onToggleTodo={toggleTodo} />
                    </View>
                </View>
            </ScrollView>
        </>
    );
};