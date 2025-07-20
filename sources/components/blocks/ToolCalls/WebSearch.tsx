import React from 'react';
import { View, Pressable } from 'react-native';
import { MonoText as Text } from './MonoText';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { SingleLineToolSummaryBlock } from './SingleLinePressForDetail';

export type WebSearchToolCall = Omit<ToolCall, 'name'> & { name: 'WebSearch' };

const WebSearchToolResultSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string().optional(),
  })).optional(),
  total_results: z.number().optional(),
  error: z.string().optional(),
});

type ParsedWebSearchToolResult = z.infer<typeof WebSearchToolResultSchema>;

export function WebSearchCompactView({ tool, sessionId, messageId }: { tool: WebSearchToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <WebSearchCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function WebSearchCompactViewInner({ tool }: { tool: WebSearchToolCall }) {
  // Parse input arguments
  const query = tool.arguments?.query;
  const allowedDomains = tool.arguments?.allowed_domains;
  const blockedDomains = tool.arguments?.blocked_domains;
  
  // Dynamic label based on state
  const label = tool.state === 'running' ? 'Searching' : 'search';
  
  // Parse the tool.result using Zod schema
  let parsedResult: ParsedWebSearchToolResult | null = null;
  if (tool.result) {
    const parseResult = WebSearchToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
    }
  }

  // Display result info
  let resultText = "";
  if (tool.state === 'running') {
    resultText = "";
  } else if (parsedResult?.error) {
    resultText = "Error";
  } else if (parsedResult?.results) {
    const count = parsedResult.results.length;
    resultText = count > 0 ? `${count} result${count === 1 ? '' : 's'}` : "No results";
  } else if (parsedResult?.total_results !== undefined) {
    resultText = parsedResult.total_results > 0 ? `${parsedResult.total_results} results` : "No results";
  }

  // Format display query with domain filters
  let displayQuery = query || 'web search';
  if (allowedDomains && allowedDomains.length > 0) {
    displayQuery += ` (${allowedDomains.join(', ')})`;
  }

  return (
    <View className="flex-row items-center py-0.5">
      <Ionicons name="search" size={14} color="#a1a1a1" />
      <Text className="text-xs text-neutral-400 font-bold px-1">{label}</Text>
      <Text
        className="text-xs flex-1 text-neutral-800"
        numberOfLines={1}
      >
        "{displayQuery}"
      </Text>
      {resultText && (
        <Text className="text-xs text-neutral-500 ml-2">
          {resultText}
        </Text>
      )}
    </View>
  );
} 