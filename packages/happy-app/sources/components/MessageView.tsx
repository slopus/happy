import * as React from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';


export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  /**
   * Long-press handler for user-text bubbles. Wired by ChatList from
   * the active session screen and used by the fork-from-message flow.
   */
  onForkFromUserMessage?: (messageId: string, claudeUuid: string) => void;
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
  onForkFromUserMessage?: (messageId: string, claudeUuid: string) => void;
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
  sessionId: string;
  onForkFromUserMessage?: (messageId: string, claudeUuid: string) => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copiedResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  const claudeUuid = props.message.claudeUuid;
  const canFork = Boolean(claudeUuid) && Boolean(props.onForkFromUserMessage);
  const handleLongPress = React.useCallback(() => {
    if (claudeUuid && props.onForkFromUserMessage) {
      props.onForkFromUserMessage(props.message.id, claudeUuid);
    }
  }, [claudeUuid, props.message.id, props.onForkFromUserMessage]);
  const handleCopy = React.useCallback(async () => {
    await Clipboard.setStringAsync(props.message.displayText || props.message.text);
    setCopied(true);
    if (copiedResetTimerRef.current) {
      clearTimeout(copiedResetTimerRef.current);
    }
    copiedResetTimerRef.current = setTimeout(() => setCopied(false), 1200);
  }, [props.message.displayText, props.message.text]);

  React.useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

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

  const showActions = Platform.OS !== 'web' || isHovered;

  return (
    <View
      style={styles.userMessageContainer}
      // @ts-ignore - Web only events
      onMouseEnter={() => setIsHovered(true)}
      // @ts-ignore - Web only events
      onMouseLeave={() => setIsHovered(false)}
    >
      <Pressable
        onLongPress={canFork ? handleLongPress : undefined}
        delayLongPress={400}
        style={styles.userMessageBubble}
      >
        <MarkdownView markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      </Pressable>
      <View
        style={[styles.userMessageActions, showActions && styles.userMessageActionsVisible]}
        pointerEvents={showActions ? 'auto' : 'none'}
      >
        <MessageActionButton
          icon={copied ? 'checkmark' : 'copy-outline'}
          label={copied ? t('common.copied') : t('common.copy')}
          active={copied}
          onPress={handleCopy}
        />
      </View>
    </View>
  );
}

function MessageActionButton(props: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  const tooltipWidth = Math.min(Math.max(props.label.length * 14 + 18, 48), 160);

  return (
    <View
      style={styles.messageActionWrapper}
      // @ts-ignore - Web only events
      onMouseEnter={() => setIsHovered(true)}
      // @ts-ignore - Web only events
      onMouseLeave={() => setIsHovered(false)}
    >
      <Pressable
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={props.label}
        style={[styles.messageActionButton, props.active && styles.messageActionButtonActive]}
        {...(Platform.OS === 'web' ? ({ title: props.label } as any) : {})}
      >
        <Ionicons name={props.icon} size={15} color={props.active ? '#30D158' : '#8E8E93'} />
      </Pressable>
      {isHovered && (
        <View style={[styles.messageActionTooltip, { width: tooltipWidth }]}>
          <Text style={styles.messageActionTooltipText}>{props.label}</Text>
        </View>
      )}
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

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
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
    marginBottom: 4,
    maxWidth: '100%',
  },
  userMessageActions: {
    minHeight: 24,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 4,
    opacity: 0,
  },
  userMessageActionsVisible: {
    opacity: 1,
  },
  messageActionWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageActionButton: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    cursor: 'pointer',
  },
  messageActionButtonActive: {
    borderColor: '#30D158',
  },
  messageActionTooltip: {
    position: 'absolute',
    bottom: 30,
    maxWidth: 160,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surfaceHighest,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 10,
  },
  messageActionTooltipText: {
    color: theme.colors.text,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
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
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
