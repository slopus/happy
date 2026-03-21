import * as React from "react";
import { View, Text, Pressable } from "react-native";
import { Image } from "expo-image";
import { ImageViewer } from "./ImageViewer";
import { StyleSheet } from 'react-native-unistyles';
import { MarkdownView, OptionsLoadingState } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { Option } from './markdown/MarkdownView';
import { OptionItem as OptionItemData } from './markdown/parseMarkdown';
import { Modal } from "@/modal";
import { sync } from "@/sync/sync";
import { useSetting } from "@/sync/storage";

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  isNewestMessage?: boolean;
  onFillInput?: (text: string, allOptions?: string[]) => void;
  readOnly?: boolean;
  isSharedSession?: boolean;
  currentUserId?: string;
  showSenderName?: boolean;
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
          onFillInput={props.onFillInput}
          readOnly={props.readOnly}
          isSharedSession={props.isSharedSession}
          currentUserId={props.currentUserId}
          showSenderName={props.showSenderName}
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
  onFillInput?: (text: string, allOptions?: string[]) => void;
  readOnly?: boolean;
  isSharedSession?: boolean;
  currentUserId?: string;
  showSenderName?: boolean;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          sessionId={props.sessionId}
          sessionWorkingDirectory={props.metadata?.path ?? null}
          sessionHomeDirectory={props.metadata?.homeDir ?? null}
          isNewestMessage={props.isNewestMessage}
          onFillInput={props.onFillInput}
          readOnly={props.readOnly}
          isSharedSession={props.isSharedSession}
          currentUserId={props.currentUserId}
          showSenderName={props.showSenderName}
        />
      );

    case 'agent-text':
      return (
        <AgentTextBlock
          message={props.message}
          sessionId={props.sessionId}
          sessionWorkingDirectory={props.metadata?.path ?? null}
          sessionHomeDirectory={props.metadata?.homeDir ?? null}
          isNewestMessage={props.isNewestMessage}
          onFillInput={props.onFillInput}
          readOnly={props.readOnly}
        />
      );

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
  sessionWorkingDirectory?: string | null;
  sessionHomeDirectory?: string | null;
  isNewestMessage?: boolean;
  onFillInput?: (text: string, allOptions?: string[]) => void;
  readOnly?: boolean;
  isSharedSession?: boolean;
  currentUserId?: string;
  showSenderName?: boolean;
}) {
  const [imageViewerVisible, setImageViewerVisible] = React.useState(false);
  const [imageViewerIndex, setImageViewerIndex] = React.useState(0);
  const [optionsLoadingState, setOptionsLoadingState] = React.useState<OptionsLoadingState>({ loadingIndex: null });

  // Click to send
  const handleOptionPress = React.useCallback(async (option: Option, allOptions: OptionItemData[]) => {
    if (option.destructive) {
      // Destructive confirmation takes priority (skip old-option confirmation)
      const confirmed = await Modal.confirm(
        t('message.confirmDestructive'),
        t('message.confirmDestructiveMessage'),
        { destructive: true }
      );
      if (!confirmed) return;
    } else if (!props.isNewestMessage) {
      const confirmed = await Modal.confirm(
        t('message.confirmOldOption'),
        t('message.confirmOldOptionMessage')
      );
      if (!confirmed) return;
    }

    // Find the index of this option for loading state
    const index = allOptions.findIndex(o => o.title === option.title);
    setOptionsLoadingState({ loadingIndex: index });

    try {
      await sync.sendOrQueueMessage(props.sessionId, option.title);
    } finally {
      setOptionsLoadingState({ loadingIndex: null });
    }
  }, [props.sessionId, props.isNewestMessage]);

  // Long press to fill input (mobile only, handled in MarkdownView)
  const handleOptionLongPress = React.useCallback((option: Option, allOptions: OptionItemData[]) => {
    props.onFillInput?.(option.title, allOptions.map(o => o.title));
  }, [props.onFillInput]);

  const images = props.message.images ?? [];
  const imageViewingImages = images.map(img => ({ uri: img.url }));

  const handleImagePress = React.useCallback((index: number) => {
    setImageViewerIndex(index);
    setImageViewerVisible(true);
  }, []);

  const senderLabel = React.useMemo(() => {
    if (!props.isSharedSession || !props.showSenderName || !props.message.sentBy) return null;
    if (props.message.sentBy === props.currentUserId) return t('message.you');
    return props.message.sentByName || t('message.unknownSender');
  }, [props.isSharedSession, props.showSenderName, props.message.sentBy, props.currentUserId, props.message.sentByName]);

  return (
    <View style={styles.userMessageContainer}>
      {senderLabel && (
        <Text style={styles.senderLabel}>{senderLabel}</Text>
      )}
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
        <MarkdownView
          markdown={props.message.displayText || props.message.text}
          sessionId={props.sessionId}
          sessionWorkingDirectory={props.sessionWorkingDirectory}
          sessionHomeDirectory={props.sessionHomeDirectory}
          onOptionPress={props.readOnly ? undefined : handleOptionPress}
          onOptionLongPress={props.readOnly ? undefined : handleOptionLongPress}
          optionsLoadingState={props.readOnly ? undefined : optionsLoadingState}
          hideOptions={props.readOnly}
        />
        {props.message.deliveryError ? (
          <Text style={styles.deliveryErrorText}>{props.message.deliveryError}</Text>
        ) : null}
      </View>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  sessionWorkingDirectory?: string | null;
  sessionHomeDirectory?: string | null;
  isNewestMessage?: boolean;
  onFillInput?: (text: string, allOptions?: string[]) => void;
  readOnly?: boolean;
}) {
  const showThinkingMessages = useSetting('showThinkingMessages');
  const [optionsLoadingState, setOptionsLoadingState] = React.useState<OptionsLoadingState>({ loadingIndex: null });

  // Hide thinking messages if setting is disabled
  if (props.message.isThinking && !showThinkingMessages) {
    return null;
  }

  // Click to send
  const handleOptionPress = React.useCallback(async (option: Option, allOptions: OptionItemData[]) => {
    if (option.destructive) {
      // Destructive confirmation takes priority (skip old-option confirmation)
      const confirmed = await Modal.confirm(
        t('message.confirmDestructive'),
        t('message.confirmDestructiveMessage'),
        { destructive: true }
      );
      if (!confirmed) return;
    } else if (!props.isNewestMessage) {
      const confirmed = await Modal.confirm(
        t('message.confirmOldOption'),
        t('message.confirmOldOptionMessage')
      );
      if (!confirmed) return;
    }

    // Find the index of this option for loading state
    const index = allOptions.findIndex(o => o.title === option.title);
    setOptionsLoadingState({ loadingIndex: index });

    try {
      await sync.sendOrQueueMessage(props.sessionId, option.title);
    } finally {
      setOptionsLoadingState({ loadingIndex: null });
    }
  }, [props.sessionId, props.isNewestMessage]);

  // Long press to fill input (mobile only, handled in MarkdownView)
  const handleOptionLongPress = React.useCallback((option: Option, allOptions: OptionItemData[]) => {
    props.onFillInput?.(option.title, allOptions.map(o => o.title));
  }, [props.onFillInput]);

  const hasOptions = props.message.text.includes('<options>');

  return (
    <View style={[styles.agentMessageContainer, props.message.isThinking && { opacity: 0.3 }, hasOptions && styles.agentMessageContainerStretch]}>
      <MarkdownView
        markdown={props.message.text}
        sessionId={props.sessionId}
        sessionWorkingDirectory={props.sessionWorkingDirectory}
        sessionHomeDirectory={props.sessionHomeDirectory}
        onOptionPress={props.readOnly ? undefined : handleOptionPress}
        onOptionLongPress={props.readOnly ? undefined : handleOptionLongPress}
        optionsLoadingState={props.readOnly ? undefined : optionsLoadingState}
        hideOptions={props.readOnly}
      />
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
        localId={props.message.localId}
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
  senderLabel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginBottom: 2,
    paddingRight: 4,
  },
  deliveryErrorText: {
    color: theme.colors.textDestructive,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  agentMessageContainer: {
    paddingHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  agentMessageContainerStretch: {
    alignSelf: 'stretch',
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
