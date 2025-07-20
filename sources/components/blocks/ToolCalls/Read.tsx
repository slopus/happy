import React from 'react';
import { View } from 'react-native';
import { MonoText as Text } from './MonoText';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { ShimmerText } from './ShimmerRunningToolName';

export type ReadToolCall = Omit<ToolCall, 'name'> & { name: 'Read' };

const ToolInputSchema = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

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

type ParsedToolInput = z.infer<typeof ToolInputSchema>;
type ParsedToolResult = z.infer<typeof ToolResultSchema>;

export function ReadCompactView({ tool }: { tool: ReadToolCall }) {
  // Parse and validate tool input
  let parsedInput: ParsedToolInput | null = null;
  let inputParseError: string | null = null;

  if (tool.arguments) {
    const inputParseResult = ToolInputSchema.safeParse(tool.arguments);
    if (inputParseResult.success) {
      parsedInput = inputParseResult.data;
    } else {
      inputParseError = `Invalid input: ${inputParseResult.error.message}`;
    }
  }

  // Handle running state
  if (tool.state === 'running') {
    const filePath = parsedInput?.file_path || (typeof tool.arguments?.file_path === 'string' ? tool.arguments.file_path : 'unknown');
    const fileName = filePath.split('/').pop() || filePath;
    
    return (
      <View className="flex-row items-center py-1 gap-1 pl-[2px]">
        <Ionicons name="eye" size={14} color="#a1a1a1" />
        <ShimmerText>Reading</ShimmerText>
        <Text
          className="text-smlol flex-1 text-neutral-800"
          numberOfLines={1}
        >
          {fileName}
        </Text>
      </View>
    );
  }

  // Handle error state
  if (tool.state === 'error') {
    const filePath = parsedInput?.file_path || (typeof tool.arguments?.file_path === 'string' ? tool.arguments.file_path : 'unknown');
    const fileName = filePath.split('/').pop() || filePath;
    
    return (
      <View className="pl-3 flex-row items-center py-0.5">
        <Ionicons name="warning" size={14} color="#ef4444" />
        <Text className="text-xslol text-red-400 font-bold px-1">Read</Text>
        <Text
          className="text-xslol flex-1 text-neutral-800"
          numberOfLines={1}
        >
          {fileName}
        </Text>
        <Text className="text-xslol text-red-400">
          {inputParseError || 'Failed to read file'}
        </Text>
      </View>
    );
  }

  // Handle completed state
  // Show input parse error if we couldn't understand the arguments
  if (inputParseError && !parsedInput) {
    return (
      <View className="flex-row items-center py-1">
        <Ionicons name="eye" size={14} color="#a1a1a1" />
        <Text className="text-xslol text-neutral-500 font-bold px-1">Read</Text>
        <Text
          className="text-xslol flex-1 text-neutral-800"
          numberOfLines={1}
        >
          Unable to parse arguments to show more information
        </Text>
      </View>
    );
  }

  const fileName = parsedInput?.file_path.split('/').pop() || parsedInput?.file_path || 'file';

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
    <View className="flex-row items-center py-1 flex-wrap">
      <Ionicons name="eye-outline" size={14} color="#a1a1a1" />
      <Text className="text-xslol text-neutral-500 font-bold px-1">Read</Text>
      <Text
        className="text-xslol flex-1 text-neutral-500"
        numberOfLines={1}
      >
        {fileName}
      </Text>
      <Text className="text-xslol text-neutral-500 font-bold px-1 basis-full flex">
        {displayText}
      </Text>
    </View>
  );
}
