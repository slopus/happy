import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { ShimmerText } from './ShimmerRunningToolName';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { SharedDiffView } from './SharedDiffView';

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

export function ReadCompactView({ tool, sessionId, messageId }: { tool: ReadToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <ReadCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function ReadCompactViewInner({ tool }: { tool: ReadToolCall }) {
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
          className="text-sm flex-1 text-neutral-800"
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
        <Text className="text-xs text-red-500 font-bold px-1">Read</Text>
        <Text
          className="text-xs flex-1 text-neutral-800"
          numberOfLines={1}
        >
          {fileName}
        </Text>
        <Text className="text-xs text-red-500">
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
        <Text className="text-xs text-neutral-400 font-bold px-1">Read</Text>
        <Text
          className="text-xs flex-1 text-neutral-800"
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
    <View className="flex-row items-center py-1">
      <Ionicons name="eye" size={14} color="#a1a1a1" />
      <Text className="text-xs text-neutral-400 font-bold px-1">Read</Text>
      <Text
        className="text-xs flex-1 text-neutral-800"
        numberOfLines={1}
      >
        {fileName}
      </Text>
      <Text className="text-xs text-neutral-400 font-bold px-1">
        {displayText}
      </Text>
    </View>
  );
}

// Detailed view for full-screen modal
export const ReadDetailedView = ({ tool }: { tool: ReadToolCall }) => {
  const args = tool.arguments as ParsedToolInput;
  
  // Parse the tool result
  let parsedResult: ParsedToolResult | null = null;
  if (tool.result) {
    const parseResult = ToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
    }
  }

  if (!args?.file_path) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">File Read</Text>
        <Text className="text-red-600 text-sm italic">No file specified</Text>
      </View>
    );
  }

  // Extract filename for display
  const fileName = args.file_path.split('/').pop() || args.file_path;
  const fileContent = parsedResult?.file?.content || '';
  const startLine = parsedResult?.file?.startLine || 1;
  const numLines = parsedResult?.file?.numLines || 0;
  const totalLines = parsedResult?.file?.totalLines || 0;

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-lg font-semibold text-gray-900">👁 Read File</Text>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* File Info */}
        <View className="mb-4 bg-blue-50 rounded-lg p-3 border border-blue-200">
          <Text className="text-sm font-medium text-blue-800 mb-1">
            📖 File contents
          </Text>
          <Text className="text-sm font-mono text-blue-700 mb-2">{args.file_path}</Text>
          {parsedResult && (
            <View className="flex-row flex-wrap gap-4">
              <Text className="text-xs text-blue-600">
                Lines {startLine}-{startLine + numLines - 1}
              </Text>
              <Text className="text-xs text-blue-600">
                {numLines} of {totalLines} total lines
              </Text>
              <Text className="text-xs text-blue-600">
                {fileContent.length} characters
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Content Display */}
      <View className="bg-gray-50 border-y border-gray-200 flex-1">
        {/* Content Header */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-sm font-medium text-gray-700">
            File Contents
          </Text>
          {parsedResult && (
            <Text className="text-sm text-gray-500">
              {numLines} lines • {fileContent.length} chars
            </Text>
          )}
        </View>

        {/* File Content Display */}
        {fileContent && (
          <View className="flex-1 bg-white">
            <SharedDiffView
              oldContent=""  // No old content for read operation
              newContent={fileContent}
              fileName={args.file_path}
              showFileName={false}  // Already shown in header
              maxHeight={600}
            />
          </View>
        )}

        {/* Show message if no content */}
        {!fileContent && tool.state === 'completed' && (
          <View className="p-4 bg-white">
            <Text className="text-gray-500 italic text-center">
              File appears to be empty or content could not be loaded
            </Text>
          </View>
        )}

        {/* Show error message if failed */}
        {tool.state === 'error' && (
          <View className="p-4 bg-red-50">
            <Text className="text-red-600 text-center">
              Failed to read file: {tool.result && typeof tool.result === 'object' && 'error' in tool.result 
                ? String(tool.result.error) 
                : 'Unknown error occurred'}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case 'running': return '⏳ Reading';
    case 'completed': return '✅ Read';
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
