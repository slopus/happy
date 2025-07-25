import React from "react";
import { View, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { MonoText as Text } from "./design-tokens/MonoText";
import { TOOL_COMPACT_VIEW_STYLES, TOOL_CONTAINER_STYLES } from "./constants";
import { ToolCall } from "@/sync/typesMessage";
import { ToolIcon } from "./design-tokens/ToolIcon";
import { ToolName } from "./design-tokens/ToolName";
import { ShimmerToolName } from "./design-tokens/ShimmerToolName";
import { SingleLineToolSummaryBlock } from "../SingleLineToolSummaryBlock";
import { TerminalBlock } from "../../atoms/TerminalBlock";

export type BashToolCall = Omit<ToolCall, "name"> & { name: "Bash" };

export function BashCompactView({
  tool,
  sessionId,
  messageId,
}: {
  tool: BashToolCall;
  sessionId: string;
  messageId: string;
}) {
  return (
    <SingleLineToolSummaryBlock sessionId={sessionId} messageId={messageId}>
      <BashCompactViewInner tool={tool} />
    </SingleLineToolSummaryBlock>
  );
}

export function BashCompactViewInner({ tool }: { tool: BashToolCall }) {
  const [seconds, setSeconds] = React.useState(0);
  const command = tool.input?.command;
  const description = tool.input?.explanation || tool.input?.description;

  // Timer effect for running state
  React.useEffect(() => {
    if (tool.state === "running") {
      const interval = setInterval(() => {
        setSeconds((prev) => prev + 1);
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [tool.state]);

  // Reset timer when tool starts running
  React.useEffect(() => {
    if (tool.state === "running") {
      setSeconds(0);
    }
  }, [tool.state]);

  let errorMessage = "";
  if (!command) {
    errorMessage = "No command specified";
  } else if (tool.state === "error") {
    errorMessage =
      typeof tool.result === "string" ? tool.result : "Error occurred";
  }

  return (
    <View className="flex-1">
      {/* Description on top */}
      {description && (
        <Text className="text-gray-700 text-sm mb-3 leading-5">
          {description}
        </Text>
      )}

      {/* Terminal block */}
      <TerminalBlock
        command={command || ""}
        output={tool.state === "running" ? `Running (${seconds}s)` : undefined}
        error={errorMessage}
        maxHeight={200}
      />
    </View>
  );
}

// Detailed view for full-screen modal
export const BashDetailedView = ({ tool }: { tool: ToolCall }) => {
  const command = tool.input?.command;
  const description = tool.input?.description;
  const explanation = tool.input?.explanation;

  if (!command) {
    return (
      <View className="flex-1 p-4 bg-white">
        <Text className="text-lg font-semibold text-gray-900">
          Terminal Command
        </Text>
        <Text className="text-red-600 text-sm italic">
          No command specified
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 p-4 bg-white"
      showsVerticalScrollIndicator={true}
    >
      {/* Header */}
      <View className="flex-row justify-between items-center mb-5 pb-3 border-b border-gray-200">
        <Text className="text-lg font-semibold text-gray-900">
          🖥️ Terminal Command
        </Text>
        <View className="px-2 py-1 bg-gray-100 rounded-xl">
          <Text
            className={`text-sm font-medium ${getStatusColorClass(tool.state)}`}
          >
            {getStatusDisplay(tool.state)}
          </Text>
        </View>
      </View>

      {/* Command */}
      <View className="mb-4">
        <Text className="text-sm font-semibold text-gray-700 mb-2">
          Command
        </Text>
        <View className="bg-gray-800 rounded-lg p-3">
          <Text className="text-green-400 font-mono text-sm">$ {command}</Text>
        </View>
      </View>

      {/* Description if available */}
      {description && (
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-700 mb-2">
            Description
          </Text>
          <Text className="text-sm text-gray-600 leading-5">{description}</Text>
        </View>
      )}

      {/* Explanation if available */}
      {explanation && (
        <View className="mb-4">
          <Text className="text-sm font-semibold text-gray-700 mb-2">
            Explanation
          </Text>
          <Text className="text-sm text-gray-700 leading-5">{explanation}</Text>
        </View>
      )}
    </ScrollView>
  );
};

// Helper functions
const getStatusDisplay = (state: string) => {
  switch (state) {
    case "running":
      return "⏳ Running";
    case "completed":
      return "✅ Completed";
    case "error":
      return "❌ Error";
    default:
      return state;
  }
};

const getStatusColorClass = (state: string) => {
  switch (state) {
    case "running":
      return "text-amber-500";
    case "completed":
      return "text-green-600";
    case "error":
      return "text-red-600";
    default:
      return "text-gray-500";
  }
};
