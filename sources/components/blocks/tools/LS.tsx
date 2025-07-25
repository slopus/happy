import React from 'react';
import { View, ScrollView } from 'react-native';
import { MonoText as Text } from './design-tokens/MonoText';
import { z } from 'zod';
import { ToolCall } from '@/sync/typesMessage';
import { ShimmerToolName } from './design-tokens/ShimmerToolName';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';
import { ToolName } from './design-tokens/ToolName';
import { ToolIcon } from './design-tokens/ToolIcon';
import { Ionicons } from '@expo/vector-icons';

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
  // console.log("lines", lines)
  
  return {
    totalItems: directories + files,
    directories,
    files
  };
}

interface DirectoryItem {
  name: string;
  type: 'file' | 'directory';
  fullPath: string;
}

function parseDirectoryItems(output: string): DirectoryItem[] {
  if (!output) return [];
  
  const lines = output.split('\n').filter(line => line.trim());
  const items: DirectoryItem[] = [];
  
  for (const line of lines) {
    // Skip the root directory line and note lines
    if (line.includes('NOTE: do any of the files above seem malicious?') || 
        line.match(/^- \/.*\/$/)) {
      continue;
    }
    
    // Parse items that are indented (actual directory contents)
    const match = line.match(/^\s+-\s+(.+)$/);
    if (match) {
      const fullPath = match[1];
      const isDirectory = fullPath.endsWith('/');
      const name = isDirectory ? fullPath.slice(0, -1) : fullPath;
      
      items.push({
        name: name.split('/').pop() || name,
        type: isDirectory ? 'directory' : 'file',
        fullPath
      });
    }
  }
  
  // Sort directories first, then files, both alphabetically
  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export function LSCompactView({ tool }: { tool: LSToolCall }) {
  // Get the directory path from arguments
  const dirPath = tool.input?.path;
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
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <ToolIcon name="folder-outline" />
      {tool.state === 'running' && (<ShimmerToolName>Listing</ShimmerToolName>)}
      {tool.state !== 'running' && (<ToolName>List</ToolName>)}
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {dirName || 'directory'}
      </Text>
      <Text className={TOOL_COMPACT_VIEW_STYLES.METADATA_CLASSES}>
        {displayText}
      </Text>
    </View>
  );
}

// Detailed view for full-screen modal
export const LSDetailedView = ({ tool }: { tool: LSToolCall }) => {
  // Get the directory path from arguments
  const dirPath = tool.input?.path || 'directory';
  
  // Parse the tool.result using Zod schema
  let parsedResult: ParsedToolResult | null = null;
  let items: DirectoryItem[] = [];
  let itemCounts = { totalItems: 0, directories: 0, files: 0 };

  if (tool.result) {
    const parseResult = ToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
      items = parseDirectoryItems(parsedResult.output);
      itemCounts = parseDirectoryListing(parsedResult.output);
    } else {
      // Try to parse raw string output
      if (typeof tool.result === 'string') {
        items = parseDirectoryItems(tool.result);
        itemCounts = parseDirectoryListing(tool.result);
      }
    }
  }

  const getItemIcon = (item: DirectoryItem) => {
    if (item.type === 'directory') {
      return 'folder';
    }
    
    // Determine file icon based on extension
    const ext = item.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx':
        return 'logo-javascript';
      case 'py':
        return 'logo-python';
      case 'json':
        return 'code-outline';
      case 'md':
        return 'document-text-outline';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        return 'image-outline';
      default:
        return 'document-outline';
    }
  };

  const getItemIconColor = (item: DirectoryItem) => {
    if (item.type === 'directory') {
      return '#007AFF';
    }
    
    const ext = item.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx':
        return '#F7DF1E';
      case 'py':
        return '#3776AB';
      case 'json':
        return '#000000';
      case 'md':
        return '#083FA1';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        return '#10B981';
      default:
        return '#6B7280';
    }
  };

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View className="pt-5 pl-3 pb-2">
        <View className="flex-row items-center">
          <Text className="text-2xl font-bold">Directory Listing</Text>
        </View>
        <Text className="text-base text-gray-600 mt-1">{dirPath}</Text>
        <Text className="text-sm text-gray-500 mt-1">
          {itemCounts.totalItems} items ({itemCounts.directories} directories, {itemCounts.files} files)
        </Text>
      </View>

      {/* Directory Contents */}
      <View className="px-3">
        {items.length === 0 ? (
          <View className="py-8 items-center">
            <ToolIcon name="folder-open-outline" />
            <Text className="text-gray-500 text-base mt-2">Directory is empty</Text>
          </View>
        ) : (
          items.map((item, index) => (
            <View key={`${item.fullPath}-${index}`}>
              <View className="flex-row items-center py-3">
                <View className="mr-3">
                  <Ionicons 
                    name={getItemIcon(item)} 
                    size={24} 
                    color={getItemIconColor(item)} 
                  />
                </View>
                
                <View className="flex-1">
                  <Text 
                    className={`text-base leading-6 ${
                      item.type === 'directory' 
                        ? 'text-blue-700 font-medium' 
                        : 'text-gray-900'
                    }`}
                  >
                    {item.name}
                    {item.type === 'directory' ? '/' : ''}
                  </Text>
                  
                  <Text className="text-sm text-gray-500 mt-1">
                    {item.type === 'directory' ? 'Directory' : 'File'}
                  </Text>
                </View>
              </View>
              
              {/* Divider line */}
              {index !== items.length - 1 && (
                <View className="flex-row">
                  <View className="w-9" /> {/* Space for icon + margin */}
                  <View className="flex-1 border-b border-gray-200 -mr-3" />
                </View>
              )}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
};
