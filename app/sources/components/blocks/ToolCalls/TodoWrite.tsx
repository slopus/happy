import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type ToolCall } from '@/sync/storageTypes';

export type TodoWriteToolCall = Omit<ToolCall, 'name'> & { name: 'TodoWrite' };

const getStateColor = (state: string) => {
    switch (state) {
        case 'running': return '#f59e0b';
        case 'completed': return '#10b981';
        case 'error': return '#ef4444';
        default: return '#6b7280';
    }
};

const getStateIcon = (state: string) => {
    switch (state) {
        case 'running': return 'time-outline';
        case 'completed': return 'checkmark-circle-outline';
        case 'error': return 'close-circle-outline';
        default: return 'ellipse-outline';
    }
};

const getTodoStatusColor = (status: string) => {
    switch (status) {
        case 'completed': return 'bg-green-500';
        case 'in_progress': return 'bg-amber-500';
        case 'cancelled': return 'bg-red-500';
        default: return 'bg-gray-500';
    }
};

export function TodoWriteCompactView({ tool }: { tool: TodoWriteToolCall }) {
  // Extract todo count from arguments if available
  // TODO parse the todos from the tool call
  const todos = tool.arguments?.todos as { id: string, content: string, status: 'in_progress' | 'pending' | 'completed' | 'cancelled' }[];
  const todoCount = Array.isArray(todos) ? todos.length : 0;

    return (
        <View className="border border-gray-300 rounded-lg bg-white p-3">
            <View className="flex-row items-center mb-2">
                <Ionicons 
                    name={getStateIcon(tool.state)} 
                    size={16} 
                    color={getStateColor(tool.state)} 
                    style={{ marginRight: 8 }} 
                />
                <Text className="text-sm text-gray-700 font-medium flex-1" numberOfLines={1}>
                    {(todos && todos.length > 0) ? `TODO (${todos.length} items)` : 'TODO'}
                </Text>
                <View 
                    className="w-2 h-2 rounded-full ml-2"
                    style={{ backgroundColor: getStateColor(tool.state) }}
                />
            </View>
            <View className="mb-2">
                {todos.map((todo) => (
                    <View key={todo.id} className="flex-row items-center mb-1 bg-gray-50 p-1.5 rounded">
                        <View className={`w-2 h-2 rounded-full mr-2 ${getTodoStatusColor(todo.status)}`} />
                        <Text 
                            className="text-xs text-gray-700 flex-1"
                            style={{ 
                                textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none'
                            }}
                        >
                            {todo.content}
                        </Text>
                    </View>
                ))}
            </View>
        </View>
    );
}
