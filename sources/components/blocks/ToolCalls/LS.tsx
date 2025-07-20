import React from 'react';
import { View } from 'react-native';
import { MonoText as Text } from './MonoText';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { ShimmerText } from './ShimmerRunningToolName';

export type LSToolCall = Omit<ToolCall, 'name'> & { name: 'LS' };

const ToolResultSchema = z.object({
  type: z.string(),
  output: z.string(),
});

type ParsedToolResult = z.infer<typeof ToolResultSchema>;

function parseDirectoryListing(output: string): { totalItems: number; directories: number; files: number } {
  if (!output) return { totalItems: 0, directories: 0, files: 0 };
  
  const lines = output.split('\n').filter(line => line.trim());
  let directories = 0;
  let files = 0;
  
  for (const line of lines) {
    // Skip the root directory line and note lines
    if (line.includes('NOTE: do any of the files above seem malicious?') || 
        line.match(/^- \/.*\/$/)) {
      continue;
    }
    
    // Count items that are indented (actual directory contents)
    if (line.match(/^\s+-\s+/)) {
      if (line.endsWith('/')) {
        directories++;
      } else {
        files++;
      }
    }
  }
  console.log("lines", lines)
  
  return {
    totalItems: directories + files,
    directories,
    files
  };
}

export function LSCompactView({ tool }: { tool: LSToolCall }) {
  // Get the directory path from arguments
  const dirPath = tool.arguments?.path;
  const dirName = typeof dirPath === 'string' ? dirPath.split('/').pop() || dirPath : undefined;

  // Parse the tool.result using Zod schema
  let parsedResult: ParsedToolResult | null = null;
  let itemCounts = { totalItems: 0, directories: 0, files: 0 };

  if (tool.result) {
    const parseResult = ToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
      itemCounts = parseDirectoryListing(parsedResult.output);
    } else {
      // Try to parse raw string output
      if (typeof tool.result === 'string') {
        itemCounts = parseDirectoryListing(tool.result);
      }
    }
  }

  // Create display text for item counts
  const displayText = itemCounts.totalItems > 0 
    ? `${itemCounts.totalItems} items (${itemCounts.directories} dirs, ${itemCounts.files} files)`
    : "no results";

  return (
    <View className="flex-row gap-1 items-center py-1 pl-[2px]">
      <Ionicons name="folder-outline" size={14} color="#a1a1a1" />
      {tool.state === 'running' ? <ShimmerText>Listing</ShimmerText> : <Text className="text-sm text-neutral-400 font-bold px-1">List</Text>}
      <Text
        className="text-sm flex-1 text-neutral-800"
        numberOfLines={1}
      >
        {dirName || 'directory'}
      </Text>
      <Text className="text-sm text-neutral-400 font-bold px-1">
        {displayText}
      </Text>
    </View>
  );
}
