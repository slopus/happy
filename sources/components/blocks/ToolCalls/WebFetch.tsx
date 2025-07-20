import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';

export type WebFetchToolCall = Omit<ToolCall, 'name'> & { name: 'WebFetch' };

const WebFetchToolResultSchema = z.object({
  content: z.string().optional(),
  content_length: z.number().optional(),
  status_code: z.number().optional(),
  error: z.string().optional(),
  title: z.string().optional(),
}).optional();

type ParsedWebFetchToolResult = z.infer<typeof WebFetchToolResultSchema>;

export function WebFetchCompactView({ tool, sessionId, messageId }: { tool: WebFetchToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <WebFetchCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function WebFetchCompactViewInner({ tool }: { tool: WebFetchToolCall }) {
  // Parse input arguments
  const url = tool.arguments?.url;
  const prompt = tool.arguments?.prompt;
  
  // Dynamic label based on state
  const label = tool.state === 'running' ? 'Fetching' : 'fetch';
  
  // Parse the tool.result using Zod schema
  let parsedResult: ParsedWebFetchToolResult | null = null;
  if (tool.result) {
    const parseResult = WebFetchToolResultSchema.safeParse(tool.result);
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
  } else if (parsedResult?.status_code) {
    if (parsedResult.status_code >= 200 && parsedResult.status_code < 300) {
      resultText = "Success";
      if (parsedResult.content_length) {
        const kb = Math.round(parsedResult.content_length / 1024);
        resultText += ` (${kb}KB)`;
      }
    } else {
      resultText = `Error ${parsedResult.status_code}`;
    }
  } else if (parsedResult?.content) {
    resultText = "Content fetched";
  }

  // Format display URL - show domain or shortened URL
  let displayUrl = url || 'web page';
  if (url) {
    try {
      const urlObj = new URL(url);
      displayUrl = urlObj.hostname;
      if (urlObj.pathname !== '/') {
        displayUrl += urlObj.pathname.length > 20 
          ? urlObj.pathname.substring(0, 17) + '...'
          : urlObj.pathname;
      }
    } catch {
      // If URL parsing fails, truncate the original URL
      displayUrl = url.length > 30 ? url.substring(0, 27) + '...' : url;
    }
  }

  return (
    <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
      <Ionicons name="cloud-download" size={TOOL_COMPACT_VIEW_STYLES.ICON_SIZE} color={TOOL_COMPACT_VIEW_STYLES.ICON_COLOR} />
      <Text className={TOOL_COMPACT_VIEW_STYLES.TOOL_NAME_CLASSES}>{label}</Text>
      <Text
        className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES}
        numberOfLines={1}
      >
        {displayUrl}
      </Text>
      {prompt && (
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} text-neutral-600 mx-1`} numberOfLines={1}>
          • {prompt.length > 20 ? prompt.substring(0, 17) + '...' : prompt}
        </Text>
      )}
      {resultText && (
        <Text className={`${TOOL_COMPACT_VIEW_STYLES.METADATA_SIZE} text-neutral-500 ml-2`}>
          {resultText}
        </Text>
      )}
    </View>
  );
} 