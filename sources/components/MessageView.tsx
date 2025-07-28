import * as React from "react";
import { View } from "react-native";
import { MarkdownView } from "./markdown/MarkdownView";
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { ToolView } from "./blocks/ToolView";

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) => {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
      <View
        style={{
          flexDirection: "column",
          flexGrow: 1,
          flexBasis: 0,
          maxWidth: layout.maxWidth,
        }}
      >
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
        />
      </View>
    </View>
  );
};

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return <UserTextBlock message={props.message} metadata={props.metadata} />;

    case 'agent-text':
      return <AgentTextBlock message={props.message} metadata={props.metadata} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
}) {
  return (
    <View
      style={{
        marginHorizontal: 16,
        backgroundColor: "#f0eee6",
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
        marginBottom: 12,
        alignSelf: "flex-end",
      }}
    >
      <MarkdownView markdown={props.message.text} />
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  metadata: Metadata | null;
}) {
  return (
    <View
      style={{
        marginHorizontal: 16,
        borderRadius: 16,
        alignSelf: "flex-start",
        flexGrow: 1,
        flexBasis: 0,
        flexDirection: "column",
      }}
    >
      <MarkdownView markdown={props.message.text} />
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={{ marginHorizontal: 8 }}>
      <ToolView tool={props.message.tool} metadata={props.metadata} messages={props.message.children} />
    </View>
  );
}

