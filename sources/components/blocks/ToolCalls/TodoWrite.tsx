import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type ToolCall } from '@/sync/storageTypes';
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';

export type TodoWriteToolCall = Omit<ToolCall, 'name'> & { name: 'TodoWrite' };

// Zod schema for TodoWrite tool arguments based on sdk-tools.d.ts
const TodoWriteArgumentsSchema = z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    id: z.string(),
  }))
});

type TodoWriteArguments = z.infer<typeof TodoWriteArgumentsSchema>;

// Parse arguments safely
const parseTodoWriteArguments = (args: any): TodoWriteArguments | null => {
  try {
    return TodoWriteArgumentsSchema.parse(args);
  } catch {
    return null;
  }
};



export function TodoWriteCompactView({ tool, sessionId, messageId }: { tool: ToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <TodoWriteCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

// Compact view for display in session list (1-2 lines max)
export function TodoWriteCompactViewInner({ tool }: { tool: ToolCall }) {
  const args = parseTodoWriteArguments(tool.arguments);
  
  if (!args) {
    return (
      <View className="flex-row items-center py-1">
        <Ionicons name="list-outline" size={14} color="#a1a1a1" />
        <Text className="text-sm text-neutral-400 font-bold px-1">TODO</Text>
        <Text className="text-sm flex-1 text-neutral-800" numberOfLines={1}>
          Invalid arguments
        </Text>
      </View>
    );
  }

  const todos = args.todos;
  
  // Count todos by status
  const statusCounts = todos.reduce((acc, todo) => {
    acc[todo.status] = (acc[todo.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Determine what to show based on what changed
  const inProgressCount = statusCounts.in_progress || 0;
  const completedCount = statusCounts.completed || 0;
  const pendingCount = statusCounts.pending || 0;
  const cancelledCount = statusCounts.cancelled || 0;

  // Create summary with success, pending, failed counts
  const successCount = completedCount;
  const pendingTotal = pendingCount + inProgressCount; // pending + in_progress = still pending
  const failedCount = cancelledCount;
  
  return (
    <View className="flex-row items-center py-1">
      <Ionicons name="list" size={14} color="#a1a1a1" />
      <Text className="text-sm text-neutral-400 font-bold px-1">Update TODOs</Text>
      
      {/* Status indicators with icons */}
      <View className="flex-row items-center ml-2 font-medium">
        {successCount > 0 && (
          <View className="flex-row items-center mr-2">
            <Ionicons name="checkmark" size={14} color="#10b981" />
            <Text className="text-sm text-green-600 ml-[2px]">{successCount}</Text>
          </View>
        )}
        {pendingTotal > 0 && (
          <View className="flex-row items-center mr-2 font-bold">
            <Ionicons name="sync-outline" size={14} color="#f59e0b" />
            <Text className="text-sm text-amber-600 ml-[2px]">{pendingTotal}</Text>
          </View>
        )}
        {failedCount > 0 && (
          <View className="flex-row items-center mr-2">
            <Ionicons name="close" size={14} color="#ef4444" />
            <Text className="text-sm text-red-600 ml-[2px]">{failedCount}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// Detailed view for full-screen modal
export const TodoWriteDetailedView = ({ tool }: { tool: TodoWriteToolCall }) => {
  const args = parseTodoWriteArguments(tool.arguments);

  if (!args) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">Update TODO List</Text>
        <Text className="text-red-600 text-sm italic">Invalid arguments</Text>
      </View>
    );
  }

  const todos = args.todos;

  const getTodoStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return 'checkbox';
      case 'cancelled': return 'close-circle';
      default: return 'square-outline';
    }
  };

  const getTodoStatusIconColor = (status: string) => {
    switch (status) {
      case 'completed': return '#007AFF';
      case 'cancelled': return '#8E8E93';
      default: return '#C7C7CC';
    }
  };

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View className="pt-5 pl-3 pb-2">
        <View className="flex-row items-center">
          <Text className="text-2xl font-bold ">Update TODOs</Text>
        </View>
      </View>

      {/* Todo List */}
      <View className="px-3">
        {todos.map((todo, index) => (
          <View key={todo.id}>
            <View className="flex-row items-start py-3">
              <View className="mr-3 -mt-[2px]">
                <Ionicons 
                  name={getTodoStatusIcon(todo.status)} 
                  size={24} 
                  color={getTodoStatusIconColor(todo.status)} 
                />
              </View>
              
              <View className="flex-1">
                <Text 
                  className={`text-base leading-6 ${
                    todo.status === 'completed' 
                      ? 'text-gray-500' 
                      : todo.status === 'cancelled'
                      ? 'text-gray-400'
                      : 'text-gray-900'
                  }`}
                  style={{ 
                    textDecorationLine: todo.status === 'completed' || todo.status === 'cancelled' ? 'line-through' : 'none'
                  }}
                >
                  {todo.content}
                </Text>
                
                {todo.priority && (
                  <View className="mt-1 flex-row gap-2">
                    {todo.status === 'in_progress' && (
                      <View className="px-2 py-1 rounded-md self-start bg-blue-100">
                        <Text className="text-sm font-bold text-blue-700">IN PROGRESS</Text>
                      </View>
                    )}

                    <View className={`px-2 py-1 rounded-md self-start ${
                      todo.priority === 'high' ? 'bg-red-100' : 
                      todo.priority === 'medium' ? 'bg-orange-100' : 
                      'bg-gray-100'
                    }`}>
                      <Text className={`text-sm font-bold ${
                        todo.priority === 'high' ? 'text-red-700' : 
                        todo.priority === 'medium' ? 'text-orange-700' : 
                        'text-gray-600'
                      }`}>
                        {todo.priority.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                )}
              </View>
            </View>
            
            {/* Divider line from text baseline to right edge */}
            {index !== todos.length - 1 && (
              <View className="flex-row">
                <View className="w-9" /> {/* Space for icon + margin */}
                <View className="flex-1 border-b border-gray-200 -mr-3" />
              </View>
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
};