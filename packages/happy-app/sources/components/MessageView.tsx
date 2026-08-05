import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage, ModeSwitchMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';
import { getAutoFoldPromptBodyRenderState, getAutoFoldPromptInfo } from '@/utils/autoFoldPrompt';
import { ConversationActivityStrip } from './ConversationActivityStrip';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  /**
   * Long-press handler for user-text bubbles. Wired by ChatList from
   * the active session screen and used by the fork-from-message flow.
   */
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          onForkFromUserMessage={props.onForkFromUserMessage}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          onForkFromUserMessage={props.onForkFromUserMessage}
        />
      );

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock message={props.message} metadata={props.metadata} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
  onForkFromUserMessage?: (messageId: string, rewindPointId: string | undefined, messageText: string) => void;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  const rewindPointId = props.message.claudeUuid ?? props.message.codexItemId;
  const canFork = Boolean(props.onForkFromUserMessage)
    && (Boolean(rewindPointId) || props.metadata?.flavor === 'codex');
  const handleLongPress = React.useCallback(() => {
    if (props.onForkFromUserMessage) {
      props.onForkFromUserMessage(props.message.id, rewindPointId, props.message.text);
    }
  }, [props.message.id, props.message.text, props.onForkFromUserMessage, rewindPointId]);

  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
  const isClaudeFlavor = !props.metadata?.flavor || props.metadata.flavor === 'claude';
  if (isClaudeFlavor && isUserSlashCommandEcho(props.message.text, props.message.localId != null)) {
    return null;
  }

  const parsed = parseLocalCommandMessage(props.message.displayText || props.message.text);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'command-run') {
    return (
      <View style={styles.userMessageContainer}>
        <View style={styles.commandChip}>
          <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
        </View>
      </View>
    );
  }

  const autoFoldPrompt = getAutoFoldPromptInfo(parsed.text);
  if (autoFoldPrompt) {
    return (
      <View style={styles.userMessageContainer}>
        <View style={styles.userAutoFoldWrap}>
          <AutoFoldPromptBlock
            text={parsed.text}
            info={autoFoldPrompt}
            onOptionPress={handleOptionPress}
            sessionId={props.sessionId}
          />
        </View>
      </View>
    );
  }

  return (
    <View testID={`message-user-${props.message.id}`} style={styles.userMessageContainer}>
      <Pressable
        onLongPress={canFork ? handleLongPress : undefined}
        delayLongPress={400}
        style={styles.userMessageBubble}
      >
        <MarkdownView markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      </Pressable>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Hide thinking messages
  if (props.message.isThinking) {
    return null;
  }

  const autoFoldPrompt = getAutoFoldPromptInfo(props.message.text);
  if (autoFoldPrompt) {
    return (
      <View style={styles.agentMessageContainer}>
        <AutoFoldPromptBlock
          text={props.message.text}
          info={autoFoldPrompt}
          onOptionPress={handleOptionPress}
          sessionId={props.sessionId}
        />
      </View>
    );
  }

  return (
    <View testID={`message-agent-${props.message.id}`} style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
    </View>
  );
}

function AutoFoldPromptBlock(props: {
  text: string;
  info: NonNullable<ReturnType<typeof getAutoFoldPromptInfo>>;
  onOptionPress: (option: Option) => void;
  sessionId: string;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const toggleExpanded = React.useCallback(() => {
    setExpanded((value) => !value);
  }, []);
  const copyPrompt = React.useCallback(() => {
    void Clipboard.setStringAsync(props.text);
  }, [props.text]);
  const bodyRenderState = getAutoFoldPromptBodyRenderState({
    text: props.text,
    info: props.info,
    expanded,
  });

  return (
    <View style={styles.autoFoldCard}>
      <View style={styles.autoFoldHeader}>
        <Pressable style={styles.autoFoldHeaderMain} onPress={toggleExpanded}>
          <Ionicons name="document-text-outline" size={17} color={theme.colors.textSecondary} />
          <View style={styles.autoFoldTitleGroup}>
            <Text style={styles.autoFoldTitle} numberOfLines={1}>{t('message.foldedPromptTitle')}</Text>
            <Text style={styles.autoFoldSummary} numberOfLines={1}>
              {t('message.foldedPromptSummary', { lines: props.info.lineCount, chars: props.info.charCount })}
            </Text>
          </View>
        </Pressable>
        <Pressable style={styles.autoFoldAction} onPress={copyPrompt}>
          <Ionicons name="copy-outline" size={16} color={theme.colors.textSecondary} />
          <Text style={styles.autoFoldActionText}>{t('common.copy')}</Text>
        </Pressable>
        <Pressable style={styles.autoFoldAction} onPress={toggleExpanded}>
          <Text style={styles.autoFoldActionText}>{expanded ? t('message.hidePrompt') : t('message.showPrompt')}</Text>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textSecondary} />
        </Pressable>
      </View>
      <View style={styles.autoFoldBody}>
        {bodyRenderState.kind === 'markdown' ? (
          <MarkdownView
            markdown={bodyRenderState.text}
            onOptionPress={props.onOptionPress}
            sessionId={props.sessionId}
            variant={bodyRenderState.markdownVariant}
          />
        ) : (
          <Text style={styles.autoFoldBodyText}>{bodyRenderState.text}</Text>
        )}
      </View>
    </View>
  );
}

function AgentEventBlock(props: {
  message: ModeSwitchMessage;
  metadata: Metadata | null;
}) {
  const { event } = props.message;
  if (event.type === 'subagent-status') {
    return <ConversationActivityStrip messages={[props.message]} />;
  }
  if (event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: event.mode })}</Text>
      </View>
    );
  }
  if (event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{event.message}</Text>
      </View>
    );
  }
  if (event.type === 'limit-reached') {
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
          {t('message.usageLimitUntil', { time: formatTime(event.endsAt) })}
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
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
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
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 12,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  userAutoFoldWrap: {
    width: '100%',
    maxWidth: 520,
    marginBottom: 12,
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    maxWidth: '100%',
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
    maxWidth: '100%',
    overflow: 'hidden',
  },
  autoFoldCard: {
    backgroundColor: theme.colors.surfaceHigh,
    borderColor: theme.colors.divider,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  autoFoldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomColor: theme.colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  autoFoldHeaderMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  autoFoldTitleGroup: {
    flex: 1,
    minWidth: 0,
  },
  autoFoldTitle: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  autoFoldSummary: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  autoFoldAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
  },
  autoFoldActionText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  autoFoldBodyText: {
    color: theme.colors.textSecondary,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    lineHeight: 18,
  },
  autoFoldBody: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
