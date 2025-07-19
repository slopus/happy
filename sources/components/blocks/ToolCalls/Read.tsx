import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';

export type ReadToolCall = Omit<ToolCall, 'name'> & { name: 'Read' };

const ToolResultSchema = z.object({
  type: z.string(),
  file: z.object({
    filePath: z.string(),
    content: z.string(),
    numLines: z.number(),
    startLine: z.number(),
    totalLines: z.number(),
  }),
});

type ParsedToolResult = z.infer<typeof ToolResultSchema>;

export function ReadCompactView({ tool }: { tool: ReadToolCall }) {
  // Handle running state
  if (tool.state === 'running') {
    const filePath = tool.arguments?.file_path;
    const fileName = typeof filePath === 'string' ? filePath.split('/').pop() || filePath : 'file';
    
    return (
      <View className="pl-3 flex-row items-center py-0.5">
        <Ionicons name="eye" size={14} color="#a1a1a1" />
        <Text className="text-xs text-neutral-400 font-bold px-1 shimmer">Reading</Text>
        <Text
          className="text-xs flex-1 text-neutral-800"
          numberOfLines={1}
        >
          {fileName}
        </Text>
      </View>
    );
  }

  // Handle error state
  if (tool.state === 'error') {
    const filePath = tool.arguments?.file_path;
    const fileName = typeof filePath === 'string' ? filePath.split('/').pop() || filePath : 'file';
    
    return (
      <View className="pl-3 flex-row items-center py-0.5">
        <Ionicons name="warning" size={14} color="#ef4444" />
        <Text className="text-xs text-red-500 font-bold px-1">Read</Text>
        <Text
          className="text-xs flex-1 text-neutral-800"
          numberOfLines={1}
        >
          {fileName}
        </Text>
        <Text className="text-xs text-red-500">
          Failed to read file
        </Text>
      </View>
    );
  }

  // Handle completed state
  // Defensive: check for file_path
  const filePath = tool.arguments?.file_path;
  const fileName = typeof filePath === 'string' ? filePath.split('/').pop() || filePath : undefined;

  // Parse the tool.result using Zod schema
  let parsedResult: ParsedToolResult | null = null;
  let parseError: string | null = null;

  if (tool.result) {
    const parseResult = ToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
    } else {
      // parseError = `Parse error: ${parseResult.error.message}`;
    }
  }

  // Display parsed data or fallback to original
  const displayText = parsedResult 
    ? `${parsedResult.file.numLines} lines (L${parsedResult.file.startLine}-L${parsedResult.file.startLine + parsedResult.file.numLines - 1})` //out of ${parsedResult.file.totalLines})`
    : "" /*parseError || JSON.stringify(tool.result)*/;

  return (
    <View className="pl-3 flex-row items-center py-1">
      <Ionicons name="eye" size={14} color="#a1a1a1" />
      <Text className="text-xs text-neutral-400 font-bold px-1">Read</Text>
      <Text
        className="text-xs flex-1 text-neutral-800"
        numberOfLines={1}
      >
        {fileName || 'file'}
      </Text>
      <Text className="text-xs text-neutral-400 font-bold px-1">
        {displayText}
      </Text>
    </View>
  );
}
