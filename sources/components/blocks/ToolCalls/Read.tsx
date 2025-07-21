import React, { useMemo } from 'react';
import { View, ScrollView } from 'react-native';
import { MonoText as Text } from './design-tokens/MonoText';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { ToolCall } from '@/sync/typesMessage';
import { ShimmerToolName } from './design-tokens/ShimmerToolName';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { SharedDiffView } from './SharedDiffView';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';

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

  if (tool.input) {
    const inputParseResult = ToolInputSchema.safeParse(tool.input);
    if (inputParseResult.success) {
      parsedInput = inputParseResult.data;
    } else {
      inputParseError = `Invalid input: ${inputParseResult.error.message}`;
    }
  }

  // Handle running state
  if (tool.state === 'running') {
    const filePath = parsedInput?.file_path || (typeof tool.input?.file_path === 'string' ? tool.input.file_path : 'unknown');
    const fileName = filePath.split('/').pop() || filePath;
    
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="eye" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
        <ShimmerToolName>Reading</ShimmerToolName>
        <Text
          className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
          numberOfLines={1}
        >
          {fileName}
        </Text>
      </View>
    );
  }

  // Handle error state
  if (tool.state === 'error') {
    const filePath = parsedInput?.file_path || (typeof tool.input?.file_path === 'string' ? tool.input.file_path : 'unknown');
    const fileName = filePath.split('/').pop() || filePath;
    
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="warning" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color="#ef4444" />
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_SIZE} text-red-500 font-bold px-1`}>Read</Text>
        <Text
          className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
          numberOfLines={1}
        >
          {fileName}
        </Text>
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} text-red-500`}>
          {inputParseError || 'Failed to read file'}
        </Text>
      </View>
    );
  }

  // Handle completed state
  // Show input parse error if we couldn't understand the arguments
  if (inputParseError && !parsedInput) {
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="eye" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
        <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>Read</Text>
        <Text
          className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
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
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <Ionicons name="eye" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
      <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>Read</Text>
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {fileName}
      </Text>
      <Text className={TOOL_COMPACT_VIEW_STYLES.METADATA_CLASSES}>
        {displayText}
      </Text>
    </View>
  );
}

// Detailed view for full-screen modal
export const ReadDetailedView = ({ tool }: { tool: ReadToolCall }) => {
  const args = tool.input as ParsedToolInput;
  
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

  const fileContent = parsedResult?.file?.content || '';

  return (
    <View className="flex-1 bg-white">
      {/* Simple Header */}
      <View className="p-4 border-b border-gray-200">
        <Text className="text-lg font-semibold text-gray-900">👁 {args.file_path}</Text>
      </View>

      {/* Content */}
      <View className="flex-1">
        {/* Show content if available */}
        {fileContent && tool.state === 'completed' && (
          <SharedDiffView
            oldContent=""  // No old content for read operation
            newContent={fileContent}
            fileName={args.file_path || 'unknown'}
            showFileName={false}  // Already shown in header
          />
        )}

                 {/* Show loading state */}
         {tool.state === 'running' && (
           <View className="flex-1 justify-center items-center">
             <ShimmerToolName>{`Reading ${args.file_path?.split('/').pop() || 'file'}...`}</ShimmerToolName>
           </View>
         )}

        {/* Show error state */}
        {tool.state === 'error' && (
          <View className="flex-1 justify-center items-center p-4">
            <Ionicons name="warning" size={48} color="#ef4444" />
            <Text className="text-lg font-medium text-red-600 mt-4 text-center">
              Failed to read file
            </Text>
            <Text className="text-sm text-red-500 mt-2 text-center">
              {tool.result && typeof tool.result === 'object' && 'error' in tool.result 
                ? String(tool.result.error) 
                : 'Unknown error occurred'}
            </Text>
          </View>
        )}

        {/* Show empty file state */}
        {!fileContent && tool.state === 'completed' && (
          <View className="flex-1 justify-center items-center p-4">
            <Text className="text-lg text-gray-500">File is empty</Text>
          </View>
        )}
      </View>
    </View>
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
