import React, { useMemo } from 'react';
import { View, ScrollView } from 'react-native';
import { MonoText as Text } from './MonoText';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { SharedDiffView, calculateDiffStats } from './SharedDiffView';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';
import { Metadata } from '@/sync/storageTypes';
import { getRelativePath } from '@/hooks/useGetPath';

export type EditToolCall = Omit<ToolCall, 'name'> & { name: 'Edit' };

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

export function EditCompactView({ tool, sessionId, messageId, metadata }: { tool: ToolCall, sessionId: string, messageId: string, metadata: Metadata | null }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <EditCompactViewInner tool={tool} metadata={metadata} />
    </SingleLineToolSummaryBlock>
  );
}

// Compact view for display in session list (1-2 lines max)
export function EditCompactViewInner({ tool, metadata }: { tool: ToolCall, metadata: Metadata | null }) {
  const args = parseEditArguments(tool.input);
  
  if (!args) {
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <Ionicons name="pencil-outline" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
        <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>Edit</Text>
        <Text className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES} numberOfLines={1}>
          Invalid arguments
        </Text>
      </View>
    );
  }

  // Calculate diff stats for display
  const diffStats = useMemo(() => {
    if (!args.old_string || !args.new_string) {
      return { additions: 0, deletions: 0 };
    }
    
    return calculateDiffStats(args.old_string, args.new_string);
  }, [args.old_string, args.new_string]);

  // Get relative path or filename
  const displayPath = getRelativePath(metadata, args.file_path);
  
  return (
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <Ionicons name="pencil" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
      <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>Edit</Text>
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {displayPath}
      </Text>
      
      {/* Diff stats */}
      {(diffStats.additions > 0 || diffStats.deletions > 0) && (
        <View className="flex-row items-center ml-2">
          {diffStats.additions > 0 && (
            <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-emerald-600 font-mono`}>
              +{diffStats.additions}
            </Text>
          )}
          {diffStats.deletions > 0 && (
            <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-red-600 font-mono`}>
              -{diffStats.deletions}
            </Text>
          )}
        </View>
      )}
    </View>
  );
};

// Detailed view for full-screen modal  
export const EditDetailedView = ({ tool, metadata }: { tool: EditToolCall, metadata: Metadata | null }) => {
  const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll } = tool.input;

  if (!filePath) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">File Edit</Text>
        <Text className="text-red-600 text-sm italic">No file specified</Text>
      </View>
    );
  }

  // Get relative path for display
  console.log("!!!!!! metadata", metadata);
  const displayPath = getRelativePath(metadata || null, filePath);

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      {/* Header */}
      <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <View className="flex-row items-center">
            <Ionicons name="pencil" size={18} color="#374151" style={{ marginRight: 8 }} />
            <Text className="text-lg font-semibold text-gray-900">Edit Diff</Text>
          </View>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
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
      <View className="pb-4">
        <SharedDiffView
          oldContent={oldString || ''}
          newContent={newString || ''}
          fileName={displayPath}
          showFileName={true}
          maxHeight={400}
        />
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