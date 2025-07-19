import React from "react";
import { View, Text, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Message, type ToolCall } from "@/sync/storageTypes";
import {
  EditDetailedView,
  type EditToolCall,
} from "@/components/blocks/ToolCalls/Edit";
import {
  WriteDetailedView,
  type WriteToolCall,
} from "@/components/blocks/ToolCalls/Write";
import {
  BashDetailedView,
  type BashToolCall,
} from "@/components/blocks/ToolCalls/Bash";
import {
  TodoWriteDetailedView,
  TodoWriteToolCall,
} from "./blocks/ToolCalls/TodoWrite";

interface MessageDetailViewProps {
  message: Message;
  messageId: string;
}

export function MessageDetailView({
  message,
  messageId,
}: MessageDetailViewProps) {
  const safeArea = useSafeAreaInsets();

  // Determine message content type and render accordingly
  const renderMessageContent = () => {
    // Check message content type
    if (!message.content) {
      return renderEmptyMessage();
    }

    if (typeof message.content === "string") {
      return renderTextMessage(message.content);
    }

    if (typeof message.content === "object" && "type" in message.content) {
      switch (message.content.type) {
        case "tool":
          return renderToolMessage(message.content);

        default:
          return renderUnknownMessage(message.content);
      }
    }

    return renderUnknownMessage(message.content);
  };

  const renderEmptyMessage = () => (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: 20,
      }}
    >
      <Text style={{ fontSize: 16, color: "#666", textAlign: "center" }}>
        This message has no content
      </Text>
    </View>
  );

  const renderTextMessage = (content: string) => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
    >
      {renderMessageHeader()}
      <View style={{ margin: 16 }}>
        <Text style={{ fontSize: 16, lineHeight: 24, color: "#333" }}>
          {content}
        </Text>
      </View>
    </ScrollView>
  );

  const renderToolMessage = (content: any) => {
    if (!content.tools || !Array.isArray(content.tools)) {
      return renderUnknownMessage(content);
    }

    const tools = content.tools as ToolCall[];

    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
      >
        {tools.map((tool, index) => (
          <View
            key={index}
            style={{ marginBottom: index < tools.length - 1 ? 20 : 0 }}
          >
            {renderToolDetailedView(tool)}
          </View>
        ))}
      </ScrollView>
    );
  };

  const renderToolDetailedView = (tool: ToolCall) => {
    switch (tool.name) {
      case "Edit":
        return <EditDetailedView tool={tool as EditToolCall} />;

      case "Write":
        return <WriteDetailedView tool={tool as WriteToolCall} />;

      case "Bash":
        return <BashDetailedView tool={tool as BashToolCall} />;

      case "TodoWrite":
        return <TodoWriteDetailedView tool={tool as TodoWriteToolCall} />;

      default:
        // Fallback for tools without detailed views
        return renderToolFallback(tool);
    }
  };

  const renderToolFallback = (tool: ToolCall) => (
    <View
      style={{
        backgroundColor: "#f8f9fa",
        padding: 16,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#e0e0e0",
        margin: 16,
      }}
    >
      <Text
        style={{
          fontSize: 16,
          fontWeight: "600",
          marginBottom: 8,
          color: "#333",
        }}
      >
        {tool.name}
      </Text>
      <Text
        style={{
          fontSize: 12,
          color: "#666",
          fontFamily: "monospace",
          marginBottom: 8,
        }}
      >
        State: {tool.state}
      </Text>

      {(tool.result as any) && (
        <View>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
            Result:
          </Text>
          <View
            style={{
              backgroundColor: "#fff",
              padding: 8,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: "#ddd",
            }}
          >
            <Text
              style={{ fontSize: 10, color: "#666", fontFamily: "monospace" }}
            >
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

  const renderUnknownMessage = (content: any) => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
    >
      {renderMessageHeader()}
      <View style={{ margin: 16 }}>
        <Text
          style={{
            fontSize: 14,
            fontWeight: "600",
            marginBottom: 8,
            color: "#666",
          }}
        >
          Unknown Message Content
        </Text>
        <View
          style={{
            backgroundColor: "#f8f9fa",
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#e0e0e0",
          }}
        >
          <Text
            style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}
          >
            {JSON.stringify(content, null, 2)}
          </Text>
        </View>
      </View>
    </ScrollView>
  );

  const renderMessageHeader = () => (
    <>
      <View
        style={{
          backgroundColor: "#f8f9fa",
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: "#e0e0e0",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 12, color: "#666" }}>
            Message ID: {messageId}
          </Text>
          <Text style={{ fontSize: 12, color: "#666" }}>
            {message.role === "user" ? "User" : "Assistant"}
          </Text>
        </View>
      </View>

      <View
        style={{
          margin: 16,
          padding: 12,
          backgroundColor: "#f8f9fa",
          borderRadius: 8,
          borderWidth: 1,
          borderColor: "#e0e0e0",
        }}
      >
        <Text
          style={{
            fontSize: 14,
            fontWeight: "600",
            marginBottom: 8,
            color: "#666",
          }}
        >
          Message Details
        </Text>
        <Text style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
          Local ID: {message.id}
        </Text>
        {message.role && (
          <Text
            style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}
          >
            Role: {message.role}
          </Text>
        )}
        {message.content &&
          typeof message.content === "object" &&
          "type" in message.content && (
            <Text
              style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}
            >
              Content Type: {String((message.content as any).type)}
            </Text>
          )}
      </View>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: "white" }}>
      {renderMessageContent()}
    </View>
  );
}

// Helper function to determine the title based on message content
export function getMessageDetailTitle(message: Message): string {
  if (!message.content) {
    return "Message Details";
  }

  if (typeof message.content === "object" && "type" in message.content) {
    switch (message.content.type) {
      case "tool":
        if (message.content.tools && message.content.tools.length > 0) {
          // If there's only one tool, use that tool's name
          if (message.content.tools.length === 1) {
            const toolName = message.content.tools[0].name;
            return `${toolName} Details`;
          }
          // If multiple tools, use generic "Tool Details"
          return "Tool Details";
        }
        return "Tool Details";

      default:
        return "Message Details";
    }
  }

  return "Message Details";
}
