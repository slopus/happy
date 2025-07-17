import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { type ToolCall } from '@/sync/storageTypes';

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
  "tool_use_id": "toolu_01FEDZv6vnQ3QKxxAgYT9Wos",
  "type": "tool_result",
  "content": "525:export const NestedTimers = component$<{"
}

Note: The ToolCall type does not include enough information yet. 
Need to pass the results through into this component.
*/

export type GrepToolCall = Omit<ToolCall, 'name'> & { name: 'Grep' };

export function GrepCompactView({ tool, sessionId, messageId }: { tool: GrepToolCall, sessionId: string, messageId: string }) {
  const router = useRouter();

  // TODO write a zod parser for this schema
  const query = tool.arguments?.query || tool.arguments?.pattern;
  const filePath = tool.arguments?.file_path || tool.arguments?.files || tool.arguments?.path;
  const directory = tool.arguments?.directory || tool.arguments?.dir;
  
  // Display search target (file, directory, or pattern)
  const searchTarget = filePath || directory || 'files';
  const displayTarget = typeof searchTarget === 'string' 
    ? searchTarget.split('/').pop() || searchTarget 
    : Array.isArray(searchTarget) 
      ? `${searchTarget.length} files` 
      : 'files';

  // TODO: Replace with actual result count when ToolCall type includes results
  const resultText = "No Results";

  return (
    <Pressable
      onPress={() => router.push(`/session/${sessionId}/message/${messageId}`)}
      className="border border-gray-300 rounded-lg bg-white overflow-hidden flex-row items-center justify-between px-3 py-3 active:scale-95 active:opacity-70"
    >
      <View className="flex-row items-center flex-1">
        <Ionicons name="search" size={14} color="#a1a1a1" />
        <Text className="text-xs text-neutral-400 font-bold px-1">Grep</Text>
        <Text
          className="text-xs flex-1 text-neutral-800"
          numberOfLines={1}
        >
          "{query || 'pattern'}" in {displayTarget}
        </Text>
      </View>

      <View className="flex-row items-center">
        <Text className="text-xs text-neutral-500 mr-2">
          {resultText}
        </Text>
        <Ionicons 
          name="chevron-forward" 
          size={12} 
          color="#6b7280"
        />
      </View>
    </Pressable>
  );
}

export function GrepCompactViewInner({ tool }: { tool: GrepToolCall }) {
  // Defensive: check for common grep arguments
  const query = tool.arguments?.query || tool.arguments?.pattern;
  const filePath = tool.arguments?.file_path || tool.arguments?.files || tool.arguments?.path;
  const directory = tool.arguments?.directory || tool.arguments?.dir;
  
  // Display search target (file, directory, or pattern)
  const searchTarget = filePath || directory || 'files';
  const displayTarget = typeof searchTarget === 'string' 
    ? searchTarget.split('/').pop() || searchTarget 
    : Array.isArray(searchTarget) 
      ? `${searchTarget.length} files` 
      : 'files';

  return (
    <View className="flex-row items-center py-0.5">
      <Ionicons name="search" size={14} color="#a1a1a1" />
      <Text className="text-xs text-neutral-400 font-bold px-1">Grep</Text>
      <Text
        className="text-xs flex-1 text-neutral-800"
        numberOfLines={1}
      >
        "{query || 'pattern'}" in {displayTarget}
      </Text>
    </View>
  );
}
