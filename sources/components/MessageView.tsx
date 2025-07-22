import * as React from "react";
import { View } from "react-native";
import { MarkdownView } from "./markdown/MarkdownView";
import { CompactToolBlock as CompactToolBlock } from "./blocks/RenderToolCallV4";
import { ToolCallGroupBlock } from "./blocks/ToolCallGroupBlock";
import { Message, ToolCall, UserTextMessage, AgentTextMessage, ToolCallMessage, ToolCallGroupMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
// import { RenderToolV1 } from './blocks/RenderToolCallV1';

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
          maxWidth: 700,
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
      />;
    
    case 'tool-call-group':
      return <ToolCallGroupBlock 
        message={props.message} 
        metadata={props.metadata} 
        sessionId={props.sessionId}
        getMessageById={props.getMessageById || (() => null)}
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
    <View style={{ marginHorizontal: 8 }}>
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

