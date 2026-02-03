import * as React from 'react';
import { TodoView } from "@/-zen/components/TodoView";
import { Button, ScrollView, TextInput, View } from "react-native";
import { randomUUID } from 'expo-crypto';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { layout } from '@/components/layout';
import { TodoList } from '@/-zen/components/TodoList';

export default function TodoDemoScreen() {

    const [model, setModel] = React.useState<{ id: string, value: string, done: boolean }[]>([]);
    const [newTodo, setNewTodo] = React.useState('');

    const shuffleTodos = () => {
        setModel(prev => {
            const shuffled = [...prev];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled;
        });
    };

    return (
        <View style={{ flex: 1 }}>
            <TextInput value={newTodo} onChangeText={setNewTodo} />
            <Button title="Add" onPress={() => setModel([{ id: randomUUID(), value: newTodo, done: false }, ...model])} />
            <Button title="Shuffle" onPress={shuffleTodos} />
            <ScrollView style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                    <View style={{ maxWidth: layout.maxWidth, flex: 1 }}>
                        <TodoList todos={model.map(m => ({ id: m.id, title: m.value, done: m.done }))} />
                    </View>
                </View>
            </ScrollView>
        </View>
    )
}