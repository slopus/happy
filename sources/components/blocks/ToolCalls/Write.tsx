import React, { useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { Diff, Hunk, IHunk, IChange, textLinesToHunk, insertHunk } from 'react-native-diff-view';
import { type ToolCall } from '@/sync/storageTypes';
import { ShimmerText } from './ShimmerRunningToolName';
import { SingleLineToolSummaryBlock } from './SingleLinePressForDetail';
import { DiffViewerWebView } from './DiffViewerWebView';

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
      <View className="flex-row items-center py-1 gap-1">
        <Ionicons name="create-outline" size={14} color="#a1a1a1" />
        <ShimmerText>Writing</ShimmerText>
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
      <View className="flex-row items-center py-0.5">
        <Ionicons name="warning" size={14} color="#ef4444" />
        <Text className="text-sm text-red-500 font-bold px-1">Write</Text>
        <Text
          className="text-sm flex-1 text-neutral-800"
          numberOfLines={1}
        >
          {fileName}
        </Text>
        <Text className="text-xs text-red-500">
          {inputParseError || 'Failed to write file'}
        </Text>
      </View>
    );
  }

  // Handle completed state
  // Show input parse error if we couldn't understand the arguments
  if (inputParseError && !parsedInput) {
    return (
      <View className="flex-row items-center py-1">
        <Ionicons name="create" size={14} color="#a1a1a1" />
        <Text className="text-sm text-neutral-400 font-bold px-1">Write</Text>
        <Text
          className="text-sm flex-1 text-neutral-800"
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
  
  const displayText = parsedResult && typeof parsedResult === 'object' && parsedResult !== null && 'bytes_written' in (parsedResult as Record<string, any>)
    ? `${(parsedResult as any).bytes_written} bytes written`
    : contentLength > 0 
    ? `${lineCount} lines (${contentLength} chars)`
    : "";

  return (
    <View className="flex-row items-center py-1">
      <Ionicons name="create" size={14} color="#a1a1a1" />
      <Text className="text-sm text-neutral-400 font-bold px-1">Write</Text>
      <Text
        className="text-sm flex-1 text-neutral-800"
        numberOfLines={1}
      >
        {fileName}
      </Text>
      <Text className="text-sm text-neutral-400 font-bold px-1">
        {displayText}
      </Text>
    </View>
  );
}

// Component for displaying new file content directly
const NewFileViewer: React.FC<{ content: string }> = ({ content }) => {
  const hunk = useMemo(() => {
    const lines = content.split('\n');
    
    // Use the library function to create hunk from text lines
    return textLinesToHunk(lines, 1, 1);
  }, [content]);

  if (!hunk) {
    return (
      <View className="flex-1 justify-center items-center">
        <Text className="text-gray-500">No content to display</Text>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <View className="bg-gray-100 px-4 py-2 border-b border-gray-200">
        <Text className="text-xs text-gray-600">New file content ({hunk.newLines} lines)</Text>
      </View>
      <ScrollView className="flex-1">
        <Diff diffType="add" hunks={[hunk]}>
          {(hunks: IHunk[]) => 
            hunks.map((h, index) => (
              <Hunk key={index} hunk={h} />
            ))
          }
        </Diff>
      </ScrollView>
    </View>
  );
};

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
            <Text className={`text-xs font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* File Info */}
        <View className="mb-4 bg-blue-50 rounded-lg p-3 border border-blue-200">
          <Text className="text-sm font-medium text-blue-800 mb-1">
            {isNewFile ? '📄 Creating new file' : '✏️ Overwriting existing file'}
          </Text>
          <Text className="text-xs font-mono text-blue-700">{args.file_path}</Text>
        </View>
      </View>

      {/* Content Preview with Diff */}
      <View className="bg-gray-50 border-y border-gray-200 flex-1">
        {/* Content Header */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-xs font-medium text-gray-700">
            {isNewFile ? 'File Content' : 'Content Diff'}
          </Text>
          {contentAnalysis && (
            <Text className="text-xs text-gray-500">
              {contentAnalysis.lines} lines • {contentAnalysis.chars} chars • {contentAnalysis.words} words
            </Text>
          )}
        </View>

        {/* Diff Viewer */}
        {contentAnalysis && (
          <View className="flex-1 bg-white">
            {isNewFile ? (
              // For new files, create the hunk structure directly
              <NewFileViewer content={contentAnalysis.content} />
            ) : (
              <DiffViewerWebView
                oldValue=""  // We don't have the old content for now
                newValue={contentAnalysis.content}
                splitView={false}
                leftTitle="Previous Content"
                rightTitle="Updated Content"
                height={400}
              />
            )}
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
