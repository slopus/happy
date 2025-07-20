import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { z } from 'zod';
import { type ToolCall } from '@/sync/storageTypes';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';

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
      "mode": "content",
      "numFiles": 0,
      "filenames": [],
      "content": "",
      "numLines": 0
    }
Note: The ToolCall type does not include enough information yet. 
Need to pass the results through into this component.
*/

export type GrepToolCall = Omit<ToolCall, 'name'> & { name: 'Grep' };

const GrepToolResultSchema = z.object({
  mode: z.string(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  content: z.string(),
  numLines: z.number(),
});

type ParsedGrepToolResult = z.infer<typeof GrepToolResultSchema>;

export function GrepCompactView({ tool, sessionId, messageId }: { tool: GrepToolCall, sessionId: string, messageId: string }) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <GrepCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function GrepCompactViewInner({ tool }: { tool: GrepToolCall }) {
  // Parse input arguments
  const query = tool.arguments?.query || tool.arguments?.pattern;
  const filePath = tool.arguments?.file_path || tool.arguments?.files || tool.arguments?.path;
  const directory = tool.arguments?.directory || tool.arguments?.dir;
  
  // Determine if this is a single file search or multi-file search
  const isSingleFileSearch = typeof filePath === 'string' && !directory;
  
  // Display search target (file, directory, or pattern)
  const searchTarget = filePath || directory || 'files';
  const displayTarget = typeof searchTarget === 'string' 
    ? searchTarget.split('/').pop() || searchTarget 
    : Array.isArray(searchTarget) 
      ? `${searchTarget.length} files` 
      : 'files';

  // Parse the tool.result using Zod schema
  let parsedResult: ParsedGrepToolResult | null = null;
  let parseError: string | null = null;

  if (tool.result) {
    const parseResult = GrepToolResultSchema.safeParse(tool.result);
    if (parseResult.success) {
      parsedResult = parseResult.data;
    } else {
      // parseError = `Parse error: ${parseResult.error.message}`;
    }
  }

  // Display appropriate result text based on search type and parsed data
  let resultText = "No Results";
  
  if (parsedResult) {
    if (isSingleFileSearch) {
      // Single file search - show matching lines
      if (parsedResult.numLines > 0) {
        resultText = `Found ${parsedResult.numLines} line${parsedResult.numLines === 1 ? '' : 's'}`;
      } else {
        resultText = "No matches";
      }
    } else {
      // Multi-file search - show matched files
      if (parsedResult.numFiles > 0) {
        resultText = `Matched ${parsedResult.numFiles} file${parsedResult.numFiles === 1 ? '' : 's'}`;
      } else {
        resultText = "No files matched";
      }
    }
  }

  return (
    <View className="flex-row items-center py-1">
      <Ionicons name="search" size={14} color="#a1a1a1" />
      <Text className="text-xs text-neutral-400 font-bold px-1">Grep</Text>
      <Text
        className="text-xs flex-1 text-neutral-800"
        numberOfLines={1}
      >
        "{query || 'pattern'}" in {displayTarget}
      </Text>
      <Text className="text-xs text-neutral-500 mr-2">
        {resultText}
      </Text>
    </View>
  );
}
