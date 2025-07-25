import React, { useMemo } from 'react';
import { View, ScrollView } from 'react-native';
import { MonoText as Text } from './design-tokens/MonoText';
import { ToolCall } from '@/sync/typesMessage';
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { DiffView } from '@/components/files/DiffView';
import { getDiffStats } from '@/components/files/calculateDiff';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';
import { ToolIcon } from './design-tokens/ToolIcon';
import { ToolName } from './design-tokens/ToolName';
import { Ionicons } from '@expo/vector-icons';

export type MultiEditToolCall = Omit<ToolCall, 'name'> & { name: 'MultiEdit' };

// Zod schema for MultiEdit tool arguments
const MultiEditArgumentsSchema = z.object({
  file_path: z.string(),
  edits: z.array(z.object({
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional()
  })).min(1)
});

type MultiEditArguments = z.infer<typeof MultiEditArgumentsSchema>;
type EditOperation = MultiEditArguments['edits'][0];



// Parse arguments safely
const parseMultiEditArguments = (args: any): MultiEditArguments | null => {
  try {
    return MultiEditArgumentsSchema.parse(args);
  } catch {
    return null;
  }
};

export function MultiEditCompactView({ tool, sessionId, messageId }: { tool: ToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <MultiEditCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

// Compact view for display in session list (1-2 lines max)
export function MultiEditCompactViewInner({ tool }: { tool: ToolCall }) {
  const args = parseMultiEditArguments(tool.input);

  if (!args) {
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <ToolIcon name="pencil-outline" />
        <ToolName>MultiEdit</ToolName>
        <Text className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES} numberOfLines={1}>
          Invalid arguments
        </Text>
      </View>
    );
  }

  // Calculate total diff stats across all edits
  const totalDiffStats = useMemo(() => {
    if (!args.edits || args.edits.length === 0) {
      return { additions: 0, deletions: 0 };
    }

    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const edit of args.edits) {
      if (edit.old_string && edit.new_string) {
        const stats = getDiffStats(edit.old_string, edit.new_string);
        totalAdditions += stats.additions;
        totalDeletions += stats.deletions;
      }
    }

    return { additions: totalAdditions, deletions: totalDeletions };
  }, [args.edits]);

  // Extract just the filename from the path
  const fileName = args.file_path.split('/').pop() || args.file_path;

  // Show different content based on completion status
  if (tool.state === 'completed') {
    return (
      <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
        <ToolIcon name="pencil" />
        <ToolName>MultiEdit</ToolName>
        <Text className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES} numberOfLines={1}>
          1 file edited
        </Text>

        {/* Total diff stats */}
        {(totalDiffStats.additions > 0 || totalDiffStats.deletions > 0) && (
          <View className="flex-row items-center ml-2">
            {totalDiffStats.additions > 0 && (
              <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-emerald-600 font-mono`}>
                +{totalDiffStats.additions}
              </Text>
            )}
            {totalDiffStats.deletions > 0 && (
              <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-red-600 font-mono ml-1`}>
                -{totalDiffStats.deletions}
              </Text>
            )}
          </View>
        )}
      </View>
    );
  }

  return (
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <ToolIcon name="pencil" />
      <ToolName>MultiEdit</ToolName>
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {fileName} ({args.edits.length} edits)
      </Text>

      {/* Diff stats while running */}
      {(totalDiffStats.additions > 0 || totalDiffStats.deletions > 0) && (
        <View className="flex-row items-center ml-2">
          {totalDiffStats.additions > 0 && (
            <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-emerald-600 font-mono`}>
              +{totalDiffStats.additions}
            </Text>
          )}
          {totalDiffStats.deletions > 0 && (
            <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} font-medium text-red-600 font-mono ml-1`}>
              -{totalDiffStats.deletions}
            </Text>
          )}
        </View>
      )}
    </View>
  );
};

// Detailed view for full-screen modal
export const MultiEditDetailedView = ({ tool }: { tool: MultiEditToolCall }) => {
  const { file_path: filePath, edits } = tool.input;

  // Memoize total diff stats calculation
  const totalStats = useMemo(() => {
    if (!edits || edits.length === 0) return { additions: 0, deletions: 0 };

    let totalAdditions = 0;
    let totalDeletions = 0;

    edits.forEach((edit: EditOperation) => {
      if (edit.old_string && edit.new_string) {
        const stats = getDiffStats(edit.old_string, edit.new_string);
        totalAdditions += stats.additions;
        totalDeletions += stats.deletions;
      }
    });

    return { additions: totalAdditions, deletions: totalDeletions };
  }, [edits]);

  if (!filePath) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">Multi File Edit</Text>
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
          <View className="flex-row items-center">
            <ToolIcon name="pencil" />
            <Text className="text-lg font-semibold text-gray-900">Multi Edit Diff</Text>
          </View>
          <View className="px-2 py-1 bg-gray-100 rounded-xl flex-row items-center">
            <Text className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* Edit Summary */}
        <View className="mb-3 bg-blue-50 rounded-lg p-3 border border-blue-200">
          <View className="flex-row items-center">
            <Ionicons
              name={getStatusIcon(tool.state)}
              size={16}
              color={getStatusIconColor(tool.state)}
              style={{ marginRight: 6 }}
            />
            <Text className="text-sm font-medium text-blue-800">
              {edits.length} edits applied to {fileName}
            </Text>
          </View>
          <Text className="text-sm text-blue-700 mt-1">
            Total changes: +{totalStats.additions} -{totalStats.deletions} lines
          </Text>
        </View>
      </View>

      {/* Individual Edit Sections */}
      <View className="px-4 pb-4 space-y-4">
        {edits.map((edit: EditOperation, editIndex: number) => (
          <View key={editIndex}>
            {/* Edit Header */}
            <View className="mb-2">
              <Text className="text-sm font-medium text-gray-700 mb-1">
                Edit #{editIndex + 1}
                {edit.replace_all && (
                  <Text className="text-amber-600"> (Replace All)</Text>
                )}
              </Text>
            </View>

            {/* Diff View for this edit */}
            <DiffView
              oldText={edit.old_string || ''}
              newText={edit.new_string || ''}
              oldTitle="Before"
              newTitle="After"
              showLineNumbers={true}
              wrapLines={false}
            />
          </View>
        ))}
      </View>
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case 'running': return 'Running';
    case 'completed': return 'Completed';
    case 'error': return 'Error';
    default: return state;
  }
};

const getStatusIcon = (state: string) => {
  switch (state) {
    case 'running': return 'pencil' as const;
    case 'completed': return 'pencil' as const;
    case 'error': return 'warning' as const;
    default: return 'pencil' as const;
  }
};

const getStatusIconColor = (state: string) => {
  switch (state) {
    case 'running': return '#f59e0b'; // amber-500
    case 'completed': return '#059669'; // green-600
    case 'error': return '#dc2626'; // red-600
    default: return '#6b7280'; // gray-500
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