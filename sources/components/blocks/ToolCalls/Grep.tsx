import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { MonoText as Text } from './design-tokens/MonoText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { z } from 'zod';
import { ToolCall } from '@/sync/typesMessage';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';
import { ToolIcon } from './design-tokens/ToolIcon';
import { ToolName } from './design-tokens/ToolName';
import { ShimmerToolName } from './design-tokens/ShimmerToolName';

/*
Example Grep input args:
{
  "input": {
    "pattern": "export const NestedTimers|useStore.*timers|const timers",
    "path": "/Users/user/src/plgrc/web/peoplesgrocers/static/src/routes/[...lang]/projects/nested-timers/app.tsx",
    "output_mode": "content",
    "-n": true
  }
}

Example Grep result:
    {
      "mode": "content",
      "numFiles": 0,
      "filenames": [],
      "content": "",
      "numLines": 0
    }
Note: The ToolCall type does not include enough information yet. 
Need to pass the results through into this component.
*/

export type GrepToolCall = Omit<ToolCall, 'name'> & { name: 'Grep' };

const GrepToolResultSchema = z.object({
  mode: z.string(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  content: z.string(),
  numLines: z.number(),
});

type ParsedGrepToolResult = z.infer<typeof GrepToolResultSchema>;

export function GrepCompactView({ tool, sessionId, messageId }: { tool: GrepToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <GrepCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function GrepCompactViewInner({ tool }: { tool: GrepToolCall }) {
  // Parse input arguments
  const query = tool.input?.query || tool.input?.pattern;
  const filePath = tool.input?.file_path || tool.input?.files || tool.input?.path;
  const directory = tool.input?.directory || tool.input?.dir;
  
  // Determine if this is a single file search or multi-file search
  const isSingleFileSearch = typeof filePath === 'string' && !directory;
  
  // Display search target (file, directory, or pattern)
  const searchTarget = filePath || directory || 'files';
  const displayTarget = typeof searchTarget === 'string' 
    ? searchTarget.split('/').pop() || searchTarget 
    : Array.isArray(searchTarget) 
      ? `${searchTarget.length} files` 
      : 'files';

  // Parse the tool.result using Zod schema
  let parsedResult: ParsedGrepToolResult | null = null;
  let parseError: string | null = null;

  if (tool.result) {
    const parseResult = GrepToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
    } else {
      // parseError = `Parse error: ${parseResult.error.message}`;
    }
  }

  // Display appropriate result text based on search type and parsed data
  let resultText = "No Results";
  
  if (parsedResult) {
    if (isSingleFileSearch) {
      // Single file search - show matching lines
      if (parsedResult.numLines > 0) {
        resultText = `Found ${parsedResult.numLines} line${parsedResult.numLines === 1 ? '' : 's'}`;
      } else {
        resultText = "No matches";
      }
    } else {
      // Multi-file search - show matched files
      if (parsedResult.numFiles > 0) {
        resultText = `Matched ${parsedResult.numFiles} file${parsedResult.numFiles === 1 ? '' : 's'}`;
      } else {
        resultText = "No files matched";
      }
    }
  }

  return (
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <ToolIcon name="search" />
      {tool.state === 'running' ? <ShimmerToolName>Searching</ShimmerToolName> : <ToolName>Grep</ToolName>}
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        "{query || 'pattern'}" in {displayTarget}
      </Text>
      <Text className={TOOL_COMPACT_VIEW_STYLES.METADATA_CLASSES}>
        {resultText}
      </Text>
    </View>
  );
}

// Detailed view for full-screen modal
export const GrepDetailedView = ({ tool }: { tool: GrepToolCall }) => {
  // Parse input arguments
  const pattern = tool.input?.pattern || tool.input?.query;
  const searchPath = tool.input?.path;
  const glob = tool.input?.glob;
  const outputMode = tool.input?.output_mode || 'files_with_matches';
  const caseInsensitive = tool.input?.['-i'];
  const showLineNumbers = tool.input?.['-n'];
  const contextBefore = tool.input?.['-B'];
  const contextAfter = tool.input?.['-A'];
  const contextAround = tool.input?.['-C'];
  const fileType = tool.input?.type;
  const headLimit = tool.input?.head_limit;
  const multiline = tool.input?.multiline;

  // Parse the tool result
  let parsedResult: ParsedGrepToolResult | null = null;
  if (tool.result) {
    const parseResult = GrepToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
    }
  }

  // Prepare display information
  const searchTarget = searchPath || 'current directory';
  const displayPath = searchPath?.split('/').pop() || searchPath || 'current directory';

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-lg font-semibold text-gray-900">🔍 Grep Search</Text>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* Search Parameters */}
        <View className="mb-4 bg-blue-50 rounded-lg p-3 border border-blue-200">
          <Text className="text-sm font-medium text-blue-800 mb-2">Search Parameters</Text>
          
          <View className="space-y-1">
            <View className="flex-row">
              <Text className="text-sm font-medium text-blue-700 w-16">Pattern:</Text>
              <Text className="text-sm font-mono text-blue-800 flex-1">"{pattern || 'N/A'}"</Text>
            </View>
            
            <View className="flex-row">
              <Text className="text-sm font-medium text-blue-700 w-16">Target:</Text>
              <Text className="text-sm text-blue-800 flex-1">{searchTarget}</Text>
            </View>
            
            <View className="flex-row">
              <Text className="text-sm font-medium text-blue-700 w-16">Mode:</Text>
              <Text className="text-sm text-blue-800 flex-1">{outputMode}</Text>
            </View>
            
            {glob && (
              <View className="flex-row">
                <Text className="text-sm font-medium text-blue-700 w-16">Glob:</Text>
                <Text className="text-sm font-mono text-blue-800 flex-1">{glob}</Text>
              </View>
            )}
            
            {fileType && (
              <View className="flex-row">
                <Text className="text-sm font-medium text-blue-700 w-16">Type:</Text>
                <Text className="text-sm text-blue-800 flex-1">{fileType}</Text>
              </View>
            )}
          </View>

          {/* Search Options */}
          {(caseInsensitive || showLineNumbers || contextBefore || contextAfter || contextAround || headLimit || multiline) && (
            <View className="mt-3 pt-2 border-t border-blue-200">
              <Text className="text-sm font-medium text-blue-700 mb-1">Options:</Text>
              <View className="flex-row flex-wrap gap-1">
                {caseInsensitive && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">Case insensitive</Text>
                  </View>
                )}
                {showLineNumbers && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">Line numbers</Text>
                  </View>
                )}
                {contextBefore && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">Before: {contextBefore}</Text>
                  </View>
                )}
                {contextAfter && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">After: {contextAfter}</Text>
                  </View>
                )}
                {contextAround && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">Context: {contextAround}</Text>
                  </View>
                )}
                {headLimit && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">Limit: {headLimit}</Text>
                  </View>
                )}
                {multiline && (
                  <View className="px-2 py-1 bg-blue-200 rounded">
                    <Text className="text-xs font-medium text-blue-800">Multiline</Text>
                  </View>
                )}
              </View>
            </View>
          )}
        </View>
      </View>

      {/* Results Section */}
      <View className="bg-gray-50 border-y border-gray-200 flex-1">
        {/* Results Header */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-sm font-medium text-gray-700">Search Results</Text>
          {parsedResult && (
            <Text className="text-sm text-gray-500">
              {outputMode === 'content' 
                ? `${parsedResult.numLines} lines in ${parsedResult.numFiles} files`
                : `${parsedResult.numFiles} files matched`
              }
            </Text>
          )}
        </View>

        {/* Results Content */}
        <View className="flex-1 bg-white p-4">
          {!parsedResult ? (
            <Text className="text-gray-500 italic">No results available</Text>
          ) : parsedResult.numFiles === 0 && parsedResult.numLines === 0 ? (
            <View className="items-center py-8">
              <Ionicons name="search" size={48} color="#9ca3af" />
              <Text className="text-gray-500 text-lg font-medium mt-2">No matches found</Text>
              <Text className="text-gray-400 text-sm text-center mt-1">
                Try adjusting your search pattern or expanding the search scope
              </Text>
            </View>
          ) : outputMode === 'content' && parsedResult.content ? (
            // Show content matches
            <View className="bg-gray-50 rounded-lg p-3">
              <ScrollView 
                className="max-h-96" 
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
              >
                <Text className="text-sm font-mono text-gray-800" selectable={true}>
                  {parsedResult.content}
                </Text>
              </ScrollView>
            </View>
          ) : parsedResult.filenames.length > 0 ? (
            // Show file list
            <View className="space-y-2">
              {parsedResult.filenames.map((filename, index) => (
                <View key={index} className="flex-row items-center py-2 px-3 bg-gray-50 rounded-lg">
                  <Ionicons name="document-outline" size={16} color="#6b7280" />
                  <Text className="text-sm font-mono text-gray-800 ml-2 flex-1" selectable={true}>
                    {filename}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text className="text-gray-500 italic">
              Results available but cannot be displayed in current format
            </Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case 'running': return '⏳ Searching';
    case 'completed': return '✅ Complete';
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
