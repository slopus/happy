import * as React from "react";
import { View, Text, Pressable } from "react-native";
import { Image } from "expo-image";
import { ImageViewer } from "./ImageViewer";
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { useSetting } from "@/sync/storage";
import { Modal } from '@/modal';

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  isNewestMessage?: boolean;
}) => {
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          isNewestMessage={props.isNewestMessage}
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
  isNewestMessage?: boolean;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return <UserTextBlock message={props.message} sessionId={props.sessionId} isNewestMessage={props.isNewestMessage} />;

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} isNewestMessage={props.isNewestMessage} />;

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
  sessionId: string;
  isNewestMessage?: boolean;
}) {
  const [imageViewerVisible, setImageViewerVisible] = React.useState(false);
  const [imageViewerIndex, setImageViewerIndex] = React.useState(0);

  const handleOptionPress = React.useCallback(async (option: Option) => {
    if (!props.isNewestMessage) {
      const confirmed = await Modal.confirm(
        t('message.confirmOldOption'),
        t('message.confirmOldOptionMessage'),
        { confirmText: t('common.yes'), cancelText: t('common.cancel') }
      );
      if (!confirmed) return;
    }
    sync.sendMessage(props.sessionId, option.title);
  }, [props.sessionId, props.isNewestMessage]);

  const images = props.message.images ?? [];
  const imageViewingImages = images.map(img => ({ uri: img.url }));

  const handleImagePress = React.useCallback((index: number) => {
    setImageViewerIndex(index);
    setImageViewerVisible(true);
  }, []);

  return (
    <View style={styles.userMessageContainer}>
      <View style={styles.userMessageBubble}>
        {images.length > 0 && (
          <>
            <View style={styles.messageImages}>
              {images.map((img, index) => (
                <Pressable key={index} onPress={() => handleImagePress(index)}>
                  <Image
                    source={{ uri: img.url }}
                    style={{ width: 120, height: 120, borderRadius: 8 }}
                    contentFit="cover"
                    placeholder={img.thumbhash ? { thumbhash: img.thumbhash } : undefined}
                  />
                </Pressable>
              ))}
            </View>
            <ImageViewer
              images={imageViewingImages}
              initialIndex={imageViewerIndex}
              visible={imageViewerVisible}
              onClose={() => setImageViewerVisible(false)}
            />
          </>
        )}
        <MarkdownView markdown={props.message.displayText || props.message.text} onOptionPress={handleOptionPress} />
      </View>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  isNewestMessage?: boolean;
}) {
  const experiments = useSetting('experiments');
  const handleOptionPress = React.useCallback(async (option: Option) => {
    if (!props.isNewestMessage) {
      const confirmed = await Modal.confirm(
        t('message.confirmOldOption'),
        t('message.confirmOldOptionMessage'),
        { confirmText: t('common.yes'), cancelText: t('common.cancel') }
      );
      if (!confirmed) return;
    }
    sync.sendMessage(props.sessionId, option.title);
  }, [props.sessionId, props.isNewestMessage]);

  // Hide thinking messages unless experiments is enabled
  if (props.message.isThinking && !experiments) {
    return null;
  }

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} />
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
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
    <View style={styles.toolContainer}>
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

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    maxWidth: layout.maxWidth,
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '100%',
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    alignSelf: 'flex-start',
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  toolContainer: {
    marginHorizontal: 8,
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
  messageImages: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    marginBottom: 8,
    gap: 12,
  },
}));
