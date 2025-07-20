import React, { useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { ShimmerText } from './ShimmerRunningToolName';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { SharedDiffView } from './SharedDiffView';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';

export type WriteToolCall = Omit<ToolCall, 'name'> & { name: 'Write' };

const ToolInputSchema = z.object({
  file_path: z.string(),
  content: z.string(),
});

const ToolResultSchema = z.object({
  success: z.boolean(),
  file_path: z.string(),
  bytes_written: z.number().optional(),
  message: z.string().optional(),
}).or(z.object({
  error: z.string(),
  file_path: z.string().optional(),
}));

type ParsedToolInput = z.infer<typeof ToolInputSchema>;
type ParsedToolResult = z.infer<typeof ToolResultSchema>;

export function WriteCompactView({ tool, sessionId, messageId }: { tool: WriteToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <WriteCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function WriteCompactViewInner({ tool }: { tool: WriteToolCall }) {
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
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="create-outline" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
        <ShimmerText>Creating</ShimmerText>
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
    const filePath = parsedInput?.file_path || (typeof tool.arguments?.file_path === 'string' ? tool.arguments.file_path : 'unknown');
    const fileName = filePath.split('/').pop() || filePath;
    
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="warning" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color="#ef4444" />
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_SIZE} text-red-500 font-bold px-1`}>Created</Text>
        <Text
          className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
          numberOfLines={1}
        >
          {fileName}
        </Text>
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} text-red-500`}>
          {inputParseError || 'Failed to write file'}
        </Text>
      </View>
    );
  }

  // Handle completed state
  // Show input parse error if we couldn't understand the arguments
  if (inputParseError && !parsedInput) {
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="create" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
        <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>Write</Text>
        <Text
          className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
          numberOfLines={1}
        >
          Unable to parse arguments
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

  // Get content info for display
  const contentLength = parsedInput?.content?.length || 0;
  const lineCount = parsedInput?.content?.split('\n').length || 0;
  
  return (
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <Ionicons name="create" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
      <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>Write</Text>
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {fileName}
      </Text>
      
      {/* Line count in diff style */}
      {lineCount > 0 && (
        <View className="flex-row items-center ml-2">
          <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-emerald-600 font-mono`}>
            +{lineCount}
          </Text>
        </View>
      )}
    </View>
  );
}



// Detailed view for full-screen modal
export const WriteDetailedView = ({ tool }: { tool: WriteToolCall }) => {
  const args = tool.arguments as ParsedToolInput;
  
  // Memoize content analysis
  const contentAnalysis = useMemo(() => {
    if (!args?.content) return null;
    
    const content = String(args.content);
    const lines = content.split('\n');
    const chars = content.length;
    const words = content.trim().split(/\s+/).length;
    
    return { lines: lines.length, chars, words, content };
  }, [args?.content]);

  if (!args?.file_path) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">File Write</Text>
        <Text className="text-red-600 text-sm italic">No file specified</Text>
      </View>
    );
  }

  // Extract filename for display
  const fileName = args.file_path.split('/').pop() || args.file_path;
  const isNewFile = !tool.result || (typeof tool.result === 'object' && tool.result !== null && 'error' in (tool.result as Record<string, any>));

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-lg font-semibold text-gray-900">📝 Write File</Text>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* File Info */}
        <View className="mb-4 bg-blue-50 rounded-lg p-3 border border-blue-200">
          <Text className="text-sm font-medium text-blue-800 mb-1">
            {isNewFile ? '📄 Creating new file' : '✏️ Overwriting existing file'}
          </Text>
          <Text className="text-sm font-mono text-blue-700">{args.file_path}</Text>
        </View>
      </View>

      {/* Content Preview with Diff */}
      <View className="bg-gray-50 border-y border-gray-200 flex-1">
        {/* Content Header */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-sm font-medium text-gray-700">
            {isNewFile ? 'File Content' : 'Content Diff'}
          </Text>
          {contentAnalysis && (
            <Text className="text-sm text-gray-500">
              {contentAnalysis.lines} lines • {contentAnalysis.chars} chars • {contentAnalysis.words} words
            </Text>
          )}
        </View>

        {/* Diff Viewer */}
        {contentAnalysis && (
          <View className="flex-1 bg-white">
            <SharedDiffView
              oldContent=""  // For new files, old content is empty
              newContent={contentAnalysis.content}
              fileName={args.file_path}
              showFileName={true}
              maxHeight={400}
            />
          </View>
        )}
      </View>
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case 'running': return '⏳ Writing';
    case 'completed': return '✅ Written';
    case 'error': return '❌ Error';
    default: return state;
  }
};

const getStatusDescription = (state: string) => {
  switch (state) {
    case 'running': return 'File is currently being written...';
    case 'completed': return 'File written successfully';
    case 'error': return 'Failed to write file';
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
