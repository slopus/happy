import React from "react";
import { View, Text, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Message, type ToolCallMessage, type ToolCallGroupMessage } from "@/sync/typesMessage";
import { DetailedToolBlock } from "@/components/blocks/RenderToolCallV4";
import { useSession } from "@/sync/storage";

interface MessageDetailViewProps {
  message: Message;
  messageId: string;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}

// Component specifically for rendering tool call details
function ToolCallDetailView({
  message,
  sessionId,
}: {
  message: ToolCallMessage;
  sessionId: string;
}) {
  const safeArea = useSafeAreaInsets();
  const session = useSession(sessionId);
  const tools = message.tools;

  if (tools.length === 0) {
    return (<View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: 20,
      }}
    >
      <Text style={{ fontSize: 16, color: "#666", textAlign: "center" }}>
        I expected to find a at leat one tool call, but found zero.
      </Text>
    </View>
    )
  }

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
          <DetailedToolBlock tool={tool} metadata={session?.metadata || null} />
        </View>
      ))}
    </ScrollView>
  );
}

// Component for rendering tool call group details
function ToolCallGroupDetailView({
  message,
  sessionId,
  getMessageById,
}: {
  message: ToolCallGroupMessage;
  sessionId: string;
  getMessageById: (id: string) => Message | null;
}) {
  const safeArea = useSafeAreaInsets();
  const session = useSession(sessionId);

  // Get the actual tool call messages
  const toolCallMessages = message.messageIds
    .map(id => getMessageById(id))
    .filter((msg): msg is ToolCallMessage => msg !== null && msg.kind === 'tool-call');

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
    >
      <View
        style={{
          backgroundColor: "#f8f9fa",
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: "#e0e0e0",
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: '600', color: '#333', marginBottom: 4 }}>
          Tool Call Group
        </Text>
        <Text style={{ fontSize: 12, color: "#666" }}>
          {toolCallMessages.length} tool call{toolCallMessages.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {toolCallMessages.map((toolMsg, index) => (
        <View key={toolMsg.id} style={{ margin: 16 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 8, color: '#666' }}>
            Tool Call {index + 1}
          </Text>
          {toolMsg.tools.map((tool, toolIndex) => (
            <View key={toolIndex} style={{ marginBottom: toolIndex < toolMsg.tools.length - 1 ? 20 : 0 }}>
              <DetailedToolBlock tool={tool} metadata={session?.metadata || null} />
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

// Debug/fallback component for showing raw message details
function DebugMessageDetailView({
  message,
  messageId,
}: {
  message: Exclude<Message, ToolCallMessage | ToolCallGroupMessage>;
  messageId: string;
}) {
  const safeArea = useSafeAreaInsets();

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
    >
      {/* Debug header showing message metadata */}
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
            Kind: {message.kind}
          </Text>
        </View>
      </View>

      {/* Debug info box */}
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
          Debug Information
        </Text>
        <Text style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
          Local ID: {message.id}
        </Text>
        <Text style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
          Kind: {message.kind}
        </Text>
        <Text style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
          Created At: {new Date(message.createdAt).toLocaleString()}
        </Text>
      </View>

      {/* Message content based on kind */}
      <View style={{ margin: 16 }}>
        <Text
          style={{
            fontSize: 14,
            fontWeight: "600",
            marginBottom: 8,
            color: "#666",
          }}
        >
          Message Content
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
          {(message.kind === 'user-text' || message.kind === 'agent-text') && (
            <Text style={{ fontSize: 14, lineHeight: 20, color: "#333" }}>
              {message.text}
            </Text>
          )}
          {/* Fallback for unknown message types */}
          {!['user-text', 'agent-text'].includes(message.kind) && (
            <Text style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
              {JSON.stringify(message, null, 2)}
            </Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

export function MessageDetailView({
  message,
  messageId,
  sessionId,
  getMessageById,
}: MessageDetailViewProps) {
  // For tool call messages, use the specialized tool detail view
  if (message.kind === 'tool-call') {
    return (
      <View style={{ flex: 1, backgroundColor: "white" }}>
        <ToolCallDetailView message={message} sessionId={sessionId} />
      </View>
    );
  }

  // For tool call group messages, use the specialized tool group detail view
  if (message.kind === 'tool-call-group') {
    return (
      <View style={{ flex: 1, backgroundColor: "white" }}>
        <ToolCallGroupDetailView
          message={message}
          sessionId={sessionId}
          getMessageById={getMessageById || (() => null)}
        />
      </View>
    );
  }

  // For all other messages (text messages or unknown), use the debug view
  return (
    <View style={{ flex: 1, backgroundColor: "white" }}>
      <DebugMessageDetailView message={message} messageId={messageId} />
    </View>
  );
}

// Helper function to determine the title based on message content
export function getMessageDetailTitle(message: Message): string {
  switch (message.kind) {
    case 'tool-call':
      if (message.tools && message.tools.length > 0) {
        // If there's only one tool, use that tool's name
        if (message.tools.length === 1) {
          const toolName = message.tools[0].name;
          return `${toolName} Details`;
        }
        // If multiple tools, use generic "Tool Details"
        return "Tool Details";
      }
      return "Tool Details";

    case 'tool-call-group':
      return `Tool Group (${message.messageIds.length} tools)`;

    case 'user-text':
      return "User Message";

    case 'agent-text':
      return "Assistant Message";

    default:
      return "Message Details";
  }
}