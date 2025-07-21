import React from "react";
import { View, Text, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Message } from "@/sync/typesMessage";
import { type ToolCall } from "@/sync/typesMessage";
import { DetailedToolBlock } from "@/components/blocks/RenderToolCallV4";
import { useSession } from "@/sync/storage";
import { type Metadata } from "@/sync/storageTypes";

interface MessageDetailViewProps {
  message: Message;
  messageId: string;
  sessionId: string;
}

const EmptyMesssage = () => (
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

const MessageHeader = ({message, messageId}: {message: Message, messageId: string}) => (
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

export function MessageDetailView({
  message,
  messageId,
  sessionId,
}: MessageDetailViewProps) {
  const safeArea = useSafeAreaInsets();

  // Ok if we were for some reason to want to show a details view modal for text
  // messages, this is how we would do it:
  const renderTextMessage = (content: string) => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
    >
      <MessageHeader message={message} messageId={messageId} />
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
    
    const session = useSession(sessionId);

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
            <DetailedToolBlock tool={tool} metadata={session?.metadata || null} />
          </View>
        ))}
      </ScrollView>
    );
  };

  const renderUnknownMessage = (content: any) => (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: safeArea.bottom + 20 }}
    >
      <MessageHeader message={message} messageId={messageId} />
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



    // Determine message content type and render accordingly
    const renderMessageContent = () => {
      // Check message content type
      if (!message.content) {
        
        return (
          <View style={{ flex: 1, backgroundColor: "white" }}>
              <EmptyMesssage />
          </View>
        )
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
