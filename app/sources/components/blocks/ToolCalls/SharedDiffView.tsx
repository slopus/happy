import React, { useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';

interface DiffLine {
  type: 'removed' | 'added' | 'context';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

interface SharedDiffViewProps {
  oldContent: string;
  newContent: string;
  fileName?: string;
  showFileName?: boolean;
  maxHeight?: number;
}

// Calculate diff between two strings with better context handling
const calculateDiff = (oldStr: string, newStr: string): DiffLine[] => {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  
  const diffLines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    
    if (oldIndex >= oldLines.length) {
      // Only new lines remaining
      diffLines.push({ 
        type: 'added', 
        content: newLine, 
        newLineNum: newIndex + 1 
      });
      newIndex++;
    } else if (newIndex >= newLines.length) {
      // Only old lines remaining
      diffLines.push({ 
        type: 'removed', 
        content: oldLine, 
        oldLineNum: oldIndex + 1 
      });
      oldIndex++;
    } else if (oldLine === newLine) {
      // Lines are the same - show as context (optional, can be skipped for brevity)
      diffLines.push({ 
        type: 'context', 
        content: oldLine, 
        oldLineNum: oldIndex + 1, 
        newLineNum: newIndex + 1 
      });
      oldIndex++;
      newIndex++;
    } else {
      // Lines are different
      diffLines.push({ 
        type: 'removed', 
        content: oldLine, 
        oldLineNum: oldIndex + 1 
      });
      diffLines.push({ 
        type: 'added', 
        content: newLine, 
        newLineNum: newIndex + 1 
      });
      oldIndex++;
      newIndex++;
    }
  }
  
  return diffLines;
};

// Filter diff lines to show only changes with minimal context
const filterDiffLines = (diffLines: DiffLine[], contextLines: number = 3): DiffLine[] => {
  const filtered: DiffLine[] = [];
  const changeIndices: number[] = [];
  
  // Find all lines that are changes (not context)
  diffLines.forEach((line, index) => {
    if (line.type !== 'context') {
      changeIndices.push(index);
    }
  });
  
  if (changeIndices.length === 0) {
    return diffLines; // No changes, return all
  }
  
  // For each change, include context lines around it
  const includedIndices = new Set<number>();
  
  changeIndices.forEach(changeIndex => {
    // Include the change line and context around it
    for (let i = Math.max(0, changeIndex - contextLines); 
         i <= Math.min(diffLines.length - 1, changeIndex + contextLines); 
         i++) {
      includedIndices.add(i);
    }
  });
  
  // Convert set to sorted array and build filtered result
  const sortedIndices = Array.from(includedIndices).sort((a, b) => a - b);
  
  sortedIndices.forEach((index, arrayIndex) => {
    // Add ellipsis if there's a gap
    if (arrayIndex > 0 && index > sortedIndices[arrayIndex - 1] + 1) {
      filtered.push({
        type: 'context',
        content: '...',
        oldLineNum: undefined,
        newLineNum: undefined
      });
    }
    filtered.push(diffLines[index]);
  });
  
  return filtered;
};

export const SharedDiffView: React.FC<SharedDiffViewProps> = ({
  oldContent,
  newContent,
  fileName,
  showFileName = true,
  maxHeight
}) => {
  // Memoize diff calculation
  const { diffLines, stats } = useMemo(() => {
    const allDiffLines = calculateDiff(oldContent, newContent);
    const filteredLines = filterDiffLines(allDiffLines, 2);
    
    const additions = allDiffLines.filter(line => line.type === 'added').length;
    const deletions = allDiffLines.filter(line => line.type === 'removed').length;
    
    return {
      diffLines: filteredLines,
      stats: { additions, deletions }
    };
  }, [oldContent, newContent]);

  const containerStyle = maxHeight ? { maxHeight } : {};

  return (
    <View className="bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
      {/* File Header */}
      {showFileName && fileName && (
        <View className="flex-row items-center justify-between px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-sm font-mono text-gray-700 flex-1" numberOfLines={1}>
            {fileName}
          </Text>
          <View className="flex-row items-center ml-2">
            {stats.additions > 0 && (
              <Text className="text-sm font-medium text-emerald-600 font-mono">
                +{stats.additions}
              </Text>
            )}
            {stats.deletions > 0 && (
              <Text className="text-sm font-medium text-red-600 font-mono ml-1">
                -{stats.deletions}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* Diff Content */}
      <ScrollView 
        style={containerStyle}
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled={true}
      >
        {diffLines.map((diffLine, index) => {
          if (diffLine.content === '...') {
            // Ellipsis separator
            return (
              <View key={index} className="flex-row items-center py-2">
                <View className="w-16 items-center justify-center border-r border-gray-300 bg-gray-100">
                  <Text className="text-sm font-mono text-gray-400">...</Text>
                </View>
                <View className="flex-1 px-3 bg-gray-50">
                  <Text className="text-sm font-mono text-gray-400">...</Text>
                </View>
              </View>
            );
          }

          const isContext = diffLine.type === 'context';
          const isRemoved = diffLine.type === 'removed';
          const isAdded = diffLine.type === 'added';

          return (
            <View key={index} className="flex-row">
              {/* Line Number Column */}
              <View className={`w-16 items-center justify-center border-r ${
                isRemoved 
                  ? 'bg-red-50 border-red-200'
                  : isAdded 
                    ? 'bg-green-50 border-green-200'
                    : 'bg-gray-50 border-gray-200'
              }`}>
                <Text className={`text-xs font-mono ${
                  isRemoved ? 'text-red-600' : 
                  isAdded ? 'text-green-600' : 
                  'text-gray-500'
                }`}>
                  {isRemoved && diffLine.oldLineNum ? diffLine.oldLineNum :
                   isAdded && diffLine.newLineNum ? diffLine.newLineNum :
                   isContext && diffLine.oldLineNum ? diffLine.oldLineNum : 
                   ''}
                </Text>
              </View>

              {/* Change Indicator Column */}
              <View className={`w-8 items-center justify-center border-r ${
                isRemoved 
                  ? 'bg-red-50 border-red-200'
                  : isAdded 
                    ? 'bg-green-50 border-green-200'
                    : 'bg-gray-50 border-gray-200'
              }`}>
                <Text className={`text-sm font-mono ${
                  isRemoved ? 'text-red-600' : 
                  isAdded ? 'text-green-600' : 
                  'text-gray-400'
                }`}>
                  {isRemoved ? '-' : isAdded ? '+' : ''}
                </Text>
              </View>

              {/* Content Column */}
              <View className={`flex-1 px-3 py-1 ${
                isRemoved ? 'bg-red-50' :
                isAdded ? 'bg-green-50' :
                'bg-gray-50'
              }`}>
                <Text className={`text-sm font-mono ${
                  isRemoved ? 'text-red-800' : 
                  isAdded ? 'text-green-800' : 
                  'text-gray-700'
                }`} style={{ lineHeight: 16 }}>
                  {diffLine.content || ' '}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
};

// Helper function to calculate just the stats without rendering
export const calculateDiffStats = (oldContent: string, newContent: string) => {
  const diffLines = calculateDiff(oldContent, newContent);
  const additions = diffLines.filter(line => line.type === 'added').length;
  const deletions = diffLines.filter(line => line.type === 'removed').length;
  
  return { additions, deletions };
}; 