import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type ToolCall } from "@/sync/storageTypes";
import { SingleLineToolSummaryBlock as SingleLineToolSummaryBlock } from './SingleLinePressForDetail';

export type BashToolCall = Omit<ToolCall, 'name'> & { name: 'Bash' };

export function BashCompactView({ tool, sessionId, messageId }: { tool: BashToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <BashCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

// Compact view for display in session list (1-2 lines max)
export function BashCompactViewInner({ tool }: { tool: ToolCall }) {
  const command = tool.arguments?.command;
  const description = tool.arguments?.description;
  
  // Dynamic label based on state
  const label = tool.state === 'running' ? 'Running' : 'run';
  
  if (!command) {
    return (
      <View className="flex-row items-center py-0.5">
        <Ionicons name="terminal" size={14} color="#a1a1a1" />
        <Text className="text-sm text-neutral-400 font-bold px-1">{label}</Text>
        <Text className="text-sm text-gray-500 italic flex-1">Terminal command</Text>
      </View>
    );
  }

  // Use description if available, otherwise use truncated command
  const displayText = description || (command.length > 50 ? `${command.substring(0, 47)}...` : command);
  const prefix = description ? '' : '$ ';
  
  return (
    <View className="flex-row items-center py-0.5">
      <Ionicons name="terminal" size={14} color="#a1a1a1" />
      <Text className="text-sm text-neutral-400 font-bold px-1">{label}</Text>
      <Text className="text-sm text-neutral-800 flex-1" numberOfLines={1}>
        {prefix}{displayText}
      </Text>
    </View>
  );
};

// Detailed view for full-screen modal
export const BashDetailedView = ({ tool }: { tool: ToolCall }) => {
  const command = tool.arguments?.command;
  const description = tool.arguments?.description;
  const explanation = tool.arguments?.explanation;
  
  if (!command) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">Terminal Command</Text>
        <Text className="text-red-600 text-sm italic">No command specified</Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 p-4 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="flex-row justify-between items-center mb-5 pb-3 border-b border-gray-200">
        <Text className="text-lg font-semibold text-gray-900">🖥️ Terminal Command</Text>
        <View className="px-2 py-1 bg-gray-100 rounded-xl">
          <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
            {getStatusDisplay(tool.state)}
          </Text>
        </View>
      </View>

      {/* Command */}
      <View className="mb-4">
        <Text className="text-sm font-semibold text-gray-700 mb-2">Command</Text>
        <View className="bg-gray-800 rounded-lg p-3">
          <Text className="text-green-400 font-mono text-sm">$ {command}</Text>
        </View>
      </View>

      {/* Description if available */}
      {description && (
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-700 mb-2">Description</Text>
          <Text className="text-sm text-gray-600 leading-5">{description}</Text>
        </View>
      )}

      {/* Explanation if available */}
      {explanation && (
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-700 mb-2">Explanation</Text>
          <Text className="text-sm text-gray-700 leading-5">{explanation}</Text>
        </View>
      )}

      {/* Arguments details */}
      <View className="mb-4">
        <Text className="text-sm font-semibold text-gray-700 mb-2">Tool Arguments</Text>
        <View className="bg-gray-50 rounded-lg p-3 border border-gray-200">
          <Text className="font-mono text-sm text-gray-700">
            {JSON.stringify(tool.arguments, null, 2)}
          </Text>
        </View>
      </View>



      {/* Children tools if any */}
      {tool.children && tool.children.length > 0 && (
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-700 mb-2">Child Tool Calls ({tool.children.length})</Text>
          {tool.children.map((child: ToolCall, index: number) => (
            <View key={index} className="flex-row justify-between items-center py-2 px-3 bg-gray-50 rounded-md mb-1">
              <Text className="text-sm text-gray-700 font-medium">{child.name}</Text>
              <Text className={`text-sm font-medium ${getStatusColorClass(child.state)}`}>
                {child.state}
              </Text>
            </View>
          ))}
        </View>
      )}
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

const getStatusDescription = (state: string) => {
  switch (state) {
    case 'running': return 'Command is currently executing...';
    case 'completed': return 'Command executed successfully';
    case 'error': return 'Command failed to execute';
    default: return `Status: ${state}`;
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