import React from 'react';
import { View, Text } from 'react-native';
import { type ToolCall } from '@/sync/storageTypes';

interface UnknownToolDetailedViewProps {
  tool: ToolCall;
}

export function UnknownToolDetailedView({ tool }: UnknownToolDetailedViewProps) {
  return (
    <View className="bg-gray-50 p-4 rounded-lg border border-gray-300 m-4">
      <Text className="text-base font-semibold mb-2 text-gray-800">
        {tool.name}
      </Text>
      <Text className="text-xs text-gray-500 font-mono mb-2">
        State: {tool.state}
      </Text>

      {(tool.result as any) && (
        <View>
          <Text className="text-xs text-gray-500 mb-1">
            Result:
          </Text>
          <View className="bg-white p-2 rounded border border-gray-300">
            <Text className="text-[10px] text-gray-500 font-mono">
              {typeof tool.result === "string"
                ? tool.result.length > 300
                  ? tool.result.slice(0, 300) + "..."
                  : tool.result
                : JSON.stringify(tool.result, null, 2).slice(0, 300) +
                  (JSON.stringify(tool.result).length > 300 ? "..." : "")}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
