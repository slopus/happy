import * as React from "react";
import { View, Text } from "react-native";
import { MarkdownView } from "./markdown/MarkdownView";
import { CompactToolBlock as CompactToolBlock } from "./blocks/RenderToolCallV4";
import { Message, ToolCall, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
// import { RenderToolV1 } from './blocks/RenderToolCallV1';

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
}) => {
  console.log(props.message);

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
      <View
        style={{
          flexDirection: "column",
          flexGrow: 1,
          flexBasis: 0,
          maxWidth: 700,
        }}
      >
        <RenderBlock 
          message={props.message} 
          metadata={props.metadata} 
          sessionId={props.sessionId} 
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
        paddingRight: 16,
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
}) {
  return (
    <View>
      {props.message.tools.map((tool: ToolCall, index: number) => (
        <CompactToolBlock
          key={index}
          tool={tool}
          sessionId={props.sessionId}
          messageId={props.message.id}
          metadata={props.metadata}
        />
      ))}
    </View>
  );
}

function UnknownMessageView() {
  return (
    <View>
      <Text>Unknown message, please update the app to the latest version.</Text>
    </View>
  );
}