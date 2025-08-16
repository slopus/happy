import * as React from "react";
import { View, Text } from "react-native";
import { MarkdownView } from "./markdown/MarkdownView";
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) => {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center' }} renderToHardwareTextureAndroid={true}>
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

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


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
    <View style={{ maxWidth: '100%', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'flex-end', paddingHorizontal: 16 }}>
      <View
        style={{
          backgroundColor: "#f0eee6",
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderRadius: 12,
          marginBottom: 12,
          maxWidth: '100%'
        }}
      >

        <MarkdownView markdown={props.message.text} />
        {__DEV__ && (
          <Text style={{ color: '#666666', fontSize: 12 }}>{JSON.stringify(props.message.meta)}</Text>
        )}
      </View>
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
        marginBottom: 12,
        borderRadius: 16,
        alignSelf: "flex-start",
      }}
    >
      <MarkdownView markdown={props.message.text} />
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={{
        marginHorizontal: 8,
        alignItems: 'center',
        paddingVertical: 8,
      }}>
        <Text style={{ color: '#666666', fontSize: 14 }}>Switched to {props.event.mode} mode</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={{
        marginVertical: 8,
        alignItems: 'center',
        paddingVertical: 8,
      }}>
        <Text style={{ color: '#666666', fontSize: 14 }}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return 'unknown time';
      }
    };

    return (
      <View style={{
        marginHorizontal: 8,
        alignItems: 'center',
        paddingVertical: 8,
      }}>
        <Text style={{ color: '#666666', fontSize: 14 }}>
          Usage limit reached until {formatTime(props.event.endsAt)}
        </Text>
      </View>
    );
  }
  return (
    <View style={{
      marginHorizontal: 8,
      alignItems: 'center',
      paddingVertical: 8,
    }}>
      <Text style={{ color: '#666666', fontSize: 14 }}>Unknown event</Text>
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
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

