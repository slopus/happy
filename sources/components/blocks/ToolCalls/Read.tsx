import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SingleLineToolSummaryBlock } from './SingleLinePressForDetail';
import { type ToolCall } from '@/sync/storageTypes';

// Narrowed type for Read tool
export type ReadToolCall = Omit<ToolCall, 'name'> & { name: 'Read' };

// Compact view for Read tool call
export function ReadCompactView({ tool }: { tool: ReadToolCall }) {
  return <ReadCompactViewInner tool={tool} />;
}

export function ReadCompactViewInner({ tool }: { tool: ReadToolCall }) {
  // Defensive: check for file_path
  const filePath = tool.arguments?.file_path;
  const fileName = typeof filePath === 'string' ? filePath.split('/').pop() || filePath : undefined;

  return (
    <View className="flex-row items-center py-0.5">
      <Ionicons name="eye" size={14} color="#a1a1a1" />
      <Text className="text-xs text-neutral-400 font-bold px-1">Read</Text>
      <Text
        className="text-xs flex-1 text-neutral-800"
        numberOfLines={1}
      >
        {fileName || 'file'}
      </Text>
    </View>
  );
}
