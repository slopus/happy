import React, { useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { type ToolCall } from "@/sync/storageTypes";
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from './SingleLinePressForDetail';

type EditToolCall = Omit<ToolCall, 'name'> & { name: 'Edit' };

// Zod schema for Edit tool arguments
const EditArgumentsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

type EditArguments = z.infer<typeof EditArgumentsSchema>;


// Parse arguments safely
const parseEditArguments = (args: any): EditArguments | null => {
  try {
    return EditArgumentsSchema.parse(args);
  } catch {
    return null;
  }
};

export function EditCompactView({ tool, sessionId, messageId }: { tool: ToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <EditCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

// Compact view for display in session list (1-2 lines max)
export function EditCompactViewInner({ tool }: { tool: ToolCall }) {
  const args = parseEditArguments(tool.arguments);
  
  if (!args) {
    return (
      <View className="flex-row items-center py-0.5">
        <Text className="text-xs text-gray-500 italic">✏️ File edit</Text>
      </View>
    );
  }

  // Extract just the filename from the path
  const fileName = args.file_path.split('/').pop() || args.file_path;
  
  return (
    <View className="flex-row items-center py-0.5">
      <Text className="text-xs mr-1">✏️</Text>
      <Text className="text-xs text-gray-700 flex-1" numberOfLines={1}>
        Edited {fileName}
      </Text>
      {tool.state === 'error' && <Text className="text-xs ml-1">❌</Text>}
      {tool.state === 'completed' && <Text className="text-xs ml-1">✅</Text>}
      {tool.state === 'running' && <Text className="text-xs ml-1">⏳</Text>}
    </View>
  );
};

// Calculate diff between two strings
const calculateDiff = (oldStr: string, newStr: string) => {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  
  const diffLines: Array<{ type: 'removed' | 'added'; content: string; lineNum: number }> = [];
  let oldIndex = 0;
  let newIndex = 0;
  
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    
    if (oldIndex >= oldLines.length) {
      // Only new lines remaining
      diffLines.push({ type: 'added', content: newLine, lineNum: newIndex + 1 });
      newIndex++;
    } else if (newIndex >= newLines.length) {
      // Only old lines remaining
      diffLines.push({ type: 'removed', content: oldLine, lineNum: oldIndex + 1 });
      oldIndex++;
    } else if (oldLine === newLine) {
      // Lines are the same - skip in diff view
      oldIndex++;
      newIndex++;
    } else {
      // Lines are different
      diffLines.push({ type: 'removed', content: oldLine, lineNum: oldIndex + 1 });
      diffLines.push({ type: 'added', content: newLine, lineNum: newIndex + 1 });
      oldIndex++;
      newIndex++;
    }
  }
  
  return diffLines;
};

// Detailed view for full-screen modal
export const EditDetailedView = ({ tool }: { tool: EditToolCall }) => {
  const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll } = tool.arguments;
  
  // Memoize diff calculation
  const diffLines = useMemo(() => {
    if (!oldString || !newString) return [];
    return calculateDiff(oldString, newString);
  }, [oldString, newString]);

  if (!filePath) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">File Edit</Text>
        <Text className="text-red-600 text-sm italic">No file specified</Text>
      </View>
    );
  }

  // Extract filename for display
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-lg font-semibold text-gray-900">📝 Edit Diff</Text>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-xs font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* Replace All Mode */}
        {replaceAll && (
          <View className="mb-3 bg-amber-50 rounded-lg p-3 border border-amber-200">
            <Text className="text-sm font-medium text-amber-800">
              🔄 Replace All - All occurrences replaced
            </Text>
          </View>
        )}
      </View>

      {/* Diff View */}
      <View className="bg-gray-50 border-y border-gray-200">
        {/* File Path Header */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-xs font-mono text-gray-700 flex-1" numberOfLines={1}>
            {filePath}
          </Text>
          <Text className="text-xs text-gray-500 ml-2">Diff</Text>
        </View>

        {/* Diff Lines */}
        <View>
          {diffLines.map((diffLine, index) => (
            <View key={index} className="flex-row">
              <View className={`w-8 items-center justify-center border-r ${
                diffLine.type === 'removed' 
                  ? 'bg-red-50 border-red-200'
                  : 'bg-green-50 border-green-200'
              }`}>
                <Text className={`text-xs font-mono ${
                  diffLine.type === 'removed' ? 'text-red-600' : 'text-green-600'
                }`}>
                  {diffLine.type === 'removed' ? '-' : '+'}
                </Text>
              </View>
              <View className={`flex-1 px-3 py-1 ${
                diffLine.type === 'removed'
                  ? 'bg-red-50'
                  : 'bg-green-50'
              }`}>
                <Text className={`text-xs font-mono ${
                  diffLine.type === 'removed' ? 'text-red-800' : 'text-green-800'
                }`} style={{ lineHeight: 16 }}>
                  {diffLine.content}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* Additional Info */}
      <View className="p-4">
        {/* Tool State */}
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-700 mb-2">Execution State</Text>
          <Text className={`text-sm ${getStatusColorClass(tool.state)}`}>
            {getStatusDescription(tool.state)}
          </Text>
        </View>

        {/* Raw Arguments */}
        <View>
          <Text className="text-sm font-semibold text-gray-700 mb-2">Raw Parameters</Text>
          <View className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <Text className="font-mono text-xs text-gray-700">
              {JSON.stringify(tool.arguments, null, 2)}
            </Text>
          </View>
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

const getStatusDescription = (state: string) => {
  switch (state) {
    case 'running': return 'Edit is currently being applied...';
    case 'completed': return 'Edit applied successfully';
    case 'error': return 'Edit failed to apply';
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