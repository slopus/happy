import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Animated } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { z } from 'zod';
import { SingleLineToolSummaryBlock } from '../SingleLineToolSummaryBlock';
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from './constants';
import { ToolIcon } from './design-tokens/ToolIcon';
import { ToolName } from './design-tokens/ToolName';
import { ShimmerToolName } from './design-tokens/ShimmerToolName';

export type TaskToolCall = Omit<ToolCall, 'name'> & { name: 'Task' };

// Zod schema for Task tool arguments based on sdk-tools.d.ts (AgentInput)
const TaskArgumentsSchema = z.object({
  description: z.string(),
  prompt: z.string()
});

type TaskArguments = z.infer<typeof TaskArgumentsSchema>;

// Parse arguments safely
const parseTaskArguments = (args: any): TaskArguments | null => {
  try {
    return TaskArgumentsSchema.parse(args);
  } catch {
    return null;
  }
};

export function TaskCompactView({ tool, sessionId, messageId }: { tool: TaskToolCall, sessionId: string, messageId: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [animationValue] = useState(new Animated.Value(0));

  React.useEffect(() => {
    Animated.timing(animationValue, {
      toValue: isExpanded ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [isExpanded]);

  const args = parseTaskArguments(tool.input);

  const getStateIcon = (state: string) => {
    switch (state) {
      case 'running': return 'sync-outline';
      case 'completed': return 'checkmark';
      case 'error': return 'close';
      default: return 'ellipse-outline';
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case 'running': return '#f59e0b';
      case 'completed': return '#10b981';
      case 'error': return '#ef4444';
      default: return '#6b7280';
    }
  };

  return (
    <View>
      <TouchableOpacity onPress={() => setIsExpanded(!isExpanded)}>
        <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
          <View className={TOOL_CONTAINER_STYLES.BASE_CONTAINER}>
            <ToolIcon name="flash-outline" />
            {tool.state === 'running' ? <ShimmerToolName>Running</ShimmerToolName> : <ToolName>Task</ToolName>}
            {args ? (
              <>
                <Text className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES} numberOfLines={1}>
                  {args.description}
                </Text>
                <View className="flex-row items-center gap-1">
                  <ToolIcon 
                    name={getStateIcon(tool.state) as any} 
                    state={tool.state === 'error' ? 'error' : undefined}
                  />
                  <ToolIcon 
                    name={isExpanded ? "chevron-up" : "chevron-down"} 
                  />
                </View>
              </>
            ) : (
              <Text className={TOOL_COMPACT_VIEW_STYLES.CONTENT_CLASSES} numberOfLines={1}>
                Invalid arguments
              </Text>
            )}
          </View>
        </SingleLineToolSummaryBlock>
      </TouchableOpacity>

      {/* Expandable drawer */}
      <Animated.View 
        style={{
          maxHeight: animationValue.interpolate({
            inputRange: [0, 1],
            outputRange: [0, 300]
          }),
          opacity: animationValue,
          overflow: 'hidden'
        }}
      >
        {isExpanded && args && (
          <View className="px-4 pb-3 bg-gray-50">
            <View className="border-l-2 border-gray-300 pl-4 ml-2">
              <Text className="text-sm text-gray-600 mb-2">Prompt:</Text>
              <Text className="text-sm text-gray-800 leading-5">{args.prompt}</Text>
              
              {/* Show child tools if any */}
              {tool.children && (tool.children as any[]).length > 0 && (
                <View className="mt-3">
                  <Text className="text-sm text-gray-600 mb-2">Sub-tasks ({(tool.children as any[]).length}):</Text>
                  {(tool.children as any[]).map((child, index) => (
                    <View key={index} className="flex-row items-center mb-1">
                      <ToolIcon 
                        name={getStateIcon(child.state) as any} 
                        state={child.state === 'error' ? 'error' : undefined}
                      />
                      <Text className="text-sm text-gray-700 ml-2">{child.name}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

// Detailed view for full-screen modal
export const TaskDetailedView = ({ tool }: { tool: TaskToolCall }) => {
    const args = parseTaskArguments(tool.input);

  if (!args) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">Task</Text>
        <Text className="text-red-600 text-sm italic">Invalid arguments</Text>
      </View>
    );
  }

  const getStateIcon = (state: string) => {
    switch (state) {
      case 'running': return 'sync-outline';
      case 'completed': return 'checkmark-circle';
      case 'error': return 'close-circle';
      default: return 'ellipse-outline';
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case 'running': return '#f59e0b';
      case 'completed': return '#10b981';
      case 'error': return '#ef4444';
      default: return '#6b7280';
    }
  };

  return (
    <ScrollView className="flex-1 bg-white" showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View className="pt-5 px-4 pb-2">
        <View className="flex-row items-center">
          <ToolIcon name="flash" />
          <Text className="text-2xl font-bold ml-2">Task</Text>
          <View className="ml-auto flex-row items-center">
            <ToolIcon 
              name={getStateIcon(tool.state) as any} 
              state={tool.state === 'error' ? 'error' : undefined} 
            />
            <Text className={`text-sm font-medium ml-1`} style={{ color: getStateColor(tool.state) }}>
              {tool.state.toUpperCase()}
            </Text>
          </View>
        </View>
      </View>

      {/* Task Details */}
      <View className="px-4">
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-600 mb-1">Description</Text>
          <View className="bg-gray-100 p-3 rounded-lg">
            <Text className="text-base text-gray-800">{args.description}</Text>
          </View>
        </View>

        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-600 mb-1">Prompt</Text>
          <View className="bg-gray-100 p-3 rounded-lg">
            <Text className="text-sm text-gray-800 leading-5">{args.prompt}</Text>
          </View>
        </View>

        {/* Child Tools */}
        {tool.children && tool.children.length > 0 && (
          <View className="mb-4">
            <Text className="text-sm font-semibold text-gray-600 mb-2">Sub-tasks ({tool.children.length})</Text>
            {tool.children.map((child, index) => (
              <View key={index} className="flex-row items-center bg-gray-50 p-3 rounded-lg mb-2">
                <Ionicons 
                  name={getStateIcon(child.state)} 
                  size={18} 
                  color={getStateColor(child.state)} 
                />
                <Text className="text-base text-gray-800 ml-3 flex-1">{child.name}</Text>
                <Text className="text-sm text-gray-500">{child.state}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Result */}
        {tool.result && (
          <View className="mb-4">
            <Text className="text-sm font-semibold text-gray-600 mb-1">Result</Text>
            <View className="bg-gray-100 p-3 rounded-lg">
              <Text className="text-sm text-gray-800">{JSON.stringify(tool.result, null, 2)}</Text>
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
};