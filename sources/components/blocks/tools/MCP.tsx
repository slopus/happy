import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { ShimmerToolName } from './design-tokens/ShimmerToolName';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ToolIcon } from './design-tokens/ToolIcon';

// Type for MCP tool calls with pattern mcp__{server}__{operation}
export type MCPToolCall = Omit<ToolCall, 'name'> & {
  name: `mcp__${string}__${string}`
};

// Helper function to parse MCP tool name
function parseMCPToolName(toolName: string): { server: string; operation: string } | null {
  const match = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return null;

  return {
    server: match[1],
    operation: match[2]
  };
}

export function MCPCompactView({ tool, sessionId, messageId }: {
  tool: MCPToolCall;
  sessionId: string;
  messageId: string;
}) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <MCPCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function MCPCompactViewInner({ tool }: { tool: MCPToolCall }) {
  const parsed = parseMCPToolName(tool.name);

  if (!parsed) {
    return (
      <View className="flex-row items-center py-1 gap-1">
        <ToolIcon name="cube-outline" />
        <Text className="text-md text-neutral-400 font-bold px-1">MCP</Text>
        <Text className="text-md flex-1 text-neutral-800" numberOfLines={1}>
          Invalid tool name format
        </Text>
      </View>
    );
  }

  const { server, operation } = parsed;

  // Handle running state
  if (tool.state === 'running') {
    return (
      <View className="flex-row items-center py-1 gap-1">
        <ToolIcon name="cube-outline" />
        <ShimmerToolName>Calling MCP</ShimmerToolName>
        <View className="bg-gray-100 px-1.5 py-0.5 rounded-md border border-gray-200">
          <Text className="text-md text-neutral-600 font-medium" numberOfLines={1}>
            {server}
          </Text>
        </View>
        <Text className="text-md text-neutral-800" numberOfLines={1}>
          {operation}
        </Text>
      </View>
    );
  }

  // Handle error state
  if (tool.state === 'error') {
    return (
      <View className="flex-row items-center py-1 gap-1">
        <ToolIcon name="cube" state="error" />
        <Text className="text-md text-red-500 font-bold px-1 rounded-md">MCP</Text>
        <Text className="text-md text-neutral-600" numberOfLines={1}>
          {server}
        </Text>
        <Text className="text-md text-neutral-800" numberOfLines={1}>
          {operation}
        </Text>
        <Text className="text-md text-red-500">Error</Text>
      </View>
    );
  }

  // Handle completed state
  return (
    <View className="flex-row items-center py-1 gap-1">
      <ToolIcon name="cube" />
      <Text className="text-md text-neutral-400 font-bold px-1">MCP</Text>
      <View className="bg-gray-100 px-2 py-1">
        <Text className="text-md text-neutral-600" numberOfLines={1}>
          {server}
        </Text>
      </View>
      <Text className="text-md text-neutral-800" numberOfLines={1}>
        {operation}
      </Text>
    </View>
  );
}

// Detailed view for full-screen modal
export const MCPDetailedView = ({ tool }: { tool: MCPToolCall }) => {
  const parsed = parseMCPToolName(tool.name);

  if (!parsed) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">MCP Tool Call</Text>
        <Text className="text-red-600 text-md italic">Invalid tool name format: {tool.name}</Text>
      </View>
    );
  }

  const { server, operation } = parsed;

  // Format arguments and result as JSON strings
  const argumentsJson = tool.input ? JSON.stringify(tool.input, null, 2) : 'null';
  const resultJson = tool.result ? JSON.stringify(tool.result, null, 2) : 'null';

  // Create markdown code blocks for JSON display
  const argumentsMarkdown = `\`\`\`json\n${argumentsJson}\n\`\`\``;
  const resultMarkdown = `\`\`\`json\n${resultJson}\n\`\`\``;

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={true}>
      <>
        {/* Header */}
        <View className="p-4">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-lg font-semibold text-gray-900">🔌 MCP Tool Call</Text>
          <View className="px-2 py-1 bg-gray-100 rounded-xl">
            <Text className={`text-md font-medium ${getStatusColorClass(tool.state)}`}>
              {getStatusDisplay(tool.state)}
            </Text>
          </View>
        </View>

        {/* Tool Info */}
        <View className="mb-4 bg-blue-50 rounded-lg p-3 border border-blue-200">
          <Text className="text-md font-medium text-blue-800 mb-1">Server</Text>
          <Text className="text-md font-mono text-blue-700 mb-2">{server}</Text>

          <Text className="text-md font-medium text-blue-800 mb-1">Operation</Text>
          <Text className="text-md font-mono text-blue-700">{operation}</Text>
        </View>
      </View>

      {/* Arguments Section */}
      <View className="bg-gray-50 border-y border-gray-200">
        <View className="px-4 py-3 bg-gray-100 border-b border-gray-200">
          <Text className="text-md font-medium text-gray-700">Input Arguments</Text>
        </View>
        <View className="bg-white p-4">
          <MarkdownView markdown={argumentsMarkdown} />
        </View>
      </View>

      {/* Result Section */}
      {tool.result && (
        <View className="bg-gray-50 border-b border-gray-200">
          <View className="px-4 py-3 bg-gray-100 border-b border-gray-200">
            <Text className="text-md font-medium text-gray-700">Result</Text>
          </View>
          <View className="bg-white p-4">
            <MarkdownView markdown={resultMarkdown} />
          </View>
        </View>
      )}

      {/* Status Information */}
      <View className="p-4">
        <Text className="text-md text-gray-600">
          {getStatusDescription(tool.state)}
        </Text>
      </View>
      </>
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case 'running': return '⏳ Running';
    case 'completed': return '✅ Completed';
    case 'error': return '❌ Error';
    default: return state;
  }
};

const getStatusDescription = (state: string) => {
  switch (state) {
    case 'running': return 'MCP tool call is currently executing...';
    case 'completed': return 'MCP tool call completed successfully';
    case 'error': return 'MCP tool call failed to execute';
    default: return `Status: ${state}`;
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