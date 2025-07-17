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


export function TodoWriteCompactView({ tool }: { tool: TodoWriteToolCall }) {
  // Extract todo count from arguments if available
  // TODO parse the todos from the tool call
  const todos = tool.arguments?.todos as { id: string, content: string, status: 'in_progress' | 'pending' | 'completed' | 'cancelled' }[];
  const todoCount = Array.isArray(todos) ? todos.length : 0;


    return (
        <View style={{
            borderWidth: 1,
            borderColor: '#d1d5db',
            borderRadius: 8,
            backgroundColor: 'white',
            padding: 12
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <Ionicons 
                    name={getStateIcon(tool.state)} 
                    size={16} 
                    color={getStateColor(tool.state)} 
                    style={{ marginRight: 8 }} 
                />
                <Text style={{
                    fontSize: 14,
                    color: '#374151',
                    fontWeight: '500',
                    flex: 1
                }} numberOfLines={1}>
                    {(todos && todos.length > 0) ? `TODO (${todos.length} items)` : 'TODO'}
                </Text>
                <View style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: getStateColor(tool.state),
                    marginLeft: 8
                }} />
            </View>
                <View style={{ marginBottom: 8 }}>
                        {todos.map((todo) => (
                            <View key={todo.id} style={{ 
                                flexDirection: 'row', 
                                alignItems: 'center', 
                                marginBottom: 4,
                                backgroundColor: '#f9fafb',
                                padding: 6,
                                borderRadius: 4
                            }}>
                                <View style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: 4,
                                    backgroundColor: todo.status === 'completed' ? '#10b981' : 
                                                    todo.status === 'in_progress' ? '#f59e0b' : 
                                                    todo.status === 'cancelled' ? '#ef4444' : '#6b7280',
                                    marginRight: 8
                                }} />
                                <Text style={{ 
                                    fontSize: 12, 
                                    color: '#374151',
                                    flex: 1,
                                    textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none'
                                }}>
                                    {todo.content}
                                </Text>
                            </View>
                        ))}
                        </View>
        </View>
    );
}
