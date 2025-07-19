import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type ToolCall } from '@/sync/storageTypes';
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from './SingleLinePressForDetail';

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
        case 'completed': return '#10b981';
        case 'in_progress': return '#f59e0b';
        case 'cancelled': return '#ef4444';
        default: return '#6b7280';
    }
};

const getTodoStatusBgColor = (status: string) => {
    switch (status) {
        case 'completed': return 'bg-green-500';
        case 'in_progress': return 'bg-amber-500';
        case 'cancelled': return 'bg-red-500';
        default: return 'bg-gray-500';
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
  const todoCount = todos.length;
  
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
        <Text className="text-lg font-semibold text-gray-900">TODO List</Text>
        <Text className="text-red-600 text-sm italic">Invalid arguments</Text>
      </View>
    );
  }

  const todos = args.todos;

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <View className="flex-row items-center">
            <Ionicons name="list" size={18} color="#374151" style={{ marginRight: 8 }} />
            <Text className="text-lg font-semibold text-gray-900">TODO ({todos.length} items)</Text>
          </View>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>
      </View>

      {/* Todo List */}
      <View className="px-4 pb-4">
        <View className="border border-gray-200 rounded-lg bg-gray-50 p-3">
          {todos.map((todo, index) => (
            <View key={todo.id} className={`flex-row items-center ${index < todos.length - 1 ? 'mb-3' : ''} bg-white p-3 rounded-lg border border-gray-100`}>
              <View className={`w-3 h-3 rounded-full mr-3 ${getTodoStatusBgColor(todo.status)}`} />
              <Text 
                className="text-sm text-gray-700 flex-1"
                style={{ 
                  textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none'
                }}
              >
                {todo.content}
              </Text>
              {todo.priority && (
                <View className={`px-2 py-1 rounded-md ml-2 ${
                  todo.priority === 'high' ? 'bg-red-100' : 
                  todo.priority === 'medium' ? 'bg-yellow-100' : 
                  'bg-gray-100'
                }`}>
                  <Text className={`text-xs font-medium ${
                    todo.priority === 'high' ? 'text-red-700' : 
                    todo.priority === 'medium' ? 'text-yellow-700' : 
                    'text-gray-700'
                  }`}>
                    {todo.priority}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case 'running': return '⏳ Running';
    case 'completed': return '✅ Completed';
    case 'error': return '❌ Error';
    default: return state;
  }
};

const getStatusColorClass = (state: string) => {
  switch (state) {
    case 'running': return 'text-amber-500';
    case 'completed': return 'text-green-600';
    case 'error': return 'text-red-600';
    default: return 'text-gray-500';
  }
};
