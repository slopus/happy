import React from 'react';
import { View, Pressable } from 'react-native';
import { MonoText as Text } from './design-tokens/MonoText';
import { useRouter } from 'expo-router';
import { z } from 'zod';
import { ToolCall } from '@/sync/typesMessage';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';
import { ToolIcon } from './design-tokens/ToolIcon';
import { ToolName } from './design-tokens/ToolName';
import { ShimmerToolName } from './design-tokens/ShimmerToolName';

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
  const query = tool.input?.query;
  const allowedDomains = tool.input?.allowed_domains;
  const blockedDomains = tool.input?.blocked_domains;
  
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
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <ToolIcon name="search" />
      {tool.state === "running" && (<ShimmerToolName>Searching</ShimmerToolName>)}
      {tool.state !=="running" && (<ToolName>Search</ToolName>)}
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        "{displayQuery}"
      </Text>
      {resultText && (
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} text-neutral-500 ml-2`}>
          {resultText}
        </Text>
      )}
    </View>
  );
} 