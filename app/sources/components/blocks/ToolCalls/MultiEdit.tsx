import React, { useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type ToolCall } from "@/sync/storageTypes";
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from './SingleLinePressForDetail';

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
  const args = parseMultiEditArguments(tool.arguments);
  
  if (!args) {
    return (
      <View className="flex-row items-center py-1">
        <Ionicons name="pencil-outline" size={14} color="#a1a1a1" />
        <Text className="text-sm text-neutral-400 font-bold px-1">MultiEdit</Text>
        <Text className="text-sm flex-1 text-neutral-800" numberOfLines={1}>
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
        const diffLines = calculateDiff(edit.old_string, edit.new_string);
        totalAdditions += diffLines.filter(line => line.type === 'added').length;
        totalDeletions += diffLines.filter(line => line.type === 'removed').length;
      }
    }
    
    return { additions: totalAdditions, deletions: totalDeletions };
  }, [args.edits]);

  // Extract just the filename from the path
  const fileName = args.file_path.split('/').pop() || args.file_path;
  
  // Show different content based on completion status
  if (tool.state === 'completed') {
    return (
      <View className="flex-row items-center py-1">
        <Ionicons name="pencil" size={14} color="#a1a1a1" />
        <Text className="text-sm text-neutral-400 font-bold px-1">MultiEdit</Text>
        <Text className="text-sm text-neutral-800" numberOfLines={1}>
          1 file edited
        </Text>
        
        {/* Total diff stats */}
        {(totalDiffStats.additions > 0 || totalDiffStats.deletions > 0) && (
          <View className="flex-row items-center ml-2">
            {totalDiffStats.additions > 0 && (
              <Text className="text-sm font-medium text-emerald-600 font-mono">
                +{totalDiffStats.additions}
              </Text>
            )}
            {totalDiffStats.deletions > 0 && (
              <Text className="text-sm font-medium text-red-600 font-mono ml-1">
                -{totalDiffStats.deletions}
              </Text>
            )}
          </View>
        )}
      </View>
    );
  }
  
  return (
    <View className="flex-row items-center py-1">
      <Ionicons name="pencil" size={14} color="#a1a1a1" />
      <Text className="text-sm text-neutral-400 font-bold px-1">MultiEdit</Text>
      <Text
        className="text-sm text-neutral-800"
        numberOfLines={1}
      >
        {fileName} ({args.edits.length} edits)
      </Text>
      
      {/* Diff stats while running */}
      {(totalDiffStats.additions > 0 || totalDiffStats.deletions > 0) && (
        <View className="flex-row items-center ml-2">
          {totalDiffStats.additions > 0 && (
            <Text className="text-sm font-medium text-emerald-600 font-mono">
              +{totalDiffStats.additions}
            </Text>
          )}
          {totalDiffStats.deletions > 0 && (
            <Text className="text-sm font-medium text-red-600 font-mono ml-1">
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
  const { file_path: filePath, edits } = tool.arguments;
  
  // Memoize total diff calculation
  const { totalDiffLines, totalStats } = useMemo(() => {
    if (!edits || edits.length === 0) return { totalDiffLines: [], totalStats: { additions: 0, deletions: 0 } };
    
    const allDiffLines: Array<{ type: 'removed' | 'added'; content: string; lineNum: number; editIndex: number }> = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    
    edits.forEach((edit: EditOperation, editIndex: number) => {
      if (edit.old_string && edit.new_string) {
        const diffLines = calculateDiff(edit.old_string, edit.new_string);
        diffLines.forEach(line => {
          allDiffLines.push({ ...line, editIndex });
        });
        totalAdditions += diffLines.filter(line => line.type === 'added').length;
        totalDeletions += diffLines.filter(line => line.type === 'removed').length;
      }
    });
    
    return { 
      totalDiffLines: allDiffLines, 
      totalStats: { additions: totalAdditions, deletions: totalDeletions } 
    };
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
            <Ionicons name="pencil" size={18} color="#374151" style={{ marginRight: 8 }} />
            <Text className="text-lg font-semibold text-gray-900">Multi Edit Diff</Text>
          </View>
          <View className="px-2 py-1 bg-gray-100 rounded-xl flex-row items-center">
            <Ionicons 
              name={getStatusIcon(tool.state)} 
              size={14} 
              color={getStatusIconColor(tool.state)} 
              style={{ marginRight: 4 }} 
            />
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

      {/* Diff View */}
      <View className="bg-gray-50 border-y border-gray-200">
        {/* File Path Header */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-sm font-mono text-gray-700 flex-1" numberOfLines={1}>
            {filePath}
          </Text>
          <Text className="text-sm text-gray-500 ml-2">Diff ({edits.length} edits)</Text>
        </View>

        {/* Individual Edit Sections */}
        {edits.map((edit: EditOperation, editIndex: number) => {
          const diffLines = calculateDiff(edit.old_string, edit.new_string);
          
          return (
            <View key={editIndex}>
              {/* Edit Header */}
              <View className="px-4 py-2 bg-gray-200 border-b border-gray-300">
                <Text className="text-sm font-medium text-gray-700">
                  Edit #{editIndex + 1}
                  {edit.replace_all && (
                    <Text className="text-amber-600"> (Replace All)</Text>
                  )}
                </Text>
              </View>
              
              {/* Diff Lines for this edit */}
              {diffLines.map((diffLine, lineIndex) => (
                <View key={`${editIndex}-${lineIndex}`} className="flex-row">
                  <View className={`w-8 items-center justify-center border-r ${
                    diffLine.type === 'removed' 
                      ? 'bg-red-50 border-red-200'
                      : 'bg-green-50 border-green-200'
                  }`}>
                    <Text className={`text-sm font-mono ${
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
                    <Text className={`text-sm font-mono ${
                      diffLine.type === 'removed' ? 'text-red-800' : 'text-green-800'
                    }`} style={{ lineHeight: 16 }}>
                      {diffLine.content}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          );
        })}
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